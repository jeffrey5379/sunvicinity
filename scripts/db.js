import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import path from "path";
import { raDecDistanceToXyz, getSpectralClass } from "../utils.js";

function normalizeMainId(mainId) {
  return mainId ? mainId.replace(/\s+/g, " ").trim() : mainId;
}

export const RARE_SPECTRAL_CLASSES = ["O", "B", "A", "C", "L", "T", "Y"];
export const F_RTREE_SPECTRAL_CLASS = "F";
const RARE_CLASS_CODE = Object.fromEntries(RARE_SPECTRAL_CLASSES.map((c, i) => [c, i]));
// SQL `CASE spectral_class WHEN 'O' THEN 0 ... END`, for the triggers.
const RARE_CLASS_CASE_SQL = `CASE %s ${RARE_SPECTRAL_CLASSES.map(
  (c, i) => `WHEN '${c}' THEN ${i}`,
).join(" ")} END`;
const RARE_CLASS_IN_SQL = RARE_SPECTRAL_CLASSES.map((c) => `'${c}'`).join(", ");

const DEFAULT_DB_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "stardata.db",
);

export function openDb(dbPath = DEFAULT_DB_PATH) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.function("classifySpType", (spType) => getSpectralClass(spType));
  db.exec(`
    CREATE TABLE IF NOT EXISTS stars (
      main_id          TEXT PRIMARY KEY,
      distance_ly      REAL,
      otype            TEXT,
      sp_type          TEXT,
      diameter_solar   REAL,
      x_ly             REAL,
      y_ly             REAL,
      z_ly             REAL,
      spectral_class   TEXT
    );
    -- ra/dec/parallax were dropped from the built db (parallax only ever
    -- fed distance_ly at sync time; ra/dec only fed x_ly/y_ly/z_ly). Sync
    -- code still passes them as row fields — SQLite ignores the extra
    -- bind params — but they are no longer stored.
  `);
  ensureSpectralClassColumn(db);
  // distance_ly and idx_stars_distance exist only during a build (the
  // shell-range scan in getShellRows) — resync-all's
  // dropDistanceLy() removes both at the end. Only (re)create the index
  // while the column is still there, so openDb() on a finished, trimmed db
  // doesn't fail trying to index a column that's gone.
  if (db.prepare(`PRAGMA table_info(stars)`).all().some((c) => c.name === "distance_ly")) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_stars_distance ON stars(distance_ly)`);
  }
  ensureRtree(db);
  backfillRtree(db);
  backfillMissingSpectralClass(db);
  ensureRareRtree(db);
  backfillRareRtree(db);
  ensureFRtree(db);
  backfillFRtree(db);
  return db;
}

export function openDbReadOnly(dbPath = DEFAULT_DB_PATH) {
  const db = new Database(dbPath, { readonly: true });
  db.pragma("query_only = true");
  return db;
}

// distance_ly is only read while the db is being built — shell partitioning
// in getShellRows and the mas->km diameter conversion in sync-simbad.js. A
// finished, serve-only db never touches it (positions come
// from x_ly/y_ly/z_ly; it isn't in EXPORT_COLUMNS), so resync-all drops it
// and its index at the very end and compacts the file. Idempotent — a no-op
// (no VACUUM) once the column is already gone.
export function dropDistanceLy(db) {
  db.exec(`DROP INDEX IF EXISTS idx_stars_distance`);
  const hasCol = db
    .prepare(`PRAGMA table_info(stars)`)
    .all()
    .some((c) => c.name === "distance_ly");
  if (!hasCol) return false;
  db.exec(`ALTER TABLE stars DROP COLUMN distance_ly`);
  db.exec(`VACUUM`);
  return true;
}

function ensureSpectralClassColumn(db) {
  const columns = db.prepare(`PRAGMA table_info(stars)`).all().map((c) => c.name);
  if (!columns.includes("spectral_class")) db.exec(`ALTER TABLE stars ADD COLUMN spectral_class TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_stars_missing_spectral_class ON stars(main_id) WHERE spectral_class IS NULL`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_stars_spectral_class ON stars(spectral_class)`);
}

function ensureRtree(db) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS stars_rtree USING rtree(
    id, minX, maxX, minY, maxY, minZ, maxZ
  )`);

  db.exec(`DROP TRIGGER IF EXISTS stars_rtree_ai`);

  db.exec(`
    CREATE TRIGGER stars_rtree_ai
    AFTER INSERT ON stars
    WHEN NEW.x_ly IS NOT NULL
    BEGIN
      DELETE FROM stars_rtree WHERE id = NEW.rowid;
      INSERT INTO stars_rtree (id, minX, maxX, minY, maxY, minZ, maxZ)
      VALUES (NEW.rowid, NEW.x_ly, NEW.x_ly, NEW.y_ly, NEW.y_ly, NEW.z_ly, NEW.z_ly);
    END;
  `);
  db.exec(`DROP TRIGGER IF EXISTS stars_rtree_au`);

  db.exec(`
    CREATE TRIGGER stars_rtree_au
    AFTER UPDATE ON stars
    WHEN NEW.x_ly IS NOT NULL
    BEGIN
      DELETE FROM stars_rtree WHERE id = NEW.rowid;
      INSERT INTO stars_rtree (id, minX, maxX, minY, maxY, minZ, maxZ)
      VALUES (NEW.rowid, NEW.x_ly, NEW.x_ly, NEW.y_ly, NEW.y_ly, NEW.z_ly, NEW.z_ly);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS stars_rtree_ad
    AFTER DELETE ON stars
    BEGIN
      DELETE FROM stars_rtree WHERE id = OLD.rowid;
    END;
  `);
}

// One-time bulk population of stars_rtree from rows already in `stars`.
// The AFTER INSERT/UPDATE triggers above only cover writes made through
// them one row at a time — a `stars` populated any other way (e.g. a bulk
// table rebuild done directly in SQL, before these triggers even exist)
// needs this to catch up. No-op once it holds rows — same pattern as
// backfillRareRtree/backfillFRtree for their own partitions.
function backfillRtree(db) {
  if (db.prepare(`SELECT COUNT(*) AS c FROM stars_rtree`).get().c > 0) return;
  db.exec(`
    INSERT INTO stars_rtree (id, minX, maxX, minY, maxY, minZ, maxZ)
    SELECT rowid, x_ly, x_ly, y_ly, y_ly, z_ly, z_ly FROM stars WHERE x_ly IS NOT NULL
  `);
}

function ensureRareRtree(db) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS stars_rtree_rare USING rtree(
    id, minX, maxX, minY, maxY, minZ, maxZ, minC, maxC
  )`);

  const caseSql = RARE_CLASS_CASE_SQL.replaceAll("%s", "NEW.spectral_class");

  db.exec(`DROP TRIGGER IF EXISTS stars_rtree_rare_ai`);
  db.exec(`
    CREATE TRIGGER stars_rtree_rare_ai
    AFTER INSERT ON stars
    WHEN NEW.x_ly IS NOT NULL AND NEW.spectral_class IN (${RARE_CLASS_IN_SQL})
    BEGIN
      DELETE FROM stars_rtree_rare WHERE id = NEW.rowid;
      INSERT INTO stars_rtree_rare (id, minX, maxX, minY, maxY, minZ, maxZ, minC, maxC)
      VALUES (NEW.rowid, NEW.x_ly, NEW.x_ly, NEW.y_ly, NEW.y_ly, NEW.z_ly, NEW.z_ly,
              ${caseSql}, ${caseSql});
    END;
  `);

  db.exec(`DROP TRIGGER IF EXISTS stars_rtree_rare_au`);
  db.exec(`
    CREATE TRIGGER stars_rtree_rare_au
    AFTER UPDATE ON stars
    WHEN NEW.x_ly IS NOT NULL
    BEGIN
      DELETE FROM stars_rtree_rare WHERE id = NEW.rowid;
      INSERT INTO stars_rtree_rare (id, minX, maxX, minY, maxY, minZ, maxZ, minC, maxC)
      SELECT NEW.rowid, NEW.x_ly, NEW.x_ly, NEW.y_ly, NEW.y_ly, NEW.z_ly, NEW.z_ly,
             ${caseSql}, ${caseSql}
      WHERE NEW.spectral_class IN (${RARE_CLASS_IN_SQL});
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS stars_rtree_rare_ad
    AFTER DELETE ON stars
    BEGIN
      DELETE FROM stars_rtree_rare WHERE id = OLD.rowid;
    END;
  `);
}

// One-time population of stars_rtree_rare from rows already in `stars`
// (the triggers only fire on subsequent writes). No-op once it holds rows
// — like the main R-Tree it's then kept current by its triggers, and only
// a fresh or reset db reaches this.
function backfillRareRtree(db) {
  if (db.prepare(`SELECT COUNT(*) AS c FROM stars_rtree_rare`).get().c > 0) return;
  const rows = db
    .prepare(
      `SELECT rowid, x_ly, y_ly, z_ly, spectral_class FROM stars
       WHERE x_ly IS NOT NULL
         AND spectral_class IN (${RARE_CLASS_IN_SQL})`,
    )
    .all();
  if (rows.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO stars_rtree_rare (id, minX, maxX, minY, maxY, minZ, maxZ, minC, maxC)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMany = db.transaction((items) => {
    for (const row of items) {
      const code = RARE_CLASS_CODE[row.spectral_class];
      insert.run(row.rowid, row.x_ly, row.x_ly, row.y_ly, row.y_ly, row.z_ly, row.z_ly, code, code);
    }
  });
  insertMany(rows);
}

// Companion to ensureRtree holding only class-F stars (see
// F_RTREE_SPECTRAL_CLASS for why F specifically). No class dimension is
// needed — every row is F, so a box query on it needs no post-filter.
function ensureFRtree(db) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS stars_rtree_f USING rtree(
    id, minX, maxX, minY, maxY, minZ, maxZ
  )`);

  db.exec(`DROP TRIGGER IF EXISTS stars_rtree_f_ai`);
  db.exec(`
    CREATE TRIGGER stars_rtree_f_ai
    AFTER INSERT ON stars
    WHEN NEW.x_ly IS NOT NULL AND NEW.spectral_class = '${F_RTREE_SPECTRAL_CLASS}'
    BEGIN
      DELETE FROM stars_rtree_f WHERE id = NEW.rowid;
      INSERT INTO stars_rtree_f (id, minX, maxX, minY, maxY, minZ, maxZ)
      VALUES (NEW.rowid, NEW.x_ly, NEW.x_ly, NEW.y_ly, NEW.y_ly, NEW.z_ly, NEW.z_ly);
    END;
  `);

  db.exec(`DROP TRIGGER IF EXISTS stars_rtree_f_au`);
  db.exec(`
    CREATE TRIGGER stars_rtree_f_au
    AFTER UPDATE ON stars
    WHEN NEW.x_ly IS NOT NULL
    BEGIN
      DELETE FROM stars_rtree_f WHERE id = NEW.rowid;
      INSERT INTO stars_rtree_f (id, minX, maxX, minY, maxY, minZ, maxZ)
      SELECT NEW.rowid, NEW.x_ly, NEW.x_ly, NEW.y_ly, NEW.y_ly, NEW.z_ly, NEW.z_ly
      WHERE NEW.spectral_class = '${F_RTREE_SPECTRAL_CLASS}';
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS stars_rtree_f_ad
    AFTER DELETE ON stars
    BEGIN
      DELETE FROM stars_rtree_f WHERE id = OLD.rowid;
    END;
  `);
}

// One-time population of stars_rtree_f (~5M rows, ~80s) from rows already
// in `stars`; no-op once it holds rows. See backfillRareRtree.
function backfillFRtree(db) {
  if (db.prepare(`SELECT COUNT(*) AS c FROM stars_rtree_f`).get().c > 0) return;
  const rows = db
    .prepare(
      `SELECT rowid, x_ly, y_ly, z_ly FROM stars
       WHERE x_ly IS NOT NULL
         AND spectral_class = '${F_RTREE_SPECTRAL_CLASS}'`,
    )
    .all();
  if (rows.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO stars_rtree_f (id, minX, maxX, minY, maxY, minZ, maxZ)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMany = db.transaction((items) => {
    for (const row of items) {
      insert.run(row.rowid, row.x_ly, row.x_ly, row.y_ly, row.y_ly, row.z_ly, row.z_ly);
    }
  });
  insertMany(rows);
}

// main_id is the PRIMARY KEY now, so its uniqueness index can't be
// deferred the way idx_stars_spectral_class's plain secondary index can —
// SQLite maintains a PK's B-tree on every write regardless. Only
// idx_stars_spectral_class is left to drop for the bulk-load window.
export function dropBulkLoadIndexes(db) {
  db.exec(`DROP INDEX IF EXISTS idx_stars_spectral_class`);
}

export function ensureSpectralClassIndex(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_stars_spectral_class ON stars(spectral_class)`);
}

function backfillMissingSpectralClass(db) {
  const rows = db.prepare(`SELECT rowid, sp_type FROM stars WHERE spectral_class IS NULL`).all();
  if (rows.length === 0) return;
  const update = db.prepare(`UPDATE stars SET spectral_class = ? WHERE rowid = ?`);
  const updateMany = db.transaction((items) => {
    for (const row of items) update.run(getSpectralClass(row.sp_type), row.rowid);
  });
  updateMany(rows);
}

export function insertPinnedStars(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO stars (main_id, distance_ly, otype, sp_type, diameter_solar, x_ly, y_ly, z_ly, spectral_class)
    VALUES (@mainId, @distanceLy, @otype, @spType, @diameterSolar, @xLy, @yLy, @zLy, @spectralClass)
    ON CONFLICT(main_id) DO NOTHING
  `);
  const insertMany = db.transaction((items) => {
    for (const row of items) {
      const { x, y, z } = raDecDistanceToXyz(row.ra, row.dec, row.distanceLy);
      stmt.run({
        ...row,
        mainId: normalizeMainId(row.mainId),
        xLy: x,
        yLy: y,
        zLy: z,
        spectralClass: getSpectralClass(row.spType),
      });
    }
  });
  insertMany(rows);
}

export function upsertGaiaRows(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO stars (main_id, distance_ly, sp_type, spectral_class, x_ly, y_ly, z_ly)
    VALUES (@mainId, @distanceLy, @spType, @spectralClass, @xLy, @yLy, @zLy)
    ON CONFLICT(main_id) DO UPDATE SET
      distance_ly = excluded.distance_ly,
      sp_type = excluded.sp_type,
      spectral_class = excluded.spectral_class,
      x_ly = excluded.x_ly,
      y_ly = excluded.y_ly,
      z_ly = excluded.z_ly
  `);
  const insertMany = db.transaction((items) => {
    for (const row of items) {
      const { x, y, z } = raDecDistanceToXyz(row.ra, row.dec, row.distanceLy);
      const spType = row.gaiaSpType || null;
      stmt.run({ ...row, spType, spectralClass: getSpectralClass(spType), xLy: x, yLy: y, zLy: z });
    }
  });
  insertMany(rows);
}

export function updateSimbadRows(db, rows) {
  const stmt = db.prepare(`
    UPDATE stars
    SET otype = @otype,
        sp_type = COALESCE(@spType, sp_type),
        -- Keep the current main_id if SIMBAD gave no name at all, or if
        -- some OTHER row already has the new one — two distinct Gaia
        -- sources (e.g. wide-binary components) can come back from
        -- SIMBAD's ident/basic join with the same main_id; the first one
        -- to claim it keeps it, the other stays under its own numeric id
        -- rather than collide with it (main_id is the PRIMARY KEY now).
        main_id = CASE
          WHEN @newMainId IS NULL THEN main_id
          WHEN NOT EXISTS (
            SELECT 1 FROM stars s2 WHERE s2.main_id = @newMainId AND s2.main_id != @oldMainId
          ) THEN @newMainId
          ELSE main_id
        END,
        diameter_solar = @diameterSolar,
        spectral_class = classifySpType(COALESCE(@spType, sp_type))
    WHERE main_id = @oldMainId
  `);
  const updateMany = db.transaction((items) => {
    for (const row of items) {
      stmt.run({ ...row, oldMainId: row.gaiaSourceId, newMainId: normalizeMainId(row.mainId) });
    }
  });
  updateMany(rows);
}

export function insertSimbadDiscoveredRows(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO stars (main_id, distance_ly, otype, sp_type, diameter_solar, x_ly, y_ly, z_ly, spectral_class)
    VALUES (@mainId, @distanceLy, @otype, @spType, @diameterSolar, @xLy, @yLy, @zLy, @spectralClass)
    ON CONFLICT(main_id) DO NOTHING
  `);
  const insertMany = db.transaction((items) => {
    for (const row of items) {
      const mainId = normalizeMainId(row.mainId);
      const { x, y, z } = raDecDistanceToXyz(row.ra, row.dec, row.distanceLy);
      stmt.run({ ...row, mainId, xLy: x, yLy: y, zLy: z, spectralClass: getSpectralClass(row.spType) });
    }
  });
  insertMany(rows);
}

export function findExistingStarIds(db, candidateIds) {
  if (candidateIds.length === 0) return [];
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS _existing_check (id TEXT PRIMARY KEY)`);
  db.exec(`DELETE FROM _existing_check`);
  const insertCandidate = db.prepare(`INSERT OR IGNORE INTO _existing_check (id) VALUES (?)`);
  const insertMany = db.transaction((ids) => {
    for (const id of ids) insertCandidate.run(id);
  });
  insertMany(candidateIds);

  const rows = db
    .prepare(`SELECT main_id FROM stars WHERE main_id IN (SELECT id FROM _existing_check)`)
    .all();

  db.exec(`DROP TABLE _existing_check`);
  return rows.map((r) => r.main_id);
}

const INF_LY = 1e15; // stand-in for Infinity — SQLite has no notion of it

export function getShellRows(db, minLy, maxLy) {
  return db
    .prepare(
      `SELECT * FROM stars WHERE distance_ly >= ? AND distance_ly < ? ORDER BY distance_ly`,
    )
    .all(minLy, Number.isFinite(maxLy) ? maxLy : INF_LY);
}

const EXPORT_COLUMNS = `main_id, otype, sp_type, diameter_solar, x_ly, y_ly, z_ly`;

const stmtCacheByDb = new WeakMap();
function prep(db, sql) {
  let cache = stmtCacheByDb.get(db);
  if (!cache) {
    cache = new Map();
    stmtCacheByDb.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

export function searchStarByNameForExport(db, name) {
  return prep(db, `SELECT ${EXPORT_COLUMNS} FROM stars WHERE main_id = ? LIMIT 1`).get(name);
}

export function getRowsNearPointForExport(db, x, y, z, radiusLy, extraWhereSql = "1=1", extraParams = []) {
  const columns = EXPORT_COLUMNS.split(", ")
    .map((c) => `s.${c}`)
    .join(", ");
  return prep(
    db,
    `SELECT ${columns} FROM stars s NOT INDEXED
       JOIN stars_rtree r ON r.id = s.rowid
       WHERE r.minX >= ? AND r.minX <= ?
         AND r.minY >= ? AND r.minY <= ?
         AND r.minZ >= ? AND r.minZ <= ?
         AND (${extraWhereSql})
         AND (s.x_ly - ?) * (s.x_ly - ?) + (s.y_ly - ?) * (s.y_ly - ?) + (s.z_ly - ?) * (s.z_ly - ?)
             <= MIN(?, maxVisDistSq(s.sp_type))`,
  )
    .all(
      x - radiusLy, x + radiusLy,
      y - radiusLy, y + radiusLy,
      z - radiusLy, z + radiusLy,
      ...extraParams,
      x, x, y, y, z, z,
      radiusLy * radiusLy,
    );
}

export function getRowsNearPointByRareClassForExport(db, x, y, z, radiusLy, spectralClass) {
  const code = RARE_CLASS_CODE[spectralClass];
  const columns = EXPORT_COLUMNS.split(", ")
    .map((c) => `s.${c}`)
    .join(", ");
  return prep(
    db,
    `SELECT ${columns}
       FROM stars_rtree_rare r
       JOIN stars s ON s.rowid = r.id
       WHERE r.minX >= ? AND r.maxX <= ?
         AND r.minY >= ? AND r.maxY <= ?
         AND r.minZ >= ? AND r.maxZ <= ?
         AND r.minC >= ? AND r.maxC <= ?
         AND (s.x_ly - ?) * (s.x_ly - ?) + (s.y_ly - ?) * (s.y_ly - ?) + (s.z_ly - ?) * (s.z_ly - ?)
             <= MIN(?, maxVisDistSq(s.sp_type))`,
  )
    .all(
      x - radiusLy, x + radiusLy,
      y - radiusLy, y + radiusLy,
      z - radiusLy, z + radiusLy,
      code, code,
      x, x, y, y, z, z,
      radiusLy * radiusLy,
    );
}

// "Class-F stars within radiusLy of (x,y,z)", via stars_rtree_f (see
// ensureFRtree) — an F-only R-Tree, so the box touches only F stars and
// needs no class post-filter, unlike the same query through the main
// all-class R-Tree (getRowsNearPointForExport with s.spectral_class = 'F').
export function getRowsNearPointInFRtreeForExport(db, x, y, z, radiusLy) {
  const columns = EXPORT_COLUMNS.split(", ")
    .map((c) => `s.${c}`)
    .join(", ");
  return prep(
    db,
    `SELECT ${columns}
       FROM stars_rtree_f r
       JOIN stars s ON s.rowid = r.id
       WHERE r.minX >= ? AND r.maxX <= ?
         AND r.minY >= ? AND r.maxY <= ?
         AND r.minZ >= ? AND r.maxZ <= ?
         AND (s.x_ly - ?) * (s.x_ly - ?) + (s.y_ly - ?) * (s.y_ly - ?) + (s.z_ly - ?) * (s.z_ly - ?)
             <= MIN(?, maxVisDistSq(s.sp_type))`,
  )
    .all(
      x - radiusLy, x + radiusLy,
      y - radiusLy, y + radiusLy,
      z - radiusLy, z + radiusLy,
      x, x, y, y, z, z,
      radiusLy * radiusLy,
    );
}

export function getNearestStarForExport(db, x, y, z, radiusLy) {
  const columns = EXPORT_COLUMNS.split(", ")
    .map((c) => `s.${c}`)
    .join(", ");
  return prep(
    db,
    `SELECT ${columns} FROM stars s NOT INDEXED
       JOIN stars_rtree r ON r.id = s.rowid
      WHERE r.minX >= ? AND r.minX <= ?
        AND r.minY >= ? AND r.minY <= ?
        AND r.minZ >= ? AND r.minZ <= ?
      ORDER BY (s.x_ly - ?) * (s.x_ly - ?) + (s.y_ly - ?) * (s.y_ly - ?) + (s.z_ly - ?) * (s.z_ly - ?)
      LIMIT 1`,
  ).get(
    x - radiusLy, x + radiusLy,
    y - radiusLy, y + radiusLy,
    z - radiusLy, z + radiusLy,
    x, x, y, y, z, z,
  );
}

export function getRowsByMainIdsForExport(db, mainIds) {
  if (mainIds.length === 0) return [];
  const placeholders = mainIds.map(() => "?").join(", ");
  return prep(
    db,
    `SELECT ${EXPORT_COLUMNS} FROM stars
     WHERE main_id IN (${placeholders})
     ORDER BY main_id`,
  ).all(...mainIds);
}

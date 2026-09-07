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
      gaia_source_id   TEXT PRIMARY KEY,
      distance_ly      REAL,
      otype            TEXT,
      sp_type          TEXT,
      main_id          TEXT,
      diameter_solar   REAL,
      pinned           INTEGER NOT NULL DEFAULT 0,
      x_ly             REAL,
      y_ly             REAL,
      z_ly             REAL,
      spectral_class   TEXT
    );
    -- ra/dec/parallax were dropped from the built db (parallax only ever
    -- fed distance_ly at sync time; ra/dec only fed x_ly/y_ly/z_ly). Sync
    -- code still passes them as row fields — SQLite ignores the extra
    -- bind params — but they are no longer stored.
    CREATE INDEX IF NOT EXISTS idx_stars_distance ON stars(distance_ly);

    CREATE INDEX IF NOT EXISTS idx_stars_main_id ON stars(main_id);

    CREATE INDEX IF NOT EXISTS idx_stars_pinned ON stars(gaia_source_id) WHERE pinned = 1;
  `);
  ensureXyzColumns(db);
  ensureSpectralClassColumn(db);
  ensureRtree(db);
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

function ensureXyzColumns(db) {
  const columns = db.prepare(`PRAGMA table_info(stars)`).all().map((c) => c.name);
  for (const column of ["x_ly", "y_ly", "z_ly"]) {
    if (!columns.includes(column)) db.exec(`ALTER TABLE stars ADD COLUMN ${column} REAL`);
  }
  // x_ly is now the source of truth for position (ra/dec are gone) and
  // every insert path fills it, so there is nothing left to backfill.
  db.exec(`DROP INDEX IF EXISTS idx_stars_missing_xyz`);
}

function ensureSpectralClassColumn(db) {
  const columns = db.prepare(`PRAGMA table_info(stars)`).all().map((c) => c.name);
  if (!columns.includes("spectral_class")) db.exec(`ALTER TABLE stars ADD COLUMN spectral_class TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_stars_missing_spectral_class ON stars(gaia_source_id) WHERE spectral_class IS NULL`);

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

function ensureRareRtree(db) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS stars_rtree_rare USING rtree(
    id, minX, maxX, minY, maxY, minZ, maxZ, minC, maxC
  )`);

  const caseSql = RARE_CLASS_CASE_SQL.replaceAll("%s", "NEW.spectral_class");

  db.exec(`DROP TRIGGER IF EXISTS stars_rtree_rare_ai`);
  db.exec(`
    CREATE TRIGGER stars_rtree_rare_ai
    AFTER INSERT ON stars
    WHEN NEW.x_ly IS NOT NULL AND NEW.pinned = 0
      AND NEW.spectral_class IN (${RARE_CLASS_IN_SQL})
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
      WHERE NEW.pinned = 0 AND NEW.spectral_class IN (${RARE_CLASS_IN_SQL});
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
       WHERE pinned = 0 AND x_ly IS NOT NULL
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

// Companion to ensureRtree holding only class-F, non-pinned stars (see
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
    WHEN NEW.x_ly IS NOT NULL AND NEW.pinned = 0
      AND NEW.spectral_class = '${F_RTREE_SPECTRAL_CLASS}'
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
      WHERE NEW.pinned = 0 AND NEW.spectral_class = '${F_RTREE_SPECTRAL_CLASS}';
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
       WHERE pinned = 0 AND x_ly IS NOT NULL
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

export function dropBulkLoadIndexes(db) {
  db.exec(`DROP INDEX IF EXISTS idx_stars_main_id`);
  db.exec(`DROP INDEX IF EXISTS idx_stars_spectral_class`);
}

export function ensureMainIdIndex(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_stars_main_id ON stars(main_id)`);
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
    INSERT INTO stars (gaia_source_id, distance_ly, otype, sp_type, main_id, diameter_solar, pinned, x_ly, y_ly, z_ly, spectral_class)
    VALUES (@gaiaSourceId, @distanceLy, @otype, @spType, @mainId, @diameterSolar, 1, @xLy, @yLy, @zLy, @spectralClass)
    ON CONFLICT(gaia_source_id) DO NOTHING
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
    INSERT INTO stars (gaia_source_id, distance_ly, sp_type, spectral_class, x_ly, y_ly, z_ly)
    VALUES (@gaiaSourceId, @distanceLy, @spType, @spectralClass, @xLy, @yLy, @zLy)
    ON CONFLICT(gaia_source_id) DO UPDATE SET
      distance_ly = excluded.distance_ly,
      sp_type = excluded.sp_type,
      spectral_class = excluded.spectral_class,
      x_ly = excluded.x_ly,
      y_ly = excluded.y_ly,
      z_ly = excluded.z_ly
    WHERE pinned = 0
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
        main_id = @mainId,
        diameter_solar = @diameterSolar,
        spectral_class = classifySpType(COALESCE(@spType, sp_type))
    WHERE gaia_source_id = @gaiaSourceId AND pinned = 0
  `);
  const updateMany = db.transaction((items) => {
    for (const row of items) {
      stmt.run({ ...row, mainId: normalizeMainId(row.mainId) });
    }
  });
  updateMany(rows);
}

export function insertSimbadDiscoveredRows(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO stars
      (gaia_source_id, distance_ly, otype, sp_type, main_id, diameter_solar, x_ly, y_ly, z_ly, spectral_class)
    VALUES
      (@mainId, @distanceLy, @otype, @spType, @mainId, @diameterSolar, @xLy, @yLy, @zLy, @spectralClass)
    ON CONFLICT(gaia_source_id) DO UPDATE SET
      distance_ly = excluded.distance_ly,
      otype = excluded.otype,
      sp_type = excluded.sp_type,
      diameter_solar = excluded.diameter_solar,
      x_ly = excluded.x_ly,
      y_ly = excluded.y_ly,
      z_ly = excluded.z_ly,
      spectral_class = excluded.spectral_class
    WHERE pinned = 0
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
    .prepare(
      `SELECT gaia_source_id FROM stars
       WHERE gaia_source_id IN (SELECT id FROM _existing_check)
          OR main_id IN (SELECT id FROM _existing_check)`,
    )
    .all();

  db.exec(`DROP TABLE _existing_check`);
  return rows.map((r) => r.gaia_source_id);
}

export function clearSimbadRows(db, gaiaSourceIds) {
  const stmt = db.prepare(`
    UPDATE stars
    SET otype = NULL, main_id = NULL, diameter_solar = NULL
    WHERE gaia_source_id = @gaiaSourceId AND pinned = 0
  `);
  const updateMany = db.transaction((ids) => {
    for (const id of ids) stmt.run({ gaiaSourceId: id });
  });
  updateMany(gaiaSourceIds);
}

export function pruneShellRows(db, minLy, maxLy, keepGaiaSourceIds) {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS _sync_keep (gaia_source_id TEXT PRIMARY KEY)`);
  db.exec(`DELETE FROM _sync_keep`);
  const insertKeep = db.prepare(`INSERT OR IGNORE INTO _sync_keep (gaia_source_id) VALUES (?)`);
  const insertMany = db.transaction((ids) => {
    for (const id of ids) insertKeep.run(id);
  });
  insertMany(keepGaiaSourceIds);

  const result = db
    .prepare(
      `DELETE FROM stars
       WHERE distance_ly >= ? AND distance_ly < ? AND pinned = 0
         AND gaia_source_id NOT IN (SELECT gaia_source_id FROM _sync_keep)`,
    )
    .run(minLy, Number.isFinite(maxLy) ? maxLy : INF_LY);

  db.exec(`DROP TABLE _sync_keep`);
  return result.changes;
}

const INF_LY = 1e15; // stand-in for Infinity — SQLite has no notion of it

export function getShellRows(db, minLy, maxLy) {
  return db
    .prepare(
      `SELECT * FROM stars WHERE distance_ly >= ? AND distance_ly < ? AND pinned = 0 ORDER BY distance_ly`,
    )
    .all(minLy, Number.isFinite(maxLy) ? maxLy : INF_LY);
}

const EXPORT_COLUMNS = `gaia_source_id, otype, sp_type, main_id, diameter_solar, x_ly, y_ly, z_ly`;

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

export function getPinnedRowsForExport(db) {
  return prep(db, `SELECT ${EXPORT_COLUMNS} FROM stars WHERE pinned = 1 ORDER BY gaia_source_id`).all();
}

export function searchStarByNameForExport(db, name) {
  return prep(db, `SELECT ${EXPORT_COLUMNS} FROM stars WHERE main_id = ? AND pinned = 0 LIMIT 1`).get(name);
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
         AND s.pinned = 0
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
         AND s.pinned = 0
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
         AND s.pinned = 0
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

export function getNearestStarForExport(db, x, y, z, spectralClasses, startRadiusLy, maxRadiusLy) {
  const columns = EXPORT_COLUMNS.split(", ")
    .map((c) => `s.${c}`)
    .join(", ");
  const distExpr =
    "(s.x_ly - ?) * (s.x_ly - ?) + (s.y_ly - ?) * (s.y_ly - ?) + (s.z_ly - ?) * (s.z_ly - ?)";

  const want = new Set(spectralClasses);
  const obaCodes = ["O", "B", "A"].filter((c) => want.has(c)).map((c) => RARE_CLASS_CODE[c]);
  const rareStmt = obaCodes.length
    ? prep(
        db,
        `SELECT ${columns}
         FROM stars_rtree_rare r
         JOIN stars s ON s.rowid = r.id
         WHERE r.minX >= ? AND r.maxX <= ?
           AND r.minY >= ? AND r.maxY <= ?
           AND r.minZ >= ? AND r.maxZ <= ?
           AND r.minC >= ? AND r.maxC <= ?
         ORDER BY ${distExpr}
         LIMIT 1`,
      )
    : null;
  const minC = obaCodes.length ? Math.min(...obaCodes) : 0;
  const maxC = obaCodes.length ? Math.max(...obaCodes) : 0;

  const fStmt = want.has("F")
    ? prep(
        db,
        `SELECT ${columns}
         FROM stars_rtree_f r
         JOIN stars s ON s.rowid = r.id
         WHERE r.minX >= ? AND r.maxX <= ?
           AND r.minY >= ? AND r.maxY <= ?
           AND r.minZ >= ? AND r.maxZ <= ?
         ORDER BY ${distExpr}
         LIMIT 1`,
      )
    : null;

  let best = null;
  let bestD2 = Infinity;
  const consider = (row) => {
    if (!row) return;
    const dx = row.x_ly - x, dy = row.y_ly - y, dz = row.z_ly - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) {
      best = row;
      bestD2 = d2;
    }
  };

  for (let radius = startRadiusLy; radius <= maxRadiusLy; radius *= 2) {
    if (rareStmt) {
      consider(rareStmt.get(
        x - radius, x + radius,
        y - radius, y + radius,
        z - radius, z + radius,
        minC, maxC,
        x, x, y, y, z, z,
      ));
    }
    if (fStmt) {
      consider(fStmt.get(
        x - radius, x + radius,
        y - radius, y + radius,
        z - radius, z + radius,
        x, x, y, y, z, z,
      ));
    }
    if (best) return best;
  }
  return best;
}

export function getRowsByMainIdsForExport(db, mainIds) {
  if (mainIds.length === 0) return [];
  const placeholders = mainIds.map(() => "?").join(", ");
  return prep(
    db,
    `SELECT ${EXPORT_COLUMNS} FROM stars
     WHERE main_id IN (${placeholders}) AND pinned = 0
     ORDER BY gaia_source_id`,
  ).all(...mainIds);
}

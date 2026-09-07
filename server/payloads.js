// All the actual data work behind the /api routes, factored out of
// server/index.js so it can run inside the query workers (server/pool.js)
// instead of on the HTTP event loop. No express, no req/res here — every
// export takes plain values and returns a plain, structured-cloneable
// result (Buffers + JSON). server/index.js keeps the routing, the response
// caches, and the pool; each worker imports this module and calls initDb()
// once before serving.
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  openDbReadOnly,
  getPinnedRowsForExport,
  getRowsNearPointForExport,
  getRowsNearPointByRareClassForExport,
  getRowsNearPointInFRtreeForExport,
  getRowsByMainIdsForExport,
  searchStarByNameForExport,
  getNearestStarForExport,
  RARE_SPECTRAL_CLASSES,
  F_RTREE_SPECTRAL_CLASS,
} from "../scripts/db.js";
import { createDictionaries, addToDictionaries, buildBatchBuffer } from "../scripts/star-binary-format.js";
import { maxVisibilityDistance } from "../utils.js";

const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES_DIR = path.join(ROOT_DIR, "files");
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_VISIBLE_DISTANCE_LY = 100; // matches index.html's `visibleDistance`

// Single source of truth for "how far should a star of this spectral class
// be visible/loaded", shared with the client via GET /api/star-visibility-
// config (server/index.js re-serves this object). Read once per worker.
export const VISIBILITY_CONFIG = JSON.parse(
  readFileSync(path.join(SERVER_DIR, "star-visibility-config.json"), "utf8"),
);

let db;

// Called once per worker before it handles any message.
export function initDb() {
  db = openDbReadOnly();
  // Per-row visibility cutoff used by the near-point queries, as squared
  // distance (matches the squared-distance sum the SQL compares against).
  db.function("maxVisDistSq", (spType) => {
    const d = maxVisibilityDistance(spType, VISIBILITY_CONFIG);
    return d * d;
  });
}

const COMMON_CLASSES = ["F", "G", "K", "M"];
const MAIN_RTREE_COMMON_CLASSES = COMMON_CLASSES.filter((c) => c !== F_RTREE_SPECTRAL_CLASS);
const KNOWN_CLASS_LETTERS = [...RARE_SPECTRAL_CLASSES, ...COMMON_CLASSES];

const MAX_LUM_MULT = 2.0; // Ia supergiants — see utils.js's lumClassMult/giantBrightnessMult

function classBaseGlowMaxDist(letter, config) {
  const entry = config[letter];
  return entry && entry.glowMaxDist != null ? entry.glowMaxDist : config.defaultGlowMaxDist;
}

function groupWorstCaseRadius(letters, config) {
  return Math.max(...letters.map((l) => classBaseGlowMaxDist(l, config))) * MAX_LUM_MULT;
}

const NEARBY_TIMING = !!process.env.NEARBY_TIMING;

function getStarsNearPoint(x, y, z, radiusLy) {
  const rows = [];
  const log = [];
  const timed = (label, fn) => {
    const t = performance.now();
    const got = fn();
    if (NEARBY_TIMING) log.push(`${label} ${got.length}rows ${(performance.now() - t).toFixed(0)}ms`);
    rows.push(...got);
  };

  for (const letter of RARE_SPECTRAL_CLASSES) {
    const classRadius = Math.min(radiusLy, groupWorstCaseRadius([letter], VISIBILITY_CONFIG));
    timed(`${letter}[rare-rtree r=${classRadius}]`, () =>
      getRowsNearPointByRareClassForExport(db, x, y, z, classRadius, letter),
    );
  }

  const fRadius = Math.min(radiusLy, groupWorstCaseRadius([F_RTREE_SPECTRAL_CLASS], VISIBILITY_CONFIG));
  timed(`${F_RTREE_SPECTRAL_CLASS}[f-rtree r=${fRadius}]`, () =>
    getRowsNearPointInFRtreeForExport(db, x, y, z, fRadius),
  );

  for (const letter of MAIN_RTREE_COMMON_CLASSES) {
    const groupRadius = Math.min(radiusLy, groupWorstCaseRadius([letter], VISIBILITY_CONFIG));
    timed(`${letter}[box r=${groupRadius}]`, () =>
      getRowsNearPointForExport(db, x, y, z, groupRadius, "s.spectral_class = ?", [letter]),
    );
  }

  // Anything not in one of the groups above — an unlisted class (e.g. W),
  // or no sp_type at all (getSpectralClass('' | null) === '').
  const catchAllRadius = Math.min(radiusLy, VISIBILITY_CONFIG.defaultGlowMaxDist * MAX_LUM_MULT);
  const placeholders = KNOWN_CLASS_LETTERS.map(() => "?").join(", ");
  timed(`catch-all[box r=${catchAllRadius}]`, () =>
    getRowsNearPointForExport(
      db, x, y, z, catchAllRadius,
      `s.spectral_class NOT IN (${placeholders})`,
      KNOWN_CLASS_LETTERS,
    ),
  );

  if (NEARBY_TIMING) {
    console.log(
      `[nearby] (${x.toFixed(0)},${y.toFixed(0)},${z.toFixed(0)}) r=${radiusLy} ` +
      `→ ${rows.length} rows | ${log.join("  ")}`,
    );
  }
  return rows;
}

function constellationStarMainIds() {
  const text = readFileSync(path.join(FILES_DIR, "cons_lines.txt"), "utf8");
  const names = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    for (const name of line.split("|")) {
      const trimmed = name.trim();
      if (trimmed) names.add(trimmed);
    }
  }
  return [...names];
}
const CONSTELLATION_MAIN_IDS = constellationStarMainIds();

export function buildInitialPayload(maxLy) {
  const pinnedRows = getPinnedRowsForExport(db);
  const nearRows = getStarsNearPoint(0, 0, 0, maxLy);
  const nearIds = new Set(nearRows.map((r) => r.gaia_source_id));
  const farConstellationRows = getRowsByMainIdsForExport(db, CONSTELLATION_MAIN_IDS).filter(
    (r) => !nearIds.has(r.gaia_source_id),
  );
  const otherRows = [...nearRows, ...farConstellationRows];

  const dictionaries = createDictionaries();
  addToDictionaries(pinnedRows, true, dictionaries);
  addToDictionaries(otherRows, false, dictionaries);

  return {
    pinnedBuffer: buildBatchBuffer(pinnedRows, dictionaries, true),
    otherBuffer: buildBatchBuffer(otherRows, dictionaries, false),
    dictionariesJson: { otypes: dictionaries.otypes, spectralTypes: dictionaries.spectralTypes },
    starCount: pinnedRows.length + otherRows.length,
  };
}

export function buildNearbyPayload(x, y, z, radiusLy) {
  const rows = getStarsNearPoint(x, y, z, radiusLy);
  const dictionaries = createDictionaries();
  addToDictionaries(rows, false, dictionaries);
  return {
    buffer: buildBatchBuffer(rows, dictionaries, false),
    dictionariesJson: { otypes: dictionaries.otypes, spectralTypes: dictionaries.spectralTypes },
  };
}

export function buildSearchPayload(name) {
  const row = searchStarByNameForExport(db, name);
  if (!row) return null;
  const dictionaries = createDictionaries();
  addToDictionaries([row], false, dictionaries);
  return {
    buffer: buildBatchBuffer([row], dictionaries, false),
    dictionariesJson: { otypes: dictionaries.otypes, spectralTypes: dictionaries.spectralTypes },
  };
}

const NEAREST_STAR_CLASSES = ["O", "B", "A", "F"];
const NEAREST_SEARCH_START_LY = 300;
const NEAREST_SEARCH_MAX_LY = 600;

export function buildNearestStarPayload(x, y, z) {
  const row = getNearestStarForExport(
    db, x, y, z, NEAREST_STAR_CLASSES, NEAREST_SEARCH_START_LY, NEAREST_SEARCH_MAX_LY,
  );
  if (!row) return null;
  const dictionaries = createDictionaries();
  addToDictionaries([row], false, dictionaries);
  return {
    buffer: buildBatchBuffer([row], dictionaries, false),
    dictionariesJson: { otypes: dictionaries.otypes, spectralTypes: dictionaries.spectralTypes },
  };
}

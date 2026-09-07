#!/usr/bin/env node

import express from "express";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  openDb,
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
const PORT = process.env.PORT || 3001;
const DEFAULT_VISIBLE_DISTANCE_LY = 100; // matches index.html's `visibleDistance`

const db = openDb();

const VISIBILITY_CONFIG = JSON.parse(
  readFileSync(path.join(SERVER_DIR, "star-visibility-config.json"), "utf8"),
);

db.function("maxVisDistSq", (spType) => {
  const d = maxVisibilityDistance(spType, VISIBILITY_CONFIG);
  return d * d;
});

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

const payloadCache = new Map();

function buildInitialPayload(maxLy) {
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

function getInitialPayload(maxLy) {
  if (!payloadCache.has(maxLy)) payloadCache.set(maxLy, buildInitialPayload(maxLy));
  return payloadCache.get(maxLy);
}

function parseMaxLy(req) {
  const value = Number(req.query.maxLy);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_VISIBLE_DISTANCE_LY;
}

const NEARBY_CACHE_LIMIT = 200; // crude cap, not a real LRU — see below

function buildNearbyPayload(x, y, z, radiusLy) {
  const rows = getStarsNearPoint(x, y, z, radiusLy);
  const dictionaries = createDictionaries();
  addToDictionaries(rows, false, dictionaries);
  return {
    buffer: buildBatchBuffer(rows, dictionaries, false),
    dictionariesJson: { otypes: dictionaries.otypes, spectralTypes: dictionaries.spectralTypes },
  };
}

const nearbyCache = new Map();

function getNearbyPayload(x, y, z, radiusLy) {
  const key = `${x},${y},${z},${radiusLy}`;
  if (!nearbyCache.has(key)) {
    if (nearbyCache.size >= NEARBY_CACHE_LIMIT) nearbyCache.clear();
    nearbyCache.set(key, buildNearbyPayload(x, y, z, radiusLy));
  }
  return nearbyCache.get(key);
}

function parseNearbyParams(req) {
  const x = Number(req.query.x);
  const y = Number(req.query.y);
  const z = Number(req.query.z);
  const radiusLy = Number(req.query.radiusLy) || DEFAULT_VISIBLE_DISTANCE_LY;
  if (![x, y, z].every(Number.isFinite) || !(radiusLy > 0)) return null;
  return { x, y, z, radiusLy };
}

const SEARCH_CACHE_LIMIT = 200; // same crude cap as nearbyCache, not a real LRU

function buildSearchPayload(name) {
  const row = searchStarByNameForExport(db, name);
  if (!row) return null;
  const dictionaries = createDictionaries();
  addToDictionaries([row], false, dictionaries);
  return {
    buffer: buildBatchBuffer([row], dictionaries, false),
    dictionariesJson: { otypes: dictionaries.otypes, spectralTypes: dictionaries.spectralTypes },
  };
}

const searchCache = new Map();

function getSearchPayload(name) {
  if (!searchCache.has(name)) {
    if (searchCache.size >= SEARCH_CACHE_LIMIT) searchCache.clear();
    searchCache.set(name, buildSearchPayload(name));
  }
  return searchCache.get(name);
}

const NEAREST_STAR_CLASSES = ["O", "B", "A", "F"];
const NEAREST_SEARCH_START_LY = 300;
const NEAREST_SEARCH_MAX_LY = 600;
const NEAREST_STAR_CACHE_LIMIT = 200; // same crude cap as searchCache, not a real LRU

function buildNearestStarPayload(x, y, z) {
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

const nearestStarCache = new Map();

function getNearestStarPayload(x, y, z) {
  const key = `${x},${y},${z}`;
  if (!nearestStarCache.has(key)) {
    if (nearestStarCache.size >= NEAREST_STAR_CACHE_LIMIT) nearestStarCache.clear();
    nearestStarCache.set(key, buildNearestStarPayload(x, y, z));
  }
  return nearestStarCache.get(key);
}

function parseXyzParams(req) {
  const x = Number(req.query.x);
  const y = Number(req.query.y);
  const z = Number(req.query.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

const app = express();

app.get("/api/star-visibility-config", (req, res) => {
  res.json(VISIBILITY_CONFIG);
});

app.get("/api/dictionaries", (req, res) => {
  res.json(getInitialPayload(parseMaxLy(req)).dictionariesJson);
});

app.get("/api/stars/pinned", (req, res) => {
  const buf = getInitialPayload(parseMaxLy(req)).pinnedBuffer;
  res.type("application/octet-stream").send(buf);
});

app.get("/api/stars/initial", (req, res) => {
  const buf = getInitialPayload(parseMaxLy(req)).otherBuffer;
  res.type("application/octet-stream").send(buf);
});

app.get("/api/dictionaries/nearby", (req, res) => {
  const params = parseNearbyParams(req);
  if (!params) return res.status(400).json({ error: "x, y, z, and radiusLy must be finite numbers" });
  res.json(getNearbyPayload(params.x, params.y, params.z, params.radiusLy).dictionariesJson);
});

app.get("/api/stars/nearby", (req, res) => {
  const params = parseNearbyParams(req);
  if (!params) return res.status(400).json({ error: "x, y, z, and radiusLy must be finite numbers" });
  const buf = getNearbyPayload(params.x, params.y, params.z, params.radiusLy).buffer;
  res.type("application/octet-stream").send(buf);
});

app.get("/api/dictionaries/search", (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: "name is required" });
  const payload = getSearchPayload(name);
  if (!payload) return res.status(404).end();
  res.json(payload.dictionariesJson);
});

app.get("/api/stars/search", (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: "name is required" });
  const payload = getSearchPayload(name);
  if (!payload) return res.status(404).end();
  res.type("application/octet-stream").send(payload.buffer);
});

app.get("/api/dictionaries/nearest", (req, res) => {
  const params = parseXyzParams(req);
  if (!params) return res.status(400).json({ error: "x, y, and z must be finite numbers" });
  const payload = getNearestStarPayload(params.x, params.y, params.z);
  if (!payload) return res.status(404).end();
  res.json(payload.dictionariesJson);
});

app.get("/api/stars/nearest", (req, res) => {
  const params = parseXyzParams(req);
  if (!params) return res.status(400).json({ error: "x, y, and z must be finite numbers" });
  const payload = getNearestStarPayload(params.x, params.y, params.z);
  if (!payload) return res.status(404).end();
  res.type("application/octet-stream").send(payload.buffer);
});

app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
});

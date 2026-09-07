#!/usr/bin/env node

import express from "express";
import os from "os";
import { openDb } from "../scripts/db.js";
import { createPool } from "./pool.js";
import { VISIBILITY_CONFIG, DEFAULT_VISIBLE_DISTANCE_LY } from "./payloads.js";

const PORT = process.env.PORT || 3001;

const db = openDb();
void db;

const WORKER_COUNT = Number(process.env.QUERY_WORKERS) || os.availableParallelism();
const pool = createPool(WORKER_COUNT);

// A worker result's Buffers survive structured clone as Buffer or bare
// Uint8Array depending on the Node version — normalise without copying.
const asBuf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength));

// Cache the in-flight Promise, not just the resolved value, so the paired
// /api/stars/* + /api/dictionaries/* hits for the same point share one
// worker job instead of dispatching two. Failures aren't cached.
function cached(cache, key, limit, build) {
  let p = cache.get(key);
  if (!p) {
    if (cache.size >= limit) cache.clear();
    p = build();
    cache.set(key, p);
    p.catch(() => {
      if (cache.get(key) === p) cache.delete(key);
    });
  }
  return p;
}

const CACHE_LIMIT = 200; // crude cap, not a real LRU
const payloadCache = new Map();
const nearbyCache = new Map();
const searchCache = new Map();
const nearestCache = new Map();

const getInitialPayload = (maxLy) =>
  cached(payloadCache, maxLy, Infinity, () => pool.run("buildInitialPayload", [maxLy]));

const getNearbyPayload = (x, y, z, radiusLy) =>
  cached(nearbyCache, `${x},${y},${z},${radiusLy}`, CACHE_LIMIT, () =>
    pool.run("buildNearbyPayload", [x, y, z, radiusLy]),
  );

const getSearchPayload = (name) =>
  cached(searchCache, name, CACHE_LIMIT, () => pool.run("buildSearchPayload", [name]));

const getNearestPayload = (x, y, z) =>
  cached(nearestCache, `${x},${y},${z}`, CACHE_LIMIT, () => pool.run("buildNearestStarPayload", [x, y, z]));

function parseMaxLy(req) {
  const value = Number(req.query.maxLy);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_VISIBLE_DISTANCE_LY;
}

function parseNearbyParams(req) {
  const x = Number(req.query.x);
  const y = Number(req.query.y);
  const z = Number(req.query.z);
  const radiusLy = Number(req.query.radiusLy) || DEFAULT_VISIBLE_DISTANCE_LY;
  if (![x, y, z].every(Number.isFinite) || !(radiusLy > 0)) return null;
  return { x, y, z, radiusLy };
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

app.get("/api/dictionaries", async (req, res) => {
  try {
    res.json((await getInitialPayload(parseMaxLy(req))).dictionariesJson);
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

app.get("/api/stars/pinned", async (req, res) => {
  try {
    res.type("application/octet-stream").send(asBuf((await getInitialPayload(parseMaxLy(req))).pinnedBuffer));
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

app.get("/api/stars/initial", async (req, res) => {
  try {
    res.type("application/octet-stream").send(asBuf((await getInitialPayload(parseMaxLy(req))).otherBuffer));
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

app.get("/api/dictionaries/nearby", async (req, res) => {
  const params = parseNearbyParams(req);
  if (!params) return res.status(400).json({ error: "x, y, z, and radiusLy must be finite numbers" });
  try {
    const payload = await getNearbyPayload(params.x, params.y, params.z, params.radiusLy);
    res.json(payload.dictionariesJson);
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

app.get("/api/stars/nearby", async (req, res) => {
  const params = parseNearbyParams(req);
  if (!params) return res.status(400).json({ error: "x, y, z, and radiusLy must be finite numbers" });
  try {
    const payload = await getNearbyPayload(params.x, params.y, params.z, params.radiusLy);
    res.type("application/octet-stream").send(asBuf(payload.buffer));
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

app.get("/api/dictionaries/search", async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const payload = await getSearchPayload(name);
    if (!payload) return res.status(404).end();
    res.json(payload.dictionariesJson);
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

app.get("/api/stars/search", async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const payload = await getSearchPayload(name);
    if (!payload) return res.status(404).end();
    res.type("application/octet-stream").send(asBuf(payload.buffer));
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

app.get("/api/dictionaries/nearest", async (req, res) => {
  const params = parseXyzParams(req);
  if (!params) return res.status(400).json({ error: "x, y, and z must be finite numbers" });
  try {
    const payload = await getNearestPayload(params.x, params.y, params.z);
    if (!payload) return res.status(404).end();
    res.json(payload.dictionariesJson);
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

app.get("/api/stars/nearest", async (req, res) => {
  const params = parseXyzParams(req);
  if (!params) return res.status(400).json({ error: "x, y, and z must be finite numbers" });
  try {
    const payload = await getNearestPayload(params.x, params.y, params.z);
    if (!payload) return res.status(404).end();
    res.type("application/octet-stream").send(asBuf(payload.buffer));
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT} (${WORKER_COUNT} query workers)`);
});

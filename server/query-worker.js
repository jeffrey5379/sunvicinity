// One query worker: its own read-only SQLite connection, driven by messages
// from server/pool.js. `kind` names an exported builder in payloads.js;
// `args` are its plain arguments. Every result is structured-cloneable
// (Buffers + JSON), so it comes back to the main thread by copy.
import { parentPort } from "node:worker_threads";
import * as payloads from "./payloads.js";

payloads.initDb();

parentPort.on("message", ({ id, kind, args }) => {
  try {
    parentPort.postMessage({ id, ok: true, result: payloads[kind](...args) });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
});

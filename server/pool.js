// Fixed-size pool of query workers
import { Worker } from "node:worker_threads";

const WORKER_URL = new URL("./query-worker.js", import.meta.url);

export function createPool(size) {
  const idle = [];
  const queue = []; // { id, kind, args, resolve, reject }
  let nextId = 1;

  const pump = () => {
    while (queue.length && idle.length) {
      const worker = idle.pop();
      const job = queue.shift();
      worker.job = job;
      worker.postMessage({ id: job.id, kind: job.kind, args: job.args });
    }
  };

  const makeWorker = () => {
    const worker = new Worker(WORKER_URL);
    worker.job = null;
    worker.on("message", (msg) => {
      const job = worker.job;
      worker.job = null;
      if (job && msg.id === job.id) {
        if (msg.ok) job.resolve(msg.result);
        else job.reject(new Error(msg.error));
      }
      idle.push(worker);
      pump();
    });
    worker.on("error", (err) => {
      if (worker.job) worker.job.reject(err);
      worker.job = null;
      // Replace the dead worker so the pool keeps its size.
      idle.push(makeWorker());
      pump();
    });
    return worker;
  };

  for (let i = 0; i < size; i++) idle.push(makeWorker());

  return {
    size,
    run(kind, args) {
      return new Promise((resolve, reject) => {
        queue.push({ id: nextId++, kind, args, resolve, reject });
        pump();
      });
    },
  };
}

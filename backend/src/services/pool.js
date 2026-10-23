// Worker-thread pool with FIFO queue, per-task timeout and crash recovery.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../logger.js';

const workerFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workers', 'pdf-worker.js');

export class WorkerPool {
  constructor(size = config.workers) {
    this.size = size;
    this.slots = [];
    this.queue = [];
    this.seq = 0;
    for (let i = 0; i < size; i++) this.slots.push(this.#spawn(i));
  }

  #spawn(index) {
    const slot = { index, worker: new Worker(workerFile), busy: null };
    slot.worker.on('message', (m) => this.#onMessage(slot, m));
    slot.worker.on('error', (err) => this.#onCrash(slot, err));
    slot.worker.on('exit', (code) => {
      if (code !== 0 && slot.busy) this.#onCrash(slot, new Error(`worker exited with code ${code}`));
    });
    return slot;
  }

  #onMessage(slot, { id, ok, result, error }) {
    const task = slot.busy;
    if (!task || task.id !== id) return;
    clearTimeout(task.timer);
    slot.busy = null;
    if (ok) task.resolve(result);
    else task.reject(new Error(error));
    this.#pump();
  }

  #onCrash(slot, err) {
    logger.error({ err: err.message, worker: slot.index }, 'pdf worker crashed');
    const task = slot.busy;
    slot.busy = null;
    if (task) {
      clearTimeout(task.timer);
      task.reject(err);
    }
    slot.worker.removeAllListeners();
    slot.worker.terminate().catch(() => {});
    this.slots[slot.index] = this.#spawn(slot.index);
    this.#pump();
  }

  /** Run a task on any free worker. `jobId` lets a whole job be cancelled while queued. */
  run(msg, { jobId = null, timeoutMs = config.pageTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.seq, msg, jobId, timeoutMs, resolve, reject });
      this.#pump();
    });
  }

  /** Reject tasks of a job that have not started yet. */
  cancel(jobId) {
    const keep = [];
    for (const t of this.queue) {
      if (t.jobId === jobId) t.reject(new Error('cancelled'));
      else keep.push(t);
    }
    this.queue = keep;
  }

  /** Run the same message on every worker (e.g. release a document). */
  broadcast(msg) {
    return Promise.allSettled(this.slots.map((s) => new Promise((resolve) => {
      const id = ++this.seq;
      const onMsg = (m) => {
        if (m.id === id) {
          s.worker.off('message', onMsg);
          resolve();
        }
      };
      s.worker.on('message', onMsg);
      s.worker.postMessage({ id, msg });
    })));
  }

  #pump() {
    for (const slot of this.slots) {
      if (slot.busy || !this.queue.length) continue;
      const task = this.queue.shift();
      slot.busy = task;
      task.timer = setTimeout(() => this.#onCrash(slot, new Error(`task timed out after ${task.timeoutMs}ms`)), task.timeoutMs);
      slot.worker.postMessage({ id: task.id, msg: task.msg });
    }
  }

  get stats() {
    return { size: this.size, busy: this.slots.filter((s) => s.busy).length, queued: this.queue.length };
  }

  async close() {
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
  }
}

// One limit on the Gemini requests of the whole server. The pages are read in worker threads (pool.js), several jobs at a time,
// so a limit kept in one thread would let every thread send its own share: the counters live in shared memory instead, and the
// main thread and every page worker take their turn from them.
//   GEMINI_CONCURRENCY  requests in flight at once (default 3, the free tier; 10 and up with billing)
//   GEMINI_RPM          request starts per minute, spaced evenly (default none: the free tier's limit is about 10-15)
// A 429 that says to wait a few seconds holds every request back for that long (holdGemini), not only the one that got it.
// The same limit serves the local reader (Ollama / llama.cpp, withLocalReader): only one AI provider is active at a time. A local
// server answers only so many requests at once and queues the rest, and a request's time limit runs while it waits in that
// queue: so the requests wait here instead, and their time limit starts when they are sent.
//   LOCAL_AI_CONCURRENCY  local requests in flight at once (default OLLAMA_NUM_PARALLEL, else 3, for Ollama; LLAMA_PARALLEL, else 8, for Qari)
import { workerData } from 'node:worker_threads';

const MAX_SLOTS = 64; // worker threads whose permits are counted apart (so a crashed worker's permits can be given back)
// BigInt64 cells: earliest start of the next request (GEMINI_RPM), end of a hold after a 429 (ms since the epoch)
const NEXT = 0;
const HOLD = 1;
// Int32 cells (after the two BigInt64 ones): permits in use, a counter bumped at every release (waited on), then one per worker
const USED = 0;
const WAKE = 1;
const HELD = 2;

/** The shared memory of the limiter: made once by the main thread, handed to each page worker as workerData (pool.js). */
let shared = null;
export function throttleBuffer() {
  shared ||= workerData?.geminiThrottle || new SharedArrayBuffer(16 + 4 * (HELD + MAX_SLOTS));
  return shared;
}
const cells = () => {
  const sab = throttleBuffer();
  return { times: new BigInt64Array(sab, 0, 2), ints: new Int32Array(sab, 16) };
};
// the pool slot of this worker; the main thread (and a slot past MAX_SLOTS) holds its permits uncounted
const slot = Number.isInteger(workerData?.slot) && workerData.slot < MAX_SLOTS ? workerData.slot : -1;

const envInt = (name, d) => (Number(process.env[name]) > 0 ? Math.floor(Number(process.env[name])) : d);
export const geminiConcurrency = () => envInt('GEMINI_CONCURRENCY', 3);
const startGap = () => { const rpm = envInt('GEMINI_RPM', 0); return rpm ? Math.ceil(60_000 / rpm) : 0; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = () => Object.assign(new Error('Gemini is busy: no request slot came free in time'), { throttled: true });

/**
 * Wait for a turn to send a Gemini request. Rejects (err.throttled) when none comes before `deadline` (ms since the epoch), so the
 * page is read by the next reader in time for its own limit.
 * @returns {Promise<() => void>} gives the turn back (once)
 */
export async function acquireGemini({ deadline = Infinity, max = geminiConcurrency(), paced = true } = {}) {
  const { times, ints } = cells();
  for (;;) {
    const hold = paced ? Number(Atomics.load(times, HOLD)) - Date.now() : 0;
    if (hold > 0) {
      if (Date.now() + hold > deadline) throw busy();
      await sleep(hold);
      continue;
    }
    const used = Atomics.load(ints, USED);
    if (used < max) {
      if (Atomics.compareExchange(ints, USED, used, used + 1) === used) break;
      continue;
    }
    const left = deadline - Date.now();
    if (left <= 0) throw busy();
    const wake = Atomics.load(ints, WAKE);
    if (Atomics.load(ints, USED) < max) continue; // released between the two reads
    // woken by a release; also every second, for a hold set meanwhile and a deadline. The timer is what keeps the thread alive
    // meanwhile: a pending Atomics.waitAsync does not
    const w = Atomics.waitAsync(ints, WAKE, wake);
    if (w.async) {
      let timer;
      await Promise.race([w.value, new Promise((r) => { timer = setTimeout(r, Math.min(left, 1000)); })]);
      clearTimeout(timer);
    }
  }
  if (slot >= 0) Atomics.add(ints, HELD + slot, 1);
  let given = false;
  const release = () => {
    if (given) return;
    given = true;
    if (slot >= 0) Atomics.sub(ints, HELD + slot, 1);
    Atomics.sub(ints, USED, 1);
    Atomics.add(ints, WAKE, 1);
    Atomics.notify(ints, WAKE);
  };
  // GEMINI_RPM: each request takes the next start time, one gap after the one before
  const gap = paced ? startGap() : 0;
  if (gap) {
    let start;
    for (;;) {
      const prev = Atomics.load(times, NEXT);
      const now = BigInt(Date.now());
      start = prev > now ? prev : now;
      if (Atomics.compareExchange(times, NEXT, prev, start + BigInt(gap)) === prev) break;
    }
    const wait = Number(start) - Date.now();
    if (wait > 0) {
      if (Date.now() + wait > deadline) { release(); throw busy(); }
      await sleep(wait);
    }
  }
  return release;
}

/** Run `fn` (one Gemini request) in a turn of its own. */
export async function withGemini(fn, o) {
  const release = await acquireGemini(o);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Requests to the local reader in flight at once, server-wide (LOCAL_AI_CONCURRENCY). */
export const localConcurrency = (provider) => envInt('LOCAL_AI_CONCURRENCY', provider === 'llamacpp' ? envInt('LLAMA_PARALLEL', 8) : envInt('OLLAMA_NUM_PARALLEL', 3));

/** Run `fn` (one request to the local reader) in a turn of its own: no rate pacing, no deadline (the page has its own limit). */
export const withLocalReader = (provider, fn) => withGemini(fn, { max: localConcurrency(provider), paced: false });

/** Hold every Gemini request of the server back for `ms` (Google asked to wait after a 429). */
export function holdGemini(ms) {
  const { times } = cells();
  const until = BigInt(Date.now() + Math.max(0, Math.round(ms)));
  for (;;) {
    const prev = Atomics.load(times, HOLD);
    if (prev >= until || Atomics.compareExchange(times, HOLD, prev, until) === prev) return;
  }
}

// Main thread (pool.js): the counting slot of each live worker. A worker started in place of a crashed one gets a slot of its
// own, so the turns of the old one are given back once it has stopped (it can no longer give them back itself) and only those.
const taken = new Set();

/** A free counting slot for a new worker (-1 when all are taken: its turns are then not counted apart). */
export function claimSlot() {
  for (let i = 0; i < MAX_SLOTS; i++) if (!taken.has(i)) { taken.add(i); return i; }
  return -1;
}

/** A worker has stopped (crash, page time limit, shutdown): the turns it still held are given back, and its slot is free again. */
export function releaseWorker(index) {
  if (index < 0 || index >= MAX_SLOTS) return;
  taken.delete(index);
  const { ints } = cells();
  const held = Atomics.exchange(ints, HELD + index, 0);
  if (held <= 0) return;
  Atomics.sub(ints, USED, held);
  Atomics.add(ints, WAKE, 1);
  Atomics.notify(ints, WAKE);
}

/** Requests in flight now, server-wide (tests, diagnostics). */
export const geminiInFlight = () => Atomics.load(cells().ints, USED);

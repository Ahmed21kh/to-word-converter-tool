// Gemini Batch Mode for a whole book: the page reads of a conversion go to Google as one batch job (half the price of the same
// requests sent one by one; answered within 24 hours, usually much sooner), then the pages are built from the answers.
//
// Pass 1 runs every page with `batch: { dir, collect: true }`: each Gemini read the page would make is written to
// <dir>/requests/<key>.json and the page stops there (DeferredRead). Pages that need no AI read finish and are saved as usual.
// runBatch() sends the requests, waits, and writes <dir>/answers/<key>.json. Pass 2 runs the deferred pages with `batch: { dir }`:
// a read whose answer is there costs nothing more, any other read (a second reading, a fallback) is made live.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import readline from 'node:readline';
import path from 'node:path';

// a page task's error crosses the worker boundary as its message only: this one tells the orchestrator the page is waiting
export const DEFERRED = 'read deferred to the batch';

export class DeferredRead extends Error {
  constructor() {
    super(DEFERRED);
    this.deferred = true;
  }
}

/** The same page image, prompt and model give the same key in pass 1 and pass 2 (rendering and JPEG encoding are deterministic). */
export function batchKey(model, system, user, maxTokens, jpeg) {
  return createHash('sha256').update(`${model}\n${maxTokens}\n${system}\n${user}\n`).update(jpeg).digest('hex').slice(0, 40);
}

export async function batchAnswer(dir, key) {
  try { return JSON.parse(await readFile(path.join(dir, 'answers', `${key}.json`), 'utf8')); } catch { return null; }
}

/** One file per request: page workers are separate threads, and one JSONL appended to from all of them could interleave. */
export async function queueRequest(dir, key, request) {
  await mkdir(path.join(dir, 'requests'), { recursive: true });
  await writeFile(path.join(dir, 'requests', `${key}.json`), JSON.stringify({ key, request }));
}

const DONE = ['JOB_STATE_SUCCEEDED', 'JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_EXPIRED'];

/**
 * Send the queued requests as one batch job, wait for it, and store the answers. A job already sent (job.json) is resumed, so a
 * server restart during the hours a batch can take neither loses it nor sends (and pays for) it twice.
 * A failed or expired job stores nothing: pass 2 then reads those pages live, no page is lost.
 * @param {import('@google/genai').GoogleGenAI} ai
 * @returns {Promise<{state:string, sent:number, answered:number, failed:number}>}
 */
export async function runBatch(ai, dir, model, { pollMs = 30_000, isCancelled = () => false, onState = () => {} } = {}) {
  const jobFile = path.join(dir, 'job.json');
  let job = await readFile(jobFile, 'utf8').then(JSON.parse).catch(() => null);
  if (!job) {
    const names = (await readdir(path.join(dir, 'requests')).catch(() => [])).filter((f) => f.endsWith('.json'));
    if (!names.length) return { state: 'EMPTY', sent: 0, answered: 0, failed: 0 };
    // the file route, not inline requests: inline batches are limited to 20 MB, about 60 page images
    const jsonl = path.join(dir, 'requests.jsonl');
    const out = createWriteStream(jsonl);
    for (const f of names) {
      if (!out.write(`${await readFile(path.join(dir, 'requests', f), 'utf8')}\n`)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
    const file = await ai.files.upload({ file: jsonl, config: { mimeType: 'jsonl', displayName: `pages-${names.length}` } });
    const created = await ai.batches.create({ model, src: file.name, config: { displayName: `pages-${names.length}` } });
    job = { name: created.name, inputFile: file.name, sent: names.length };
    await writeFile(jobFile, JSON.stringify(job));
  }

  let state;
  let dest;
  for (;;) {
    const j = await ai.batches.get({ name: job.name });
    state = j.state;
    dest = j.dest;
    onState(state);
    if (DONE.includes(state)) break;
    if (isCancelled()) {
      await ai.batches.cancel({ name: job.name }).catch(() => {});
      throw new Error('cancelled');
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  let answered = 0;
  let failed = 0;
  if (state === 'JOB_STATE_SUCCEEDED' && dest?.fileName) {
    const results = path.join(dir, 'answers.jsonl');
    await ai.files.download({ file: dest.fileName, downloadPath: results });
    await mkdir(path.join(dir, 'answers'), { recursive: true });
    const lines = readline.createInterface({ input: createReadStream(results, 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const { key, response, error } = JSON.parse(line);
      // a request the batch could not answer is read live in pass 2
      if (!key || error || !response) { failed++; continue; }
      await writeFile(path.join(dir, 'answers', `${key}.json`), JSON.stringify(response));
      answered++;
    }
  }
  // the uploaded page images are not needed any more (the API would keep them 48 hours)
  if (job.inputFile) await ai.files.delete({ name: job.inputFile }).catch(() => {});
  return { state, sent: job.sent, answered, failed };
}

/** The REST form of one page request (what a line of the batch's JSONL holds). Same settings as the live call. */
export function restRequest({ system, user, jpeg, maxOutputTokens, thinking, mediaResolution, safetySettings }) {
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }, { text: user }] }],
    safetySettings,
    generationConfig: {
      temperature: 0,
      maxOutputTokens,
      ...(mediaResolution ? { mediaResolution } : {}),
      ...(thinking ? { thinkingConfig: thinking } : {}),
    },
  };
}

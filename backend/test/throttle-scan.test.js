// Whole-book AI conversions: the server-wide limits of the Gemini and the local readers, the clean-up of scanned and photographed
// pages and the verse table of the Word file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { acquireGemini, withGemini, holdGemini, releaseWorker, claimSlot, throttleBuffer, geminiInFlight } from '../src/services/gemini-throttle.js';
import { skewAngle, deskew, paperSpread, evenPaper, eraseStamp } from '../src/pipeline/scan-clean.js';
import { parseTranscription, paragraphsToBlocks } from '../src/pipeline/vision-ocr.js';
import { buildDocx } from '../src/pipeline/docx-builder.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` with these environment variables, then puts them back. */
async function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('no more Gemini requests in flight than GEMINI_CONCURRENCY', async () => {
  await withEnv({ GEMINI_CONCURRENCY: '2' }, async () => {
    let now = 0;
    let most = 0;
    await Promise.all(Array.from({ length: 6 }, () => withGemini(async () => {
      most = Math.max(most, ++now);
      await sleep(30);
      now--;
    })));
    assert.equal(most, 2);
    assert.equal(geminiInFlight(), 0, 'every turn is given back');
  });
});

test('a turn that does not come before the deadline is refused; a 429 hold makes every request wait', async () => {
  await withEnv({ GEMINI_CONCURRENCY: '1' }, async () => {
    const release = await acquireGemini();
    await assert.rejects(acquireGemini({ deadline: Date.now() + 80 }), (err) => err.throttled === true);
    release();
    release(); // a second release changes nothing
    assert.equal(geminiInFlight(), 0);
    holdGemini(150);
    const t0 = Date.now();
    await withGemini(async () => {});
    assert.ok(Date.now() - t0 >= 140, 'waited out the hold');
    holdGemini(400);
    holdGemini(50); // a shorter hold never shortens a longer one
    await assert.rejects(acquireGemini({ deadline: Date.now() + 100 }), (err) => err.throttled === true, 'a hold past the deadline is not waited for');
  });
});

test('GEMINI_RPM spaces the starts of the requests evenly', async () => {
  await withEnv({ GEMINI_CONCURRENCY: '5', GEMINI_RPM: '600' }, async () => {
    await withGemini(async () => {}); // (after the hold the test before left)
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 3 }, () => withGemini(async () => {})));
    assert.ok(Date.now() - t0 >= 180, `three starts 100 ms apart after the first (took ${Date.now() - t0} ms)`);
  });
});

/** A page worker that takes a turn for `ms` when asked (or never gives it back: ms < 0), sharing the server's limit. */
function turnWorker(env) {
  const mod = pathToFileURL(fileURLToPath(new URL('../src/services/gemini-throttle.js', import.meta.url))).href;
  const code = `import { parentPort } from 'node:worker_threads';
const { acquireGemini } = await import(${JSON.stringify(mod)});
parentPort.on('message', async (ms) => {
  const t0 = Date.now();
  const release = await acquireGemini();
  parentPort.postMessage({ waited: Date.now() - t0 });
  if (ms >= 0) setTimeout(release, ms);
});`;
  const slot = claimSlot();
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`), { workerData: { geminiThrottle: throttleBuffer(), slot }, env: { ...process.env, ...env } });
  const ask = (ms) => new Promise((resolve) => { worker.once('message', resolve); worker.postMessage(ms); });
  return { worker, slot, ask };
}

test('the limit holds across worker threads, and the turns of a worker that dies are given back', async () => {
  await withEnv({ GEMINI_CONCURRENCY: '1' }, async () => {
    const a = turnWorker({ GEMINI_CONCURRENCY: '1' });
    const b = turnWorker({ GEMINI_CONCURRENCY: '1' });
    try {
      assert.equal((await a.ask(250)).waited < 100, true);
      const second = await b.ask(0); // waits for a's turn, in another thread
      assert.ok(second.waited >= 150, `the second worker waited for the first (${second.waited} ms)`);
      // a worker that keeps its turn and is stopped (a page past its time limit): the pool gives the turn back
      await a.ask(-1);
      assert.equal(geminiInFlight(), 1);
      await a.worker.terminate();
      releaseWorker(a.slot);
      assert.equal(geminiInFlight(), 0);
      await withGemini(async () => {}, { deadline: Date.now() + 500 });
    } finally {
      await a.worker.terminate();
      await b.worker.terminate();
      releaseWorker(a.slot);
      releaseWorker(b.slot);
    }
  });
});

/** A page of word-like blobs: `lines` lines, tilted by `deg` (running down to the right), optionally in two halves (a poem). */
function blobPage({ lines = 14, deg = 0, halves = false, w = 1200, h = 1600 } = {}) {
  const g = new Uint8Array(w * h).fill(255);
  const t = Math.tan((deg * Math.PI) / 180);
  for (let l = 0; l < lines; l++) {
    for (let x = 100; x < 1100; x++) {
      if (x % 47 > 36 || (halves && x > 560 && x < 640)) continue;
      const y0 = Math.round(120 + l * 95 + x * t);
      for (let y = y0; y < y0 + 34; y++) g[y * w + x] = 20;
    }
  }
  return { g, w, h };
}

test('a page photographed askew is set straight; a straight page is left as it is', async () => {
  for (const deg of [2, -3]) {
    const p = blobPage({ deg });
    assert.ok(Math.abs(skewAngle(p.g, p.w, p.h) - deg) < 0.2, `tilt ${deg} found`);
    const s = await deskew(p.g, p.w, p.h);
    assert.equal(s.gray.length, p.w * p.h, 'same size');
    assert.equal(skewAngle(s.gray, p.w, p.h), 0, `tilt ${deg} straightened`);
  }
  const flat = blobPage();
  const same = await deskew(flat.g, flat.w, flat.h);
  assert.equal(same.angle, 0);
  assert.equal(same.gray, flat.g);
});

test('a shadow across a photographed page is measured and evened out; the ink keeps its grey (nothing binarised)', () => {
  const p = blobPage();
  assert.equal(paperSpread(p.g, p.w, p.h), 0);
  const shaded = Uint8Array.from(p.g, (v, i) => Math.round(v * (0.55 + (0.45 * (i % p.w)) / p.w)));
  assert.ok(paperSpread(shaded, p.w, p.h) >= 40);
  const even = evenPaper(shaded, p.w, p.h);
  assert.ok(paperSpread(even.gray, p.w, p.h) < 15, 'paper even after');
  const tones = new Set(even.gray);
  assert.ok(tones.size > 2, 'grey levels kept');
});

test('a faded print keeps its grey strokes whole (darkened); black print is evened as before', () => {
  const black = blobPage();
  assert.equal(evenPaper(black.g, black.w, black.h).faint, false);
  // strokes (every fourth row of a blob left white) of grey ink, from 30 to 120: divided by a tone in the ink, half turned white
  const p = blobPage();
  const faded = Uint8Array.from(p.g, (v, i) => (v === 255 || Math.floor(i / p.w) % 4 === 0 ? 255 : [30, 40, 100, 120][i % 4]));
  const even = evenPaper(faded, p.w, p.h);
  assert.equal(even.faint, true);
  let ink = 0;
  let kept = 0;
  for (let i = 0; i < faded.length; i++) if (faded[i] < 255) { ink++; if (even.gray[i] < 128) kept++; }
  assert.ok(kept / ink > 0.95, `strokes kept: ${(kept / ink).toFixed(2)}`);
  assert.ok(even.gray[0] === 255, 'paper white');
});

test("an uploader's stamp in the top left corner is painted out; a heading run into it, an address and a page's text are not", () => {
  const w = 1000;
  const h = 1400;
  const page = () => new Uint8Array(w * h).fill(255);
  const ink = (g, x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) g.fill(0, y * w + x0, y * w + x1); };
  const at = (g, x, y) => g[y * w + x];
  const text = (g) => { for (let y = 330; y < 1300; y += 60) ink(g, 60, y, 940, y + 40); };
  // "رفع" centred over the wider lines, then www.moswarat.com
  const stamp = (g) => { ink(g, 230, 30, 270, 60); ink(g, 130, 75, 370, 115); ink(g, 120, 125, 380, 160); ink(g, 140, 168, 360, 178); };

  const g = page();
  stamp(g);
  ink(g, 400, 240, 600, 290); // the chapter's heading
  text(g);
  assert.ok(eraseStamp(g, w, h));
  for (const [x, y] of [[250, 45], [200, 100], [300, 140], [200, 172]]) assert.equal(at(g, x, y), 255, `stamp at ${x},${y}`);
  assert.equal(at(g, 500, 260), 0, 'heading kept');
  assert.equal(at(g, 100, 350), 0, 'text kept');

  // a heading set so close under the stamp that its top runs into the stamp's last line: only the stamp's part goes
  const close = page();
  stamp(close);
  ink(close, 450, 165, 600, 230);
  text(close);
  assert.ok(eraseStamp(close, w, h));
  assert.equal(at(close, 200, 172), 255, 'www line');
  assert.equal(at(close, 500, 200), 0, 'heading kept');

  // an address at the head of a letter: no short word centred over its lines
  const letter = page();
  for (const y of [40, 90, 140]) ink(letter, 120, y, 380, y + 35);
  text(letter);
  assert.equal(eraseStamp(letter, w, h), null);
  assert.equal(at(letter, 200, 60), 0);

  // the text starts at the top of the page
  const full = page();
  for (let y = 30; y < 1300; y += 60) ink(full, 60, y, 940, y + 40);
  assert.equal(eraseStamp(full, w, h), null);
});

test('verses are written as a borderless table of two equal columns; printMatch keeps the tab stops', async () => {
  const { default: JSZip } = await import('jszip');
  const { paragraphs } = parseTranscription('قال الشاعر:\n\nأَلا كُلُّ شَيءٍ ما خَلا اللَهَ باطِلُ // وَكُلُّ نَعيمٍ لا مَحالَةَ زائِلُ\nوَكُلُّ أُناسٍ سَوفَ تَدخُلُ بَينَهُم // دُوَيهِيَةٌ تَصفَرُّ مِنها الأَنامِلُ\n\nوهذا نثر بعدها.');
  const page = { n: 1, width: 420, height: 595, flow: true, method: 'ai', margins: { top: 36, bottom: 30, left: 42, right: 42 }, blocks: paragraphsToBlocks(paragraphs) };
  const xmlOf = async (opts) => (await JSZip.loadAsync(await buildDocx([page], { arabicFont: 'Traditional Arabic', latinFont: 'Times New Roman', ...opts }))).file('word/document.xml').async('string');
  const doc = await xmlOf({});
  assert.equal(doc.split('<w:tbl>').length - 1, 1, 'the two verses share one table');
  assert.equal(doc.split('<w:tr>').length - 1 + (doc.split('<w:tr ').length - 1), 2, 'one row per verse');
  const grid = doc.match(/<w:tblGrid>(.*?)<\/w:tblGrid>/)[1].match(/w:w="(\d+)"/g);
  assert.equal(grid.length, 2);
  assert.equal(grid[0], grid[1], 'equal columns');
  assert.ok(doc.includes('<w:bidiVisual/>'), 'the first half on the right');
  assert.ok(!doc.includes('<w:tab/>'), 'no tab left in the halves');
  assert.ok(/<w:tblBorders>(?:(?!<\/w:tblBorders>).)*w:val="none"/.test(doc), 'no borders');
  assert.ok(doc.includes('وهذا نثر بعدها.'));
  const shamela = await xmlOf({ printMatch: true });
  assert.ok(!shamela.includes('<w:tbl>'), 'printMatch: no table');
  assert.ok(shamela.includes('<w:tab/>'));
});

test('local reader: no more requests in flight than LOCAL_AI_CONCURRENCY, and no Gemini pacing on them', async () => {
  const { withLocalReader } = await import('../src/services/gemini-throttle.js');
  const saved = { LOCAL_AI_CONCURRENCY: process.env.LOCAL_AI_CONCURRENCY, GEMINI_RPM: process.env.GEMINI_RPM };
  process.env.LOCAL_AI_CONCURRENCY = '2';
  process.env.GEMINI_RPM = '1'; // would space Gemini starts a minute apart
  try {
    let now = 0;
    let peak = 0;
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 6 }, () => withLocalReader('ollama', async () => {
      peak = Math.max(peak, ++now);
      await new Promise((r) => setTimeout(r, 20));
      now--;
    })));
    assert.equal(peak, 2);
    assert.ok(Date.now() - t0 < 5000, 'not paced like Gemini');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

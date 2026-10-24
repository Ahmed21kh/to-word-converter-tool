// OCR experiments on a scanned page, scored against a known transcript (letters only, diacritics ignored).
//   node scripts/ocr-lab.mjs "<pdf>" <page> <truth-file.txt>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { openPdf, renderPage } from '../src/pipeline/page-extract.js';
import { stripMarks } from '../src/pipeline/arabic.js';
import { findFrameInterior, crop, stripDiacritics } from '../src/pipeline/scan-clean.js';

const [pdf, pageArg, truthFile] = process.argv.slice(2);
const letters = (s) => stripMarks(s).replace(/[^ء-يٱ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي');
const truth = letters(readFileSync(truthFile, 'utf8'));

// semi-global edit distance: how well does `truth` appear inside `text`?
function score(text) {
  const t = letters(text);
  const n = truth.length;
  const m = t.length;
  let prev = new Uint16Array(m + 1); // free start in text
  for (let i = 1; i <= n; i++) {
    const cur = new Uint16Array(m + 1);
    cur[0] = i;
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (truth[i - 1] === t[j - 1] ? 0 : 1));
    prev = cur;
  }
  let best = n;
  for (let j = 0; j <= m; j++) best = Math.min(best, prev[j]);
  return { sim: 1 - best / n, ocrLetters: m };
}

const doc = await openPdf(path.resolve(pdf));
const page = await doc.getPage(Number(pageArg));
const { canvas } = await renderPage(page, 300, 4200);
const { width: W, height: H } = canvas;
const rgba = canvas.getContext('2d').getImageData(0, 0, W, H).data;
const gray = new Uint8Array(W * H);
for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
console.log(`rendered ${W}x${H}; truth letters: ${truth.length}`);

const worker = await createWorker(['ara', 'eng'], 1, { langPath: path.resolve('data/tessdata'), gzip: true, cacheMethod: 'none', logger: () => {} });
async function run(label, g, w, h, psm) {
  await worker.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '1', user_defined_dpi: '300' });
  const png = await sharp(Buffer.from(g), { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
  const t0 = performance.now();
  const { data } = await worker.recognize(png, {}, { text: true });
  const s = score(data.text);
  console.log(`${label.padEnd(34)} sim=${(s.sim * 100).toFixed(1)}%  conf=${data.confidence.toFixed(0)}  letters=${s.ocrLetters}  ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return data.text;
}

const box = findFrameInterior(gray, W, H);
console.log('frame interior:', box);
await run('full page, auto layout (current)', gray, W, H, 3);
if (box) {
  const c = crop(gray, W, H, box);
  await run('cropped to frame, auto layout', c.gray, c.width, c.height, 3);
  await run('cropped to frame, single block', c.gray, c.width, c.height, 6);
  await run('cropped to frame, single column', c.gray, c.width, c.height, 4);
}
{
  const base = box ? crop(gray, W, H, box) : { gray, width: W, height: H };
  const s = stripDiacritics(base.gray, base.width, base.height, { dotExtent: 0.35, dotAspect: 1.3 });
  const araOnly = await createWorker(['ara'], 1, { langPath: path.resolve('data/tessdata'), gzip: true, cacheMethod: 'none', logger: () => {} });
  const runWith = async (wk, label, g, w, h, psm) => {
    await wk.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '1', user_defined_dpi: '300' });
    const png = await sharp(Buffer.from(g), { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
    const { data } = await wk.recognize(png, {}, { text: true });
    const sc = score(data.text);
    console.log(label.padEnd(44) + 'sim=' + (sc.sim * 100).toFixed(1) + '%  conf=' + data.confidence.toFixed(0));
    return data.text;
  };
  await runWith(worker, 'ara+eng, gray', s.gray, base.width, base.height, 6);
  await runWith(araOnly, 'ara only, gray', s.gray, base.width, base.height, 6);
  // hard binarisation
  const bin = Uint8Array.from(s.gray, (v) => (v < 170 ? 0 : 255));
  await runWith(araOnly, 'ara only, binarised(170)', bin, base.width, base.height, 6);
  // scales
  for (const k of [0.7, 1.3]) {
    const w2 = Math.round(base.width * k), h2 = Math.round(base.height * k);
    const buf = await sharp(Buffer.from(s.gray), { raw: { width: base.width, height: base.height, channels: 1 } }).resize(w2, h2, { kernel: 'lanczos3' }).raw().toBuffer();
    await runWith(araOnly, 'ara only, scale ' + k, buf, w2, h2, 6);
  }
  await runWith(araOnly, 'ara only, auto layout (psm 3)', s.gray, base.width, base.height, 3);
  await araOnly.terminate();
}
await worker.terminate();
process.exit(0);

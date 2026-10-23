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
  const variants = [
    { dotExtent: 0.66, dotAspect: 1.7 },
    { dotExtent: 0.35, dotAspect: 1.5 },
    { dotExtent: 0.35, dotAspect: 1.3 },
    { dotExtent: 0.3, dotAspect: 1.8 },
    { dotExtent: 0.45, dotAspect: 1.6 },
  ];
  for (const v of variants) {
    const s = stripDiacritics(base.gray, base.width, base.height, v);
    await run('strip ' + JSON.stringify(v), s.gray, base.width, base.height, 6);
    if (v.dotAspect === 1.5) await sharp(Buffer.from(s.gray), { raw: { width: base.width, height: base.height, channels: 1 } }).png().toFile(process.env.LAB_OUT || 'lab-stripped.png');
  }
}
await worker.terminate();
process.exit(0);

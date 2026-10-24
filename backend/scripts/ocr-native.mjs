// Compare native Tesseract models on one scanned page, scored against a transcript (letters only).
//   node scripts/ocr-native.mjs "<pdf>" <page> <transcript.txt> <tessdata-dir> [psm ...]
// <tessdata-dir> holds ara.traineddata (e.g. the "best" model). The page is prepared exactly like the app does.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { openPdf, renderPage } from '../src/pipeline/page-extract.js';
import { stripMarks } from '../src/pipeline/arabic.js';
import { prepareForOcr, rgbaToGray } from '../src/pipeline/scan-clean.js';

const [pdf, pageArg, truthFile, tessdata, ...psms] = process.argv.slice(2);
const exe = process.env.TESSERACT || 'C:/Program Files/Tesseract-OCR/tesseract.exe';
const letters = (s) => stripMarks(s).replace(/[^ء-يٱ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي');
const truth = letters(readFileSync(truthFile, 'utf8'));

function score(text) {
  const t = letters(text);
  let prev = new Uint16Array(t.length + 1);
  for (let i = 1; i <= truth.length; i++) {
    const cur = new Uint16Array(t.length + 1);
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (truth[i - 1] === t[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - Math.min(...prev) / truth.length;
}

const doc = await openPdf(path.resolve(pdf));
const page = await doc.getPage(Number(pageArg));
const { canvas } = await renderPage(page, 300, 4200);
const gray = rgbaToGray(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
const prep = await prepareForOcr(gray, canvas.width, canvas.height, {});
const png = path.join(os.tmpdir(), `ocr-native-${process.pid}.png`);
writeFileSync(png, await sharp(Buffer.from(prep.gray.buffer, prep.gray.byteOffset, prep.gray.length), { raw: { width: prep.width, height: prep.height, channels: 1 } }).png().toBuffer());
console.log(`prepared ${prep.width}x${prep.height}, truth letters ${truth.length}, tessdata ${tessdata}`);

for (const psm of psms.length ? psms : ['6']) {
  const t0 = performance.now();
  const out = execFileSync(exe, [png, 'stdout', '-l', 'ara', '--tessdata-dir', tessdata, '--psm', psm, '--oem', '1'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  console.log(`psm ${psm}: letter accuracy ${(score(out) * 100).toFixed(1)}%  (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  if (psm === (psms[0] || '6')) console.log(out.split('\n').slice(0, 4).join('\n'));
}
process.exit(0);

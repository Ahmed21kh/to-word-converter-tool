// Measure the AI reader (VISION_PROVIDER) on one page of a scanned PDF against a transcript you typed, preparing the page exactly
// like the converter does (frame crop + enhancement).
//   VISION_PROVIDER=ollama VISION_MODEL=qwen2.5vl:7b node scripts/ai-eval.mjs <pdf> <page> <transcript.txt>
// Prints the time, letter accuracy (diacritics ignored), accuracy with diacritics, and how many wrong words were flagged.
// EVAL_OUT=<file> writes the model text. Knobs: VISION_IMAGE_DPI, VISION_LINE_SCALE, VISION_MODE=page|lines, AI_FLAG_CONF.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openPdf, renderPage } from '../src/pipeline/page-extract.js';
import { readPageWithAi, visionStatus } from '../src/pipeline/vision-ocr.js';
import { rgbaToGray, frameBands, crop, enhanceForAi } from '../src/pipeline/scan-clean.js';
import { stripMarks } from '../src/pipeline/arabic.js';
import { letterAccuracy, fullAccuracy } from './score-text.mjs';

const [pdf, pageArg, truthFile] = process.argv.slice(2);
if (!pdf || !pageArg || !truthFile) {
  console.log('usage: node scripts/ai-eval.mjs <pdf> <page> <transcript.txt>');
  process.exit(1);
}
const st = visionStatus();
if (!st.available) {
  console.log('No AI reader configured. Set VISION_PROVIDER=ollama (free, local) or claude, see backend/README.md');
  process.exit(1);
}
const doc = await openPdf(path.resolve(pdf));
const { canvas } = await renderPage(await doc.getPage(Number(pageArg)), Number(process.env.VISION_IMAGE_DPI) || 200, 2600);
const W = canvas.width;
const H = canvas.height;
const gray = rgbaToGray(canvas.getContext('2d').getImageData(0, 0, W, H).data, W, H);
const bands = frameBands(gray, W, H);
const body = bands ? crop(gray, W, H, bands.body) : { gray, width: W, height: H };
const t0 = performance.now();
const r = await readPageWithAi(await enhanceForAi(body.gray, body.width, body.height));
const seconds = (performance.now() - t0) / 1000;

const truth = readFileSync(truthFile, 'utf8');
const text = r.paragraphs.map((p) => p.text).join(String.fromCharCode(10));
console.log(`provider ${st.provider}, model ${r.model}, mode ${r.mode || 'page'}, ${seconds.toFixed(1)} s`);
console.log(`letters ${(letterAccuracy(truth, text) * 100).toFixed(1)}%   with diacritics ${(fullAccuracy(truth, text) * 100).toFixed(1)}%`);

// do the flagged words (yellow in Word) include the wrong ones? A word is wrong when its letters are not a word of the transcript.
const fold = (w) => stripMarks(w).replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[^ء-ي]/g, '');
const truthSet = new Set(truth.split(/\s+/).map(fold).filter(Boolean));
let words = 0;
let wrong = 0;
let flagged = 0;
let caught = 0;
for (const p of r.paragraphs) {
  for (const run of p.runs || []) {
    for (const w of run.text.split(' ').filter(Boolean)) {
      const f = fold(w);
      if (!f) continue;
      words++;
      const bad = !truthSet.has(f);
      if (bad) wrong++;
      if (run.lowConf) flagged++;
      if (bad && run.lowConf) caught++;
    }
  }
}
if (r.paragraphs[0]?.runs) console.log(`words ${words}, not in transcript ${wrong}, flagged ${flagged}, wrong words flagged ${caught}`);
if (process.env.EVAL_OUT) writeFileSync(process.env.EVAL_OUT, text);
process.exit(0);

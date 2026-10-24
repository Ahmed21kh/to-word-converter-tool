// Debug: ink weight of every text line of a scanned page (stroke thickness relative to the median line).
//   node scripts/line-weight.mjs <pdf> <page>
import path from 'node:path';
import sharp from 'sharp';
import { openPdf, renderPage } from '../src/pipeline/page-extract.js';
import { segmentLines } from '../src/pipeline/text-lines.js';
import { rgbaToGray, frameBands, crop, enhanceForAi } from '../src/pipeline/scan-clean.js';
const [pdf, pageArg] = process.argv.slice(2);
const doc = await openPdf(path.resolve(pdf));
const { canvas } = await renderPage(await doc.getPage(Number(pageArg)), 200, 2600);
const W = canvas.width, H = canvas.height;
const gray = rgbaToGray(canvas.getContext('2d').getImageData(0, 0, W, H).data, W, H);
const bands = frameBands(gray, W, H);
const body = bands ? crop(gray, W, H, bands.body) : { gray, width: W, height: H };
const flat = await sharp(await enhanceForAi(body.gray, body.width, body.height)).greyscale().raw().toBuffer({ resolveWithObject: true });
const { width: w, height: h } = flat.info;
const lines = segmentLines(flat.data, w, h);
const rows = lines.map((l) => {
  let ink = 0;
  for (let y = l.y0; y < l.y1; y++) for (let x = l.x0; x < l.x1; x++) if (flat.data[y * w + x] < 140) ink++;
  return { l, density: ink / ((l.x1 - l.x0) * (l.y1 - l.y0)), width: l.x1 - l.x0 };
});
const med = [...rows.map((r) => r.density)].sort((a, b) => a - b)[Math.floor(rows.length / 2)];
rows.forEach((r, i) => console.log(`${String(i + 1).padStart(2)} density ${r.density.toFixed(3)} ratio ${(r.density / med).toFixed(2)} height ${r.l.y1 - r.l.y0} width ${r.width}`));
process.exit(0);

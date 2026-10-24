import path from 'node:path';
import { openPdf, renderPage } from '../src/pipeline/page-extract.js';
import { findFrameInterior, rgbaToGray } from '../src/pipeline/scan-clean.js';
const doc = await openPdf(path.resolve(process.argv[2]));
for (const n of process.argv[3].split(',').map(Number)) {
  const page = await doc.getPage(n);
  const { canvas } = await renderPage(page, 300, 4200);
  const W = canvas.width, H = canvas.height;
  const gray = rgbaToGray(canvas.getContext('2d').getImageData(0, 0, W, H).data, W, H);
  const box = findFrameInterior(gray, W, H, { debug: true });
  console.log(`page ${n} ${W}x${H}:`, box ? `frame found y ${box.y0}-${box.y1} (${Math.round(box.y0 / H * 100)}%..${Math.round(box.y1 / H * 100)}%) x ${box.x0}-${box.x1}` : 'NO FRAME FOUND');
}
process.exit(0);

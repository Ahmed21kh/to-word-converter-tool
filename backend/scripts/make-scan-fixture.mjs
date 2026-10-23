// Builds an image-only PDF (no text layer) from the first pages of arabic-sample.pdf, to test OCR.
//   node scripts/make-scan-fixture.mjs
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openPdf, renderPage } from '../src/pipeline/page-extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'test', 'fixtures');
mkdirSync(out, { recursive: true });
const doc = await openPdf(path.join(out, 'arabic-sample.pdf'));
let imgs = '';
for (const n of [1, 3]) {
  const page = await doc.getPage(n);
  const { canvas } = await renderPage(page, 200);
  const file = `scan-p${n}.jpg`;
  writeFileSync(path.join(out, file), canvas.toBuffer('image/jpeg', 80));
  imgs += `<img src="${file}" style="width:210mm;height:297mm;display:block;break-after:page">`;
}
const htmlPath = path.join(out, 'scan-sample.html');
writeFileSync(htmlPath, `<!doctype html><html><head><style>@page{size:A4;margin:0}body{margin:0}</style></head><body>${imgs}</body></html>`);
const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
execFileSync(edge, ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${path.join(out, 'scan-sample.pdf')}`, pathToFileURL(htmlPath).href], { stdio: 'inherit' });
console.log('written scan-sample.pdf');
process.exit(0);

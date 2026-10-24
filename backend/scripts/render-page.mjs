// Render one PDF page to a PNG:  node scripts/render-page.mjs "<pdf>" <page> <out.png> [dpi]
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { openPdf, renderPage } from '../src/pipeline/page-extract.js';
const [pdf, n, out, dpi = '100'] = process.argv.slice(2);
const doc = await openPdf(path.resolve(pdf));
const { canvas } = await renderPage(await doc.getPage(Number(n)), Number(dpi), 2200);
writeFileSync(out, canvas.toBuffer('image/png'));
console.log('ok', canvas.width, canvas.height);
process.exit(0);

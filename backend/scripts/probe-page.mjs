// Diagnose how individual pages of a PDF are handled:  node scripts/probe-page.mjs <file.pdf> 1,6,8 [mode]
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPdf, rawPage } from '../src/pipeline/page-extract.js';
import { processPage } from '../src/pipeline/process-page.js';
import { terminateOcr } from '../src/pipeline/ocr.js';

const [file, pagesArg = '1', mode = 'smart'] = process.argv.slice(2);
const workDir = path.join(os.tmpdir(), 'p2w-probe');
mkdirSync(workDir, { recursive: true });
const doc = await openPdf(path.resolve(file));
console.log('pages:', doc.numPages);
for (const n of pagesArg.split(',').map(Number)) {
  const page = await doc.getPage(n);
  const raw = await rawPage(page);
  const chars = raw.items.reduce((s, i) => s + i.str.replace(/\s/g, '').length, 0);
  const imgs = raw.images.map((i) => `${Math.round(i.x1 - i.x0)}x${Math.round(i.y1 - i.y0)}`);
  const t0 = performance.now();
  const { model, meta } = await processPage(doc, n, { mode, ocr: 'auto', language: 'ar', highlightUncertain: true, defaultDir: 'rtl' }, workDir);
  const text = model.blocks.filter((b) => b.type === 'p').map((b) => b.runs.map((r) => r.text).join('')).join(' | ');
  console.log(`\n== page ${n}: size ${Math.round(model.width)}x${Math.round(model.height)} textChars=${chars} images=[${imgs.join(', ')}]`);
  console.log(`   method=${meta.method} confidence=${meta.confidence ?? '-'} words=${meta.words ?? '-'} blocks=${model.blocks.length} ${((performance.now() - t0) / 1000).toFixed(1)}s warnings=${JSON.stringify(meta.warnings)}`);
  console.log('   text:', text.slice(0, 260));
}
await terminateOcr();
process.exit(0);

// Shows how single pages come out with the AI engine (blocks, method, timing).
//   VISION_PROVIDER=ollama node scripts/ai-pages.mjs "<pdf>" 4,5
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPdf } from '../src/pipeline/page-extract.js';
import { processPage } from '../src/pipeline/process-page.js';

const [pdf, pagesArg = '1'] = process.argv.slice(2);
const doc = await openPdf(path.resolve(pdf));
const collected = [];
const workDir = mkdtempSync(path.join(os.tmpdir(), 'ai-pages-'));
for (const n of pagesArg.split(',').map(Number)) {
  const t0 = performance.now();
  const { model, meta } = await processPage(doc, n, { mode: 'smart', ocr: 'auto', language: 'ar', engine: 'ai', highlightUncertain: true, defaultDir: 'rtl' }, workDir);
  console.log(`\n=== page ${n}: ${meta.method}, ${((performance.now() - t0) / 1000).toFixed(1)} s, warnings: ${meta.warnings.join(' | ') || 'none'}`);
  for (const b of model.blocks) {
    if (b.type !== 'p') { console.log(`  [${b.type}]`); continue; }
    const text = b.runs.map((r) => r.text).join('');
    collected.push(text);
    console.log(`  (${b.align}, ${b.fs}pt) ${process.env.FULL ? text : text.slice(0, 110)}`);
  }
}
if (process.env.PAGES_OUT) (await import('node:fs')).writeFileSync(process.env.PAGES_OUT, collected.join(String.fromCharCode(10)));
process.exit(0);

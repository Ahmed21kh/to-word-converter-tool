// How single pages come out in "matches the printed edition" (printMatch) with the AI engine: method, warnings, page number, blocks.
//   node --env-file=.env scripts/print-pages.mjs "<pdf>" 202,220      (CARD=1: read as a cover or title page; ALTS=1: show the
//   words the reader was unsure of as {word|other readings}); a raised note mark is shown as ^(١)
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPdf } from '../src/pipeline/page-extract.js';
import { processPage } from '../src/pipeline/process-page.js';

const [pdf, pagesArg = '1'] = process.argv.slice(2);
const doc = await openPdf(path.resolve(pdf));
const workDir = mkdtempSync(path.join(os.tmpdir(), 'print-pages-'));
for (const n of pagesArg.split(',').map(Number)) {
  const t0 = performance.now();
  const { model, meta } = await processPage(doc, n, { mode: 'smart', ocr: 'auto', language: 'ar', engine: 'ai', printMatch: true, highlightUncertain: false, defaultDir: 'rtl', asCard: process.env.CARD === '1' }, workDir);
  console.log(`\n=== page ${n}: ${meta.method}, ${((performance.now() - t0) / 1000).toFixed(1)} s, pageNo ${JSON.stringify(model.pageNo || null)}, warnings: ${meta.warnings.join(' | ') || 'none'}`);
  for (const b of model.blocks) {
    if (b.type !== 'p') { console.log(`  [${b.type}${b.margin ? ' margin' : ''}]`); continue; }
    const tags = [b.align, `${b.fs}pt`, b.footnote && 'note', b.margin && 'margin', b.heading && `h${b.heading}`, b.runs[0]?.bold && 'bold', b.poem && 'poem'].filter(Boolean).join(',');
    console.log(`  (${tags}) ${b.runs.map((r) => (process.env.ALTS === '1' && r.lowConf ? `{${r.text.trim()}|${(r.alts || []).join('|')}} ` : r.sup ? `^${r.text}` : r.text)).join('')}`);
  }
}
process.exit(0);

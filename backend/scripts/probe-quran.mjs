// Show what the Quran guard changes on OCR'd pages:  node scripts/probe-quran.mjs <pdf> 9,10
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPdf } from '../src/pipeline/page-extract.js';
import { processPage } from '../src/pipeline/process-page.js';
import { guardParagraph } from '../src/pipeline/quran.js';
import { terminateOcr } from '../src/pipeline/ocr.js';

const [file, pagesArg] = process.argv.slice(2);
const workDir = path.join(os.tmpdir(), 'p2w-probe');
mkdirSync(workDir, { recursive: true });
const doc = await openPdf(path.resolve(file));
for (const n of pagesArg.split(',').map(Number)) {
  const { model } = await processPage(doc, n, { mode: 'smart', ocr: 'auto', language: 'ar', highlightUncertain: true, defaultDir: 'rtl' }, workDir);
  console.log(`\n===== page ${n}`);
  for (const par of model.blocks.filter((b) => b.type === 'p')) {
    const before = par.runs.map((r) => r.text).join('');
    const { findings } = guardParagraph(par);
    for (const f of findings) {
      console.log(`[${f.status}] ${f.ref ?? ''} sim=${f.similarity ?? ''} ${f.citationWarning ?? ''}`);
      console.log('   OCR  :', f.text.slice(0, 150));
      if (f.fixedTo) console.log('   FIXED:', f.fixedTo.slice(0, 150));
    }
  }
}
await terminateOcr();
process.exit(0);

// Run the full PDF pipeline without the HTTP layer:  node scripts/e2e-pdf.mjs <in.pdf> <out.docx> [mode]
import { convertPdf, normalizeOptions } from '../src/pipeline/convert-pdf.js';
import { WorkerPool } from '../src/services/pool.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
const [inFile, outFile, mode = 'smart'] = process.argv.slice(2);
const workDir = path.join(path.dirname(path.resolve(outFile)), 'work');
mkdirSync(workDir, { recursive: true });
const pool = new WorkerPool(Number(process.env.WORKERS || 2));
let last = '';
const report = await convertPdf({
  jobId: 'e2e', file: path.resolve(inFile), workDir, outPath: path.resolve(outFile), pool,
  options: normalizeOptions({ mode }), isCancelled: () => false,
  onProgress: (p) => { const s = `${p.phase} ${p.done}/${p.total}`; if (s !== last) { last = s; process.stdout.write(s + '\n'); } },
});
const { pageDetails, ...rest } = report;
console.log(JSON.stringify(rest, null, 1).slice(0, 3500));
console.log(pageDetails.map((p) => `${p.n}:${p.method}${p.warnings ? '!' : ''}`).join(' '));
await pool.close(); process.exit(0);

// node test/api-run.mjs <file> <out> [options-json]  - uploads to a running server, prints progress, downloads result
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [file, out, optStr = '{}'] = process.argv.slice(2);
const base = process.env.API || 'http://localhost:4010';
const form = new FormData();
form.append('file', new Blob([readFileSync(file)]), path.basename(file));
form.append('options', optStr);
const t0 = Date.now();
let job = await (await fetch(`${base}/api/convert`, { method: 'POST', body: form })).json();
if (!job.id) { console.log(job); process.exit(1); }
let last = '';
while (!['done', 'error', 'cancelled'].includes(job.status)) {
  await new Promise((r) => setTimeout(r, 2000));
  job = await (await fetch(`${base}/api/jobs/${job.id}`)).json();
  const s = `${job.status} ${job.phase} ${job.progress.done}/${job.progress.total} (${job.percent}%)`;
  if (s !== last) { last = s; console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', s); }
}
console.log('finished in', ((Date.now() - t0) / 1000).toFixed(1) + 's', job.status, job.error || '');
if (job.status === 'done') {
  writeFileSync(out, Buffer.from(await (await fetch(`${base}/api/jobs/${job.id}/download`)).arrayBuffer()));
  const rep = await (await fetch(`${base}/api/jobs/${job.id}/report`)).json();
  const { pageDetails, quran, ...rest } = rep;
  console.log(JSON.stringify({ ...rest, quran: { ...quran, items: quran.items.length + ' items' } }));
  writeFileSync(out + '.report.json', JSON.stringify(rep));
}

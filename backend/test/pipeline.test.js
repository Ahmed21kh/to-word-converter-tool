// Full pipeline regression test on the generated Arabic fixture (run `npm run fixtures` first).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { WorkerPool } from '../src/services/pool.js';
import { convertPdf, normalizeOptions } from '../src/pipeline/convert-pdf.js';

const fixture = fileURLToPath(new URL('./fixtures/arabic-sample.pdf', import.meta.url));
const quran = JSON.parse(readFileSync(new URL('../data/quran-uthmani.json', import.meta.url), 'utf8'));
const verse = (s, a) => quran.find((v) => v[0] === s && v[1] === a)[2];

/** Minimal zip reader for word/document.xml (stored or deflated entries). */
function readZipEntry(buf, name) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const entry = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (entry === name) {
      const lnlen = buf.readUInt16LE(off + 26);
      const lelen = buf.readUInt16LE(off + 28);
      const data = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error(`${name} not found`);
}

const textOfDocx = (file) => {
  const xml = readZipEntry(readFileSync(file), 'word/document.xml').toString('utf8');
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
};

let pool;
let dir;
before(() => {
  pool = new WorkerPool(2);
  dir = mkdtempSync(path.join(os.tmpdir(), 'p2w-'));
});
after(async () => {
  await pool.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Arabic PDF with Quran verses converts to a faithful, ordered docx', { skip: !existsSync(fixture) }, async () => {
  const outPath = path.join(dir, 'out.docx');
  const report = await convertPdf({
    jobId: 't', file: fixture, workDir: dir, outPath, pool,
    options: normalizeOptions({}), isCancelled: () => false, onProgress: () => {},
  });
  assert.equal(report.pages, 5);
  assert.equal(report.methods.text, 5, 'every page should use the text layer');
  assert.ok(report.quran.found >= 6);
  assert.equal(report.quran.unmatched, 0);

  const text = textOfDocx(outPath).normalize('NFD');
  assert.ok(text.includes(verse(2, 255).normalize('NFD')), 'Ayat al-Kursi must match the canonical text exactly');
  assert.ok(text.includes([1, 2, 3, 4].map((a) => verse(112, a)).join(' ').normalize('NFD')), 'Al-Ikhlas must match exactly');
  assert.ok(text.includes('الحمد لله رب العالمين'.normalize('NFD')), 'prose must not be reversed or letter-swapped');
  assert.ok(text.includes('أهمية العلم'.normalize('NFD')));
  assert.ok(!text.includes('\uFFFD'), 'no undecodable glyphs may remain');
  // pages stay in order
  const i1 = text.indexOf('الفصل 1');
  const i2 = text.indexOf('الفصل 2');
  const i3 = text.indexOf('الفصل 3');
  assert.ok(i1 >= 0 && i1 < i2 && i2 < i3, 'chapters must appear in page order');
});

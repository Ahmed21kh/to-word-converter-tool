// Pausing a conversion: no page starts while it is paused, and pages already converted are not read again when it goes on
// (also after a server restart, which runs the conversion again on the same work folder).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerPool } from '../src/services/pool.js';
import { convertPdf, normalizeOptions } from '../src/pipeline/convert-pdf.js';

const fixture = fileURLToPath(new URL('./fixtures/arabic-sample.pdf', import.meta.url));

test('a paused conversion starts no page until it goes on; running it again reuses the pages it has', async () => {
  const pool = new WorkerPool();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p2w-pause-'));
  try {
    let pages = 0;
    const counting = { run: (task, o) => { if (task.type === 'page') pages++; return pool.run(task, o); }, broadcast: (m) => pool.broadcast(m) };
    let paused = true;
    let release;
    const gate = new Promise((r) => { release = r; });
    const ctx = (out) => ({
      jobId: 'pause-test', file: fixture, workDir: path.join(dir, 'work'), outPath: path.join(dir, out), options: normalizeOptions({}),
      pool: counting, onProgress: () => {}, isCancelled: () => false, waitIfPaused: () => (paused ? gate : null),
    });

    const running = convertPdf(ctx('a.docx'));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(pages, 0, 'nothing is read while paused');
    paused = false;
    release();
    await running;
    assert.equal(pages, 5);
    assert.equal(readdirSync(path.join(dir, 'work', 'pages')).length, 5, 'every page is kept');

    pages = 0;
    await convertPdf(ctx('b.docx'));
    assert.equal(pages, 0, 'the kept pages are not read again');
    assert.ok(existsSync(path.join(dir, 'b.docx')));
  } finally {
    await pool.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

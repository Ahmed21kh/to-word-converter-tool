// Plain text (.txt/.md/.csv) -> Word. Direction is detected per paragraph; Word paginates.
import { readFile, writeFile } from 'node:fs/promises';
import { buildDocx } from './docx-builder.js';
import { runQuranGuard, buildReport } from './convert-pdf.js';
import { dominantDirection } from './arabic.js';
import { savePreview } from './preview.js';

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes(String.fromCharCode(0xfffd))) return utf8;
  try {
    return new TextDecoder('windows-1256').decode(buf); // legacy Arabic files
  } catch {
    return utf8;
  }
}

export async function convertText(ctx) {
  const { file, outPath, options, onProgress } = ctx;
  const t0 = Date.now();
  onProgress({ phase: 'converting', done: 0, total: 1 });
  const text = decode(await readFile(file)).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = [];
  for (const chunk of text.split(/\n{2,}/)) {
    const lines = chunk.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    // single line breaks stay separate paragraphs (poetry, lists)
    for (const line of lines) {
      blocks.push({
        type: 'p',
        runs: [{ text: line.trim(), fs: 14, bold: false, italic: false }],
        dir: dominantDirection(line) || (options.language === 'en' ? 'ltr' : 'rtl'),
        align: 'start',
        fs: 14,
        lineCount: 1,
        lineGap: null,
      });
    }
  }
  const pageDir = dominantDirection(text) || 'rtl';
  const model = { n: 1, width: 595.3, height: 841.9, blocks, margins: { top: 72, bottom: 72, left: 72, right: 72 }, method: 'text', flow: true };
  const results = [{ model, meta: { n: 1, method: 'text', chars: text.length, warnings: [], unmapped: 0, pageDir } }];
  onProgress({ phase: 'verifying', done: 1, total: 1 });
  const quran = runQuranGuard(results, options.quran);
  onProgress({ phase: 'building', done: 1, total: 1 });
  if (ctx.previewDir) await savePreview([model], ctx.previewDir, { name: ctx.title });
  const buffer = await buildDocx([model], { ...options, detectHeadings: false, pageDir, title: ctx.title });
  await writeFile(outPath, buffer);
  return buildReport({ results, quran, total: 1, startedAt: t0, bytes: buffer.length });
}

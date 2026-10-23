// Image files (JPG/PNG/WebP/TIFF/BMP/GIF) -> Word via OCR, or the picture itself in "exact" mode.
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { recognize } from './ocr.js';
import { contentBox } from './page-extract.js';
import { buildDocx } from './docx-builder.js';
import { runQuranGuard, buildReport } from './convert-pdf.js';
import { dominantDirection } from './arabic.js';
import { savePreview } from './preview.js';

const MAX_PAGE_PT = 1400;

async function pageModel(file, n, options, workDir) {
  const src = () => sharp(file, { pages: 1, page: n - 1 });
  const meta = await src().metadata();
  let dpi = meta.density && meta.density >= 72 ? meta.density : 200;
  let img = src().rotate();
  let wPx = meta.width;
  let hPx = meta.height;
  // small images OCR much better when enlarged
  if (wPx < 1400) {
    const k = Math.min(3, 1800 / wPx);
    img = img.resize(Math.round(wPx * k), Math.round(hPx * k), { kernel: 'lanczos3' });
    wPx = Math.round(wPx * k);
    hPx = Math.round(hPx * k);
    dpi *= k;
  }
  const png = await img.png().toBuffer();
  let wPt = (wPx / dpi) * 72;
  let hPt = (hPx / dpi) * 72;
  const shrink = Math.min(1, MAX_PAGE_PT / Math.max(wPt, hPt));
  wPt *= shrink;
  hPt *= shrink;
  const effDpi = wPx / (wPt / 72);

  const info = { n, method: 'ocr', warnings: [], unmapped: 0 };
  if (options.mode === 'exact') {
    const out = path.join(workDir, `img${n}.png`);
    await writeFile(out, png);
    const block = {
      type: 'image', file: out, imgType: 'png', wPt: wPt - 20, hPt: hPt - 20,
      bbox: { x0: 10, y0: 10, x1: wPt - 10, y1: hPt - 10 }, fullPage: true,
    };
    return {
      model: { n, width: wPt, height: hPt, blocks: [block], margins: { top: 10, bottom: 10, left: 10, right: 10 }, method: 'image' },
      meta: { ...info, method: 'image' },
    };
  }
  const res = await recognize(png, {
    lang: options.language === 'en' ? 'eng' : 'ara+eng',
    dpi: effDpi,
    lowConfidence: options.highlightUncertain ? 60 : -1,
  });
  const paras = res.paragraphs;
  const text = paras.map((p) => p.runs.map((r) => r.text).join('')).join(' ');
  if (res.words < 1) info.warnings.push('no-text-recognised');
  return {
    model: { n, width: wPt, height: hPt, blocks: paras, margins: contentBox(paras, wPt, hPt), method: 'ocr' },
    meta: {
      ...info,
      chars: text.length,
      confidence: Number(res.confidence.toFixed(1)),
      lowConfidenceWords: res.lowConfidenceWords,
      words: res.words,
      pageDir: dominantDirection(text) || 'rtl',
    },
  };
}

export async function convertImage(ctx) {
  const { file, workDir, outPath, options, onProgress, isCancelled } = ctx;
  const t0 = Date.now();
  const meta = await sharp(file).metadata();
  const total = Math.min(meta.pages || 1, 500);
  const results = [];
  for (let n = 1; n <= total; n++) {
    if (isCancelled()) throw new Error('cancelled');
    onProgress({ phase: 'converting', done: n - 1, total });
    results.push(await pageModel(file, n, options, workDir));
  }
  onProgress({ phase: 'verifying', done: total, total });
  const quran = runQuranGuard(results, options.quran);
  onProgress({ phase: 'building', done: total, total });
  const dirs = results.map((r) => r.meta.pageDir).filter(Boolean);
  const pageDir = dirs.length && dirs.filter((d) => d === 'rtl').length >= dirs.length / 2 ? 'rtl' : 'ltr';
  if (ctx.previewDir) await savePreview(results.map((r) => r.model), ctx.previewDir, { name: ctx.title });
  const buffer = await buildDocx(results.map((r) => r.model), { ...options, pageDir, title: ctx.title });
  await writeFile(outPath, buffer);
  return buildReport({ results, quran, total, startedAt: t0, bytes: buffer.length });
}

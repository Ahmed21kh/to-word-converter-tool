// Image files (JPG/PNG/WebP/TIFF/BMP/GIF, a page photographed with a phone) -> Word via OCR or the AI reader (engine ai, as for
// a scanned PDF page), or the picture itself in "exact" mode.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { recognize } from './ocr.js';
import { ocrLang, FLOW_MARGINS } from './process-page.js';
import { prepareForOcr, frameBands, crop, enhanceForAi, straighten, eraseStamp } from './scan-clean.js';
import { visionStatus, readPageWithAi, paragraphsToBlocks } from './vision-ocr.js';
import { contentBox } from './page-extract.js';
import { buildDocx } from './docx-builder.js';
import { runQuranGuard, buildReport } from './convert-pdf.js';
import { dominantDirection } from './arabic.js';
import { savePreview } from './preview.js';

const MAX_PAGE_PT = 1400;

/**
 * The picture as the AI reads it: at most 2600 px on its longer side, inside its frame, paper evened and lines straight, without
 * an uploader's stamp in its corner.
 */
async function aiView(png, language) {
  const { data, info: px } = await sharp(png).resize({ width: 2600, height: 2600, fit: 'inside', withoutEnlargement: true })
    .grayscale().raw().toBuffer({ resolveWithObject: true });
  const gray = new Uint8Array(data.buffer, data.byteOffset, data.length);
  const bands = frameBands(gray, px.width, px.height);
  const body = bands ? crop(gray, px.width, px.height, bands.body) : { gray, width: px.width, height: px.height };
  const straight = (await straighten(body.gray, body.width, body.height)).gray;
  if (language !== 'en') eraseStamp(straight, body.width, body.height);
  return { width: px.width, body, straight };
}

/**
 * The picture read by the AI: a page in flow layout, or null when the AI declined, found no text or failed (the standard OCR
 * reads it then).
 */
async function aiPage(view, n, options, wPt, hPt, info) {
  const { width, body, straight } = await view();
  const ptPerPx = wPt / width;
  try {
    const ai = await readPageWithAi(await enhanceForAi(straight, body.width, body.height, { straight: true }), { arabicOnly: options.language === 'ar', ptPerPx, font: options.arabicFont, probs: !!options.highlightUncertain });
    if (ai.refused) info.warnings.push('ai-declined-used-standard-ocr');
    if (ai.refused || ai.noText) return null;
    if (ai.tried?.length) info.warnings.push(`ai-fallback:${ai.via}`);
    if (ai.truncated) info.warnings.push('ai-output-truncated');
    const blocks = paragraphsToBlocks(ai.paragraphs, { bodyPt: ai.bodyPt, ptPerPx, lineGapPt: ai.lineGapPt, footRatio: ai.footRatio });
    const texts = blocks.map((b) => b.runs.map((r) => r.text).join(''));
    return {
      model: { n, width: wPt, height: hPt, blocks, margins: { ...FLOW_MARGINS }, method: 'ai', flow: true },
      meta: {
        ...info,
        method: 'ai',
        chars: texts.reduce((s, t) => s + t.length, 0),
        pageDir: dominantDirection(texts.join(' ')) || 'rtl',
        aiModel: ai.model,
        aiTokens: { input: ai.usage?.input_tokens || 0, output: ai.usage?.output_tokens || 0, cached: ai.usage?.cached_tokens || 0 },
        ...(ai.via ? { aiVia: ai.via } : {}),
      },
    };
  } catch (err) {
    info.warnings.push(`ai-failed-used-standard-ocr:${String(err.message).slice(0, 90)}`);
    return null;
  }
}

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
  if (options.engine === 'ai' && visionStatus().available) {
    const read = await aiPage(() => aiView(png, options.language), n, options, wPt, hPt, info);
    if (read) return read;
  }
  // crop the decorative frame, drop diacritics on vowelled pages, normalise the text size
  const grayRaw = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
  if (options.language !== 'en') eraseStamp(grayRaw.data, grayRaw.info.width, grayRaw.info.height);
  const prep = options.language === 'en'
    ? { gray: new Uint8Array(grayRaw.data), width: grayRaw.info.width, height: grayRaw.info.height, geometry: {}, info: {} }
    : await prepareForOcr(new Uint8Array(grayRaw.data), grayRaw.info.width, grayRaw.info.height, {});
  const prepared = await sharp(Buffer.from(prep.gray.buffer, prep.gray.byteOffset, prep.gray.length), { raw: { width: prep.width, height: prep.height, channels: 1 } }).png().toBuffer();
  const res = await recognize(prepared, {
    lang: ocrLang(options.language),
    dpi: effDpi,
    lowConfidence: options.highlightUncertain ? 60 : -1,
    geometry: prep.geometry,
    prepared: true,
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
  if (ctx.previewDir) await mkdir(ctx.previewDir, { recursive: true });
  for (let n = 1; n <= total; n++) {
    if (isCancelled()) throw new Error('cancelled');
    onProgress({ phase: 'converting', done: n - 1, total });
    results.push(await pageModel(file, n, options, workDir));
    ctx.onPage?.(results[results.length - 1].meta); // the job log: how the picture was read
    // the picture as given, small, for the preview beside the converted page
    if (ctx.previewDir) {
      await sharp(file, { page: n - 1 }).rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' })
        .jpeg({ quality: 75 }).toFile(path.join(ctx.previewDir, `src-${n}.jpg`)).catch(() => {});
    }
  }
  onProgress({ phase: 'verifying', done: total, total });
  const quran = runQuranGuard(results, options.quran);
  onProgress({ phase: 'building', done: total, total });
  const dirs = results.map((r) => r.meta.pageDir).filter(Boolean);
  const pageDir = dirs.length && dirs.filter((d) => d === 'rtl').length >= dirs.length / 2 ? 'rtl' : 'ltr';
  if (ctx.previewDir) await savePreview(results.map((r) => r.model), ctx.previewDir, { name: ctx.title, source: true });
  const buffer = await buildDocx(results.map((r) => r.model), { ...options, pageDir, title: ctx.title });
  await writeFile(outPath, buffer);
  return buildReport({ results, quran, total, startedAt: t0, bytes: buffer.length });
}

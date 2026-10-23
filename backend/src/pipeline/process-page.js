// Decides, for one PDF page, how to turn it into a page model:
//   text layer -> (quality check) -> OCR fallback -> picture fallback.
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  rawPage, buildTextPage, finalizeBlocks, renderPage, pageText, contentBox,
} from './page-extract.js';
import { textQuality, UNMAPPED, dominantDirection } from './arabic.js';
import { recognize } from './ocr.js';

const OCR_DPI = 300;

function ocrLang(language) {
  if (language === 'en') return 'eng';
  return 'ara+eng';
}

const countUnmapped = (text) => (text.match(new RegExp(UNMAPPED, 'g')) || []).length;

async function pagePicture(page, workDir, n, dpi, quality = 85) {
  const { canvas, scale } = await renderPage(page, dpi, 3000);
  const file = path.join(workDir, `p${n}_full.jpg`);
  await writeFile(file, canvas.toBuffer('image/jpeg', quality));
  const vp = page.getViewport({ scale: 1 });
  return { file, imgType: 'jpg', wPt: vp.width, hPt: vp.height, scale };
}

async function ocrModel(page, n, opts, raw) {
  const { canvas } = await renderPage(page, OCR_DPI, 4200);
  const vp = page.getViewport({ scale: 1 });
  const effDpi = (canvas.width / vp.width) * 72;
  const res = await recognize(canvas.toBuffer('image/png'), {
    lang: ocrLang(opts.language),
    dpi: effDpi,
    lowConfidence: opts.highlightUncertain ? 60 : -1,
  });
  void raw;
  return { paras: res.paragraphs, res, body: res.body };
}

const pageSizeMeta = (page) => {
  const vp = page.getViewport({ scale: 1 });
  return { width: vp.width, height: vp.height };
};

/**
 * @returns {{model:{blocks,margins,width,height,method}, meta:object}}
 */
export async function processPage(doc, n, opts, workDir) {
  const page = await doc.getPage(n);
  const { width, height } = pageSizeMeta(page);
  const meta = { n, method: 'blank', chars: 0, warnings: [], unmapped: 0 };
  const finish = (blocks, method, extra = {}) => {
    Object.assign(meta, { method }, extra);
    return { model: { n, width, height, blocks, margins: contentBox(blocks, width, height), method }, meta };
  };

  try {
    // ---- exact mode: the page as a picture ------------------------------------------------
    if (opts.mode === 'exact') {
      const pic = await pagePicture(page, workDir, n, 170, 88);
      const block = { type: 'image', ...pic, bbox: { x0: 10, y0: 10, x1: width - 10, y1: height - 10 }, fullPage: true };
      const m = finish([block], 'image');
      m.model.margins = { top: 10, bottom: 10, left: 10, right: 10 };
      return m;
    }

    const raw = await rawPage(page);
    const textChars = raw.items.reduce((s, i) => s + i.str.replace(/\s/g, '').length, 0);
    const hasText = textChars >= 8 && opts.mode !== 'ocr';
    const imgArea = raw.images.reduce((s, i) => s + (i.x1 - i.x0) * (i.y1 - i.y0), 0);
    const coverage = imgArea / (width * height);

    let textResult = null;
    if (hasText) {
      const m = buildTextPage(raw, { defaultDir: opts.defaultDir, reverseHint: opts.reverseHint ?? null });
      await finalizeBlocks(page, raw, m, { workDir, pageNum: n });
      const text = pageText(m);
      const q = textQuality(text);
      const unmapped = countUnmapped(text);
      const unmappedRatio = unmapped / Math.max(1, m.stats.chars);
      textResult = { m, q, unmapped, unmappedRatio, text };
      const good = q.ok && unmappedRatio < 0.03;
      if (good || opts.ocr === 'never') {
        if (!good) meta.warnings.push(`text-layer-quality:${q.issues.join(',') || 'unmapped-glyphs'}`);
        return finish(m.blocks, 'text', {
          chars: m.stats.chars,
          quality: Number(q.score.toFixed(2)),
          reversedFixed: m.stats.reversedFixed,
          reversalEvidence: m.stats.reversalEvidence,
          tables: m.stats.tables,
          columns: m.stats.columns,
          images: m.blocks.filter((b) => b.type === 'image').length,
          unmapped,
          pageDir: m.pageDir,
          fsBody: m.fsBody,
        });
      }
    }

    // ---- OCR path ---------------------------------------------------------------------
    const wantOcr = opts.ocr !== 'never' && (opts.mode === 'ocr' || !hasText || textResult);
    if (wantOcr && (opts.mode === 'ocr' || textResult || textChars < 8 ? true : coverage > 0.3)) {
      const { paras, res } = await ocrModel(page, n, opts, raw);
      const enough = res.words >= 3 && res.confidence >= (textResult ? 55 : 30);
      if (enough) {
        return finish(paras, 'ocr', {
          chars: paras.reduce((s, p) => s + p.runs.reduce((a, r) => a + r.text.length, 0), 0),
          confidence: Number(res.confidence.toFixed(1)),
          lowConfidenceWords: res.lowConfidenceWords,
          words: res.words,
          pageDir: dominantDirection(paras.map((p) => p.runs.map((r) => r.text).join('')).join(' ')) || 'rtl',
          fallbackReason: textResult ? `text layer unreliable (${textResult.q.issues.join(',') || 'unmapped glyphs'})` : (opts.mode === 'ocr' ? 'forced' : 'no text layer'),
          unmapped: 0,
        });
      }
      if (textResult) {
        meta.warnings.push('text-layer-unreliable-and-ocr-weak');
        return finish(textResult.m.blocks, 'text', {
          chars: textResult.m.stats.chars,
          quality: Number(textResult.q.score.toFixed(2)),
          unmapped: textResult.unmapped,
          pageDir: textResult.m.pageDir,
          fsBody: textResult.m.fsBody,
        });
      }
      // nothing readable: if the page carries pictures, keep it as a picture
      if (coverage > 0.05 || raw.images.length) {
        const pic = await pagePicture(page, workDir, n, 170, 88);
        meta.warnings.push('no-readable-text-kept-as-image');
        const block = { type: 'image', ...pic, bbox: { x0: 10, y0: 10, x1: width - 10, y1: height - 10 }, fullPage: true };
        const r = finish([block], 'image');
        r.model.margins = { top: 10, bottom: 10, left: 10, right: 10 };
        return r;
      }
    } else if (!hasText && raw.images.length) {
      // OCR disabled: keep pictures
      const pic = await pagePicture(page, workDir, n, 170, 88);
      const block = { type: 'image', ...pic, bbox: { x0: 10, y0: 10, x1: width - 10, y1: height - 10 }, fullPage: true };
      const r = finish([block], 'image');
      r.model.margins = { top: 10, bottom: 10, left: 10, right: 10 };
      return r;
    }
    return finish([], 'blank');
  } catch (err) {
    meta.warnings.push(`page-error:${err.message}`);
    meta.error = err.message;
    return { model: { n, width, height, blocks: [], margins: { top: 36, bottom: 36, left: 36, right: 36 }, method: 'error' }, meta: { ...meta, method: 'error' } };
  } finally {
    page.cleanup?.();
  }
}

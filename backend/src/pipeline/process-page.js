// Decides, for one PDF page, how to turn it into a page model:
//   text layer -> (quality check) -> OCR fallback -> picture fallback.
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  rawPage, buildTextPage, finalizeBlocks, renderPage, pageText, contentBox,
} from './page-extract.js';
import { textQuality, UNMAPPED, dominantDirection } from './arabic.js';
import { recognize } from './ocr.js';
import { prepareForOcr, rgbaToGray, frameBands, crop, enhanceForAi } from './scan-clean.js';
import { visionStatus, readPageWithAi, paragraphsToBlocks } from './vision-ocr.js';
import { segmentLines } from './text-lines.js';

const OCR_DPI = 300;

/**
 * How much running text a page has, measured cheaply (100 dpi, nothing is read): its text lines, how many of them fill the
 * width of the text block, and how much of it is in colour. A page of a book's body is black on white with many full lines; a
 * cover is in colour (its ornaments can look like lines), a title page or the basmala has few lines.
 */
export async function probePage(doc, n) {
  const page = await doc.getPage(n);
  const { canvas } = await renderPage(page, 100, 1400);
  const W = canvas.width;
  const H = canvas.height;
  const rgba = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  let colored = 0;
  let sampled = 0;
  for (let i = 0; i < rgba.length; i += 4 * 7) { // every 7th pixel
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    sampled++;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colored++;
  }
  const gray = rgbaToGray(rgba, W, H);
  const bands = frameBands(gray, W, H);
  const body = bands ? crop(gray, W, H, bands.body) : { gray, width: W, height: H };
  const boxes = segmentLines(body.gray, body.width, body.height);
  const widest = Math.max(0, ...boxes.map((b) => b.x1 - b.x0));
  const full = widest >= body.width * 0.5 ? boxes.filter((b) => b.x1 - b.x0 >= widest * 0.85).length : 0;
  return { lines: boxes.length, full, color: colored / Math.max(1, sampled) };
}

/**
 * 'ar' = Arabic model only (clearly the most accurate on Arabic books: the English model makes it
 * mistake letters), 'mixed' = Arabic + English for documents with real English passages.
 */
export function ocrLang(language) {
  if (language === 'en') return 'eng';
  if (language === 'mixed') return 'ara+eng';
  return 'ara';
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
  const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const gray = rgbaToGray(rgba, canvas.width, canvas.height);
  // crop the decorative frame, drop diacritics on vowelled pages, normalise the text size
  const prep = opts.language === 'en'
    ? { gray, width: canvas.width, height: canvas.height, geometry: {}, info: { cropped: false } }
    : await prepareForOcr(gray, canvas.width, canvas.height, {});
  const { default: sharp } = await import('sharp');
  const png = await sharp(Buffer.from(prep.gray.buffer, prep.gray.byteOffset, prep.gray.length), {
    raw: { width: prep.width, height: prep.height, channels: 1 },
  }).png().toBuffer();
  const res = await recognize(png, {
    lang: ocrLang(opts.language),
    dpi: effDpi,
    lowConfidence: opts.highlightUncertain ? 60 : -1,
    geometry: prep.geometry,
    prepared: true,
  });
  void raw;
  return { paras: res.paragraphs, res, body: res.body, prep: prep.info };
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
    const { flow, ...metaExtra } = extra;
    Object.assign(meta, { method }, metaExtra);
    const model = { n, width, height, blocks, margins: contentBox(blocks, width, height), method };
    if (flow) { // text without coordinates (AI reading): let Word flow it inside regular margins
      model.flow = true;
      model.margins = { top: 36, bottom: 30, left: 42, right: 42 };
    }
    return { model, meta };
  };

  try {
    // ---- exact mode, or a book's cover / title page: the page as a picture ------------------
    if (opts.mode === 'exact' || opts.asPicture) {
      if (opts.asPicture) meta.warnings.push('front-matter-picture');
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
      if (opts.engine === 'ai' && visionStatus().available) {
        try {
          const { canvas } = await renderPage(page, Number(process.env.VISION_IMAGE_DPI) || 200, 2600);
          // A framed book page: the model reads only what is inside the frame (enhanced: even paper tone, strong contrast,
          // slightly sharpened). The header / footer strips outside the frame (running title, page number, the drawn
          // line) are not read at all: they are cut out of the page and placed back as pictures, exactly as printed.
          const W = canvas.width;
          const H = canvas.height;
          const gray = rgbaToGray(canvas.getContext('2d').getImageData(0, 0, W, H).data, W, H);
          const bands = frameBands(gray, W, H);
          const body = bands ? crop(gray, W, H, bands.body) : { gray, width: W, height: H };
          const ai = await readPageWithAi(await enhanceForAi(body.gray, body.width, body.height), { arabicOnly: opts.language === 'ar', ptPerPx: width / W, font: opts.arabicFont, probs: !!opts.highlightUncertain });
          if (ai.refused) meta.warnings.push('ai-declined-used-standard-ocr');
          else if (ai.noText) {
            // cover art / ornaments: keep the picture
            const pic = await pagePicture(page, workDir, n, 170, 88);
            const block = { type: 'image', ...pic, bbox: { x0: 10, y0: 10, x1: width - 10, y1: height - 10 }, fullPage: true };
            const r = finish([block], 'image');
            r.model.margins = { top: 10, bottom: 10, left: 10, right: 10 };
            return r;
          } else {
            const blocks = paragraphsToBlocks(ai.paragraphs, { bodyPt: ai.bodyPt, ptPerPx: width / W, lineGapPt: ai.lineGapPt, footRatio: ai.footRatio });
            // page number / running title / drawn line: kept as pictures in their place (top strip first, footer last)
            const strips = [];
            for (const [box, atTop] of [[bands?.top, true], [bands?.bottom, false]]) {
              if (!box) continue;
              const c = crop(gray, W, H, box);
              const { default: sharp } = await import('sharp');
              const file = path.join(workDir, `p${n}_margin_${atTop ? 'top' : 'bottom'}.png`);
              await writeFile(file, await sharp(Buffer.from(c.gray.buffer, c.gray.byteOffset, c.gray.length), { raw: { width: c.width, height: c.height, channels: 1 } }).png().toBuffer());
              const wPt = (c.width / W) * width;
              const hPt = (c.height / H) * height;
              strips.push({ atTop, block: { type: 'image', file, imgType: 'png', wPt, hPt, bbox: { x0: 0, y0: 0, x1: wPt, y1: hPt }, margin: true } });
            }
            // a page without a frame: its running header (title, rule, page number) was found in the text lines
            if (!bands && ai.headerBox) {
              const pad = Math.round(H * 0.004);
              const c = crop(gray, W, H, { x0: 0, x1: W, y0: Math.max(0, ai.headerBox.y0 - pad), y1: Math.min(H, ai.headerBox.y1 + pad) });
              const { default: sharp } = await import('sharp');
              const file = path.join(workDir, `p${n}_margin_top.png`);
              await writeFile(file, await sharp(Buffer.from(c.gray.buffer, c.gray.byteOffset, c.gray.length), { raw: { width: c.width, height: c.height, channels: 1 } }).png().toBuffer());
              const wPt = (c.width / W) * width;
              const hPt = (c.height / H) * height;
              strips.push({ atTop: true, block: { type: 'image', file, imgType: 'png', wPt, hPt, bbox: { x0: 0, y0: 0, x1: wPt, y1: hPt }, margin: true } });
            }
            for (const s of strips) { if (s.atTop) blocks.unshift(s.block); else blocks.push(s.block); }
            if (ai.truncated) meta.warnings.push('ai-output-truncated');
            const texts = blocks.filter((b) => b.type === 'p').map((b) => b.runs.map((r) => r.text).join(''));
            const aiPage = finish(blocks, 'ai', {
              chars: texts.reduce((sum, t) => sum + t.length, 0),
              words: texts.reduce((sum, t) => sum + t.split(' ').length, 0),
              pageDir: dominantDirection(texts.join(' ')) || 'rtl',
              aiModel: ai.model,
              aiTokens: { input: ai.usage?.input_tokens || 0, output: ai.usage?.output_tokens || 0 },
              flow: true,
              unmapped: 0,
            });
            // the text block sits where it sat on the printed page
            if (ai.textBox) {
              const ptPerPx = width / W;
              const offX = bands ? bands.body.x0 : 0;
              const clamp = (v) => Math.min(width * 0.3, Math.max(18, v));
              aiPage.model.margins = { ...aiPage.model.margins, left: clamp((offX + ai.textBox.x0) * ptPerPx), right: clamp(width - (offX + ai.textBox.x1) * ptPerPx) };
            }
            return aiPage;
          }
        } catch (err) {
          meta.warnings.push(`ai-failed-used-standard-ocr:${String(err.message).slice(0, 90)}`);
        }
      }
      const { paras, res, prep } = await ocrModel(page, n, opts, raw);
      // Real text pages score 55-70 after cleaning; decorative covers, calligraphy and ornaments score far lower
      // and must stay pictures instead of becoming nonsense text.
      const enough = res.words >= 3 && res.confidence >= (textResult ? 55 : 52);
      if (enough) {
        return finish(paras, 'ocr', {
          chars: paras.reduce((s, p) => s + p.runs.reduce((a, r) => a + r.text.length, 0), 0),
          confidence: Number(res.confidence.toFixed(1)),
          lowConfidenceWords: res.lowConfidenceWords,
          words: res.words,
          droppedLines: res.droppedLines || undefined,
          diacriticsStripped: prep?.diacriticsStripped || undefined,
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
    try { // never leave a blank page: keep the original look as a picture
      const pic = await pagePicture(page, workDir, n, 150, 85);
      const block = { type: 'image', ...pic, bbox: { x0: 10, y0: 10, x1: width - 10, y1: height - 10 }, fullPage: true };
      return { model: { n, width, height, blocks: [block], margins: { top: 10, bottom: 10, left: 10, right: 10 }, method: 'image' }, meta: { ...meta, method: 'image' } };
    } catch { /* fall through to the empty page below */ }
    return { model: { n, width, height, blocks: [], margins: { top: 36, bottom: 36, left: 36, right: 36 }, method: 'error' }, meta: { ...meta, method: 'error' } };
  } finally {
    page.cleanup?.();
  }
}

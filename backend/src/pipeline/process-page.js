// Decides, for one PDF page, how to turn it into a page model:
//   text layer -> (quality check) -> OCR fallback -> picture fallback.
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  rawPage, buildTextPage, finalizeBlocks, renderPage, pageText, contentBox,
} from './page-extract.js';
import { textQuality, UNMAPPED, dominantDirection } from './arabic.js';
import { recognize } from './ocr.js';
import { prepareForOcr, rgbaToGray, frameBands, crop, enhanceForAi, eraseRules, inkFromGround } from './scan-clean.js';
import { visionStatus, readPageWithAi, paragraphsToBlocks, fixBasmala } from './vision-ocr.js';
import { readHead } from './running-head.js';
import { matchKey, rasmKey } from './quran.js';
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
  const heights = boxes.map((b) => b.y1 - b.y0).sort((x, y) => x - y);
  return { lines: boxes.length, full, color: colored / Math.max(1, sampled), lineH: heights.length ? heights[heights.length >> 1] : 0 };
}

/** The page as printed, small: shown in the preview beside the converted page. */
export async function sourcePicture(doc, n, out) {
  const { canvas } = await renderPage(await doc.getPage(n), 110, 1400);
  await writeFile(out, canvas.toBuffer('image/jpeg', 75));
  return true;
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

async function ocrModel(page, n, opts, raw, blank = () => {}) {
  const { canvas } = await renderPage(page, OCR_DPI, 4200);
  blank(canvas);
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

/**
 * Whether a paragraph read from a page picture is only the page's text overlay over again (`overlay`: the text layer's own text):
 * two words or more, seven in ten of them overlay words (compared by letter shapes, dots aside), or no letter at all.
 */
export function overlayTest(overlay) {
  const keyOf = (w) => rasmKey(matchKey(w));
  const words = new Set(String(overlay).split(/\s+/).map(keyOf).filter((k) => k.length >= 2));
  return (text) => {
    if (!/\p{L}/u.test(text)) return true;
    const ws = String(text).split(/\s+/).map(keyOf).filter((k) => k.length >= 2);
    return ws.length >= 2 && ws.filter((k) => words.has(k)).length >= ws.length * 0.7;
  };
}

const FLOW_MARGINS = { top: 36, bottom: 30, left: 42, right: 42 };

/**
 * "Matches the printed edition" keeps no pictures (Shamela does not take them): a cover or title page is read as text and its
 * lines are set centred inside a bordered box, the way Shamela shows a book's card. Null when the page has no text.
 * A cloud model gets the page in colour as it is. The local line reader looks for dark ink on light paper, one line at a time: a
 * dark cover (light letters) is inverted, and the frame and the rules around the text are taken away, or the frame's sides would
 * join every line of the page into one. Latin letters are kept here (the ISBN, a web address).
 */
async function readCard(page, opts, width) {
  const { canvas } = await renderPage(page, Number(process.env.VISION_IMAGE_DPI) || 200, 2600);
  const W = canvas.width;
  const H = canvas.height;
  let jpeg;
  if (visionStatus().external) jpeg = canvas.toBuffer('image/jpeg', 90);
  else {
    // the lettering dark on white, whatever the colours of the cover (light letters on a dark ground included)
    const gray = inkFromGround(rgbaToGray(canvas.getContext('2d').getImageData(0, 0, W, H).data, W, H), W, H);
    const bands = frameBands(gray, W, H);
    const body = bands ? crop(gray, W, H, bands.body) : { gray, width: W, height: H };
    jpeg = await enhanceForAi(eraseRules(body.gray, body.width, body.height), body.width, body.height);
  }
  // how sure the reader is of each word tells a line it could read from calligraphy it guessed at (settleCards)
  const ai = await readPageWithAi(jpeg, { arabicOnly: false, ptPerPx: width / W, font: opts.arabicFont, card: true, probs: true, batch: opts.batch, cache: opts.aiCache });
  // a line with no Arabic letter, no digit and no address is the reader talking ("I've been"), not the page
  ai.paragraphs = ai.paragraphs.filter((p) => /[؀-ۿ0-9]|@|www\.|https?:/.test(p.text));
  if (ai.refused || ai.noText || !ai.paragraphs.length) return null;
  // a page that holds only the basmala: drawn in calligraphy, the reader gets only "بسم الله" right
  if (ai.paragraphs.length === 1) fixBasmala(ai.paragraphs, { minSim: 0.25, alone: true });
  const paras = paragraphsToBlocks(ai.paragraphs, { bodyPt: ai.bodyPt }).map((p) => ({ ...p, align: 'center', firstLine: 0, ruleAbove: false, footnote: false }));
  const boxW = (width - FLOW_MARGINS.left - FLOW_MARGINS.right) * 0.9;
  const table = {
    type: 'table', card: true, rtl: true, nR: 1, nC: 1, colWidths: [boxW], rowHeights: [0],
    cells: [{ r: 0, c: 0, rowspan: 1, colspan: 1, paras }],
    bbox: { x0: 0, y0: 0, x1: boxW, y1: 0 },
  };
  return { blocks: [table], usage: ai.usage, model: ai.model };
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
      model.margins = { ...FLOW_MARGINS };
    }
    return { model, meta };
  };
  // printMatch: the cover / title page as text in a box; a page without any text stays an empty page (never a picture)
  const card = async () => {
    const c = await readCard(page, opts, width);
    if (!c) {
      meta.warnings.push('front-matter-no-text');
      return finish([], 'blank');
    }
    meta.warnings.push('front-matter-card');
    return finish(c.blocks, 'ai', {
      chars: c.blocks[0].cells[0].paras.reduce((s, p) => s + p.runs.reduce((a, r) => a + r.text.length, 0), 0),
      pageDir: 'rtl',
      aiModel: c.model,
      aiTokens: { input: c.usage?.input_tokens || 0, output: c.usage?.output_tokens || 0 },
      flow: true,
      unmapped: 0,
    });
  };

  try {
    if (opts.asCard && visionStatus().available) return await card();
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
    // A scanned page with a little text laid over it (a distributor's web address or watermark, a page number added by a tool):
    // the page is the picture, and the text layer is not the book's. It is read from the picture, and what the reader makes of
    // the overlay there is left out (isOverlay).
    // Such an overlay sits in the top or bottom margin only: a page of real text over a picture (a decorative frame, a paper
    // texture) has its text in the body of the page, and keeps it.
    const inMargin = (it) => it.y < height * 0.1 || it.y - it.fs > height * 0.9;
    const overlaid = hasText && coverage >= 0.5 && textChars < 400 && raw.items.every((it) => !it.str.trim() || inMargin(it));
    let isOverlay = () => false;
    // the overlay's text is painted out of the page picture before it is read (isOverlay catches what is left)
    const blank = (canvas) => {
      if (!overlaid) return;
      const k = canvas.width / width;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      for (const it of raw.items) ctx.fillRect((it.x - 2) * k, (it.y - it.fs * 1.15) * k, (it.w + 4) * k, it.fs * 1.6 * k);
    };
    if (overlaid) {
      isOverlay = overlayTest(pageText(buildTextPage(raw, { defaultDir: opts.defaultDir, reverseHint: opts.reverseHint ?? null })));
      meta.warnings.push('scanned-under-text-layer');
    }

    let textResult = null;
    if (hasText && !overlaid) {
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
    const wantOcr = opts.ocr !== 'never' && (opts.mode === 'ocr' || !hasText || textResult || overlaid);
    if (wantOcr && (opts.mode === 'ocr' || textResult || textChars < 8 ? true : coverage > 0.3)) {
      if (opts.engine === 'ai' && visionStatus().available) {
        try {
          const { canvas } = await renderPage(page, Number(process.env.VISION_IMAGE_DPI) || 200, 2600);
          blank(canvas);
          // A framed book page: the model reads only what is inside the frame (enhanced: even paper tone, strong contrast,
          // slightly sharpened). The header / footer strips outside the frame (running title, page number, the drawn
          // line) are not read at all: they are cut out of the page and placed back as pictures, exactly as printed.
          const W = canvas.width;
          const H = canvas.height;
          const gray = rgbaToGray(canvas.getContext('2d').getImageData(0, 0, W, H).data, W, H);
          const bands = frameBands(gray, W, H);
          const body = bands ? crop(gray, W, H, bands.body) : { gray, width: W, height: H };
          // printMatch: the running heads (page number, running title) are read as text, at the same time as the page
          const headOf = (box, atTop) => {
            const c = crop(gray, W, H, box);
            return readHead(c.gray, c.width, c.height, { atTop, arabicOnly: opts.language === 'ar' }).catch(() => null);
          };
          const framed = opts.printMatch && bands ? Promise.all([[bands.top, true], [bands.bottom, false]].filter(([b]) => b).map(([b, atTop]) => headOf(b, atTop))) : null;
          const ai = await readPageWithAi(await enhanceForAi(body.gray, body.width, body.height), { arabicOnly: opts.language === 'ar', ptPerPx: width / W, font: opts.arabicFont, probs: !!opts.highlightUncertain, batch: opts.batch, cache: opts.aiCache });
          // a second reading (convert-pdf.js) after a failed one: no standard OCR, the first result stays
          if (ai.refused && opts.aiRetry) throw Object.assign(new Error('AI declined the page again'), { aiRetryFailed: true });
          if (ai.refused) meta.warnings.push('ai-declined-used-standard-ocr');
          // read by a fallback reader, or in bands, after the first one declined or failed
          else if (ai.tried?.length) meta.warnings.push(`ai-fallback:${ai.via}`);
          else if (ai.noText) {
            // a cover the clean-up made unreadable (light letters on a dark ground) is read again in colour
            if (opts.printMatch) return await card();
            // cover art / ornaments: keep the picture
            const pic = await pagePicture(page, workDir, n, 170, 88);
            const block = { type: 'image', ...pic, bbox: { x0: 10, y0: 10, x1: width - 10, y1: height - 10 }, fullPage: true };
            const r = finish([block], 'image');
            r.model.margins = { top: 10, bottom: 10, left: 10, right: 10 };
            return r;
          } else {
            const blocks = paragraphsToBlocks(ai.paragraphs.filter((p) => !isOverlay(p.text)), { bodyPt: ai.bodyPt, ptPerPx: width / W, lineGapPt: ai.lineGapPt, footRatio: ai.footRatio });
            // page number / running title / drawn line: kept as pictures in their place (top strip first, footer last); printMatch
            // reads them as text instead, and the book-level pass sets them (settleRunningHeads)
            const strips = [];
            const heads = framed ? await framed : [];
            for (const [box, atTop] of [[bands?.top, true], [bands?.bottom, false]]) {
              if (!box || opts.printMatch) continue;
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
              const box = { x0: 0, x1: W, y0: Math.max(0, ai.headerBox.y0 - pad), y1: Math.min(H, ai.headerBox.y1 + pad) };
              if (opts.printMatch) heads.push(await headOf(box, true));
              else {
                const c = crop(gray, W, H, box);
                const { default: sharp } = await import('sharp');
                const file = path.join(workDir, `p${n}_margin_top.png`);
                await writeFile(file, await sharp(Buffer.from(c.gray.buffer, c.gray.byteOffset, c.gray.length), { raw: { width: c.width, height: c.height, channels: 1 } }).png().toBuffer());
                const wPt = (c.width / W) * width;
                const hPt = (c.height / H) * height;
                strips.push({ atTop: true, block: { type: 'image', file, imgType: 'png', wPt, hPt, bbox: { x0: 0, y0: 0, x1: wPt, y1: hPt }, margin: true } });
              }
            }
            for (const s of strips) { if (s.atTop) blocks.unshift(s.block); else blocks.push(s.block); }
            if (ai.truncated) meta.warnings.push('ai-output-truncated');
            const texts = blocks.filter((b) => b.type === 'p').map((b) => b.runs.map((r) => r.text).join(''));
            const aiPage = finish(blocks, 'ai', {
              chars: texts.reduce((sum, t) => sum + t.length, 0),
              words: texts.reduce((sum, t) => sum + t.split(' ').length, 0),
              pageDir: dominantDirection(texts.join(' ')) || 'rtl',
              aiModel: ai.model,
              aiTokens: { input: ai.usage?.input_tokens || 0, output: ai.usage?.output_tokens || 0, cached: ai.usage?.cached_tokens || 0 },
              ...(ai.via ? { aiVia: ai.via } : {}),
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
            const fs = Math.round((ai.bodyPt || 14) * 0.85 * 2) / 2;
            const found = heads.filter(Boolean)
              .map((h) => (h.title && isOverlay(h.title) ? { ...h, title: null } : h))
              // a head whose title was seen but not read is kept: the pages around it give its title and its number
              .filter((h) => h.title || h.hasNumber || h.hasTitle)
              .map((h) => ({ ...h, fs }));
            if (found.length) aiPage.model.heads = found;
            return aiPage;
          }
        } catch (err) {
          // pass 1 of a batch conversion: the page is read in pass 2, from the batch's answers
          if (err?.deferred) throw err;
          if (opts.aiRetry) throw Object.assign(err, { aiRetryFailed: true });
          meta.warnings.push(`ai-failed-used-standard-ocr:${String(err.message).slice(0, 90)}`);
        }
      }
      const { paras: read, res, prep } = await ocrModel(page, n, opts, raw, blank);
      const paras = read.filter((p) => !isOverlay(p.runs.map((r) => r.text).join('')));
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
    if (err?.deferred || err?.aiRetryFailed) throw err; // not a page error: the batch reads it, or the first reading stays
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

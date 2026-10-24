// OCR (Tesseract, local Arabic + English models) -> page model paragraphs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import { dominantDirection, normalizeShaping, stripMarks } from './arabic.js';
import { linesToParagraphs } from './layout.js';

const langPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'tessdata');
const workers = new Map();
const uses = new Map();
// WASM OCR workers slowly degrade over hundreds of pages: recycle them, and replace one that failed.
const RECYCLE_AFTER = 40;
// Ornament / noise lines are short and very unsure. A real text line is NEVER dropped, however low its
// confidence (dropping text silently is worse than keeping a wrong word): it is highlighted for review.
const NOISE_MAX_CONFIDENCE = 30;
const NOISE_MAX_WORDS = 3;

async function dropWorker(lang) {
  const p = workers.get(lang);
  workers.delete(lang);
  uses.delete(lang);
  try {
    await (await p)?.terminate();
  } catch { /* already gone */ }
}

async function getWorker(lang) {
  if (workers.has(lang) && (uses.get(lang) || 0) >= RECYCLE_AFTER) await dropWorker(lang);
  if (!workers.has(lang)) {
    workers.set(
      lang,
      (async () => {
        const w = await createWorker(lang.split('+'), 1, { langPath, gzip: true, cacheMethod: 'none', logger: () => {} });
        await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
        return w;
      })(),
    );
    uses.set(lang, 0);
  }
  uses.set(lang, (uses.get(lang) || 0) + 1);
  return workers.get(lang);
}

export async function terminateOcr() {
  for (const lang of [...workers.keys()]) await dropWorker(lang);
}

/** Grayscale + contrast normalisation: helps faded scans without destroying thin Arabic strokes. */
export async function preprocess(buffer) {
  return sharp(buffer).rotate().grayscale().normalise().png().toBuffer();
}

// The calligraphic glyph for "salla Allahu alayhi wa sallam" (U+FDFA) has no letters the model knows, so it comes out as
// short junk right after the name it follows. Replace such junk, and only such junk, in that position.
const HONORIFIC = String.fromCharCode(0xfdfa);
const ANCHORS = new Set(['الله', 'لله', 'الرسول', 'النبي', 'النب', 'نبينا', 'محمد', 'محمدا']);
const JUNK = new Set(['فلل', 'كل', 'كلك', 'كلل', 'ل', 'لل', 'قلل', 'ك', 'فل', 'عل', 'لك', 'بل', '8', '4', '٨', '٤', 'ﷺ']);
const bare = (w) => stripMarks(w).replace(/[^ء-ي0-9٠-٩ﷺ]/g, '');
// built from code points so the closing bracket needs no escaping
const TRAILING_PUNCT = new RegExp(`[:${String.fromCharCode(0x60c, 0x61b, 0xbb)}.!?)${String.fromCharCode(92)}]]+$`);
export function fixHonorifics(words) {
  return words.map((w, i) => {
    if (i === 0) return w;
    const core = bare(w);
    if (!JUNK.has(core)) return w;
    const prev = bare(words[i - 1]);
    if (!ANCHORS.has(prev)) return w;
    if ((prev === 'الله' || prev === 'لله') && !(i >= 2 && bare(words[i - 2]) === 'رسول')) return w; // "رسول الله" only
    const trailing = w.match(TRAILING_PUNCT)?.[0] || '';
    return HONORIFIC + trailing;
  });
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] || 0;
};

async function recognizeWithRetry(lang, input) {
  try {
    const worker = await getWorker(lang);
    return await worker.recognize(input, {}, { blocks: true });
  } catch (err) {
    await dropWorker(lang); // the engine may be in a broken state: start a fresh one and try once more
    const worker = await getWorker(lang);
    try {
      return await worker.recognize(input, {}, { blocks: true });
    } catch (err2) {
      await dropWorker(lang);
      throw err2 || err;
    }
  }
}

/**
 * Recognise an image buffer and return paragraphs (points) in the same model as the text path.
 * Lines are regrouped with the layout engine's rules (line length, size change, bullets) because
 * Tesseract's own paragraph detection tends to glue headings and captions to body text.
 *
 * @param opts.geometry  when the image was cropped/rescaled before OCR: { scale, offsetX, offsetY } (pixels of
 *                       the original render), so positions map back onto the page
 * @param opts.prepared  true when the image is already clean grayscale (skip contrast normalisation)
 */
export async function recognize(buffer, { lang = 'ara', dpi = 300, lowConfidence = 60, geometry = {}, prepared = false } = {}) {
  const input = prepared ? buffer : await preprocess(buffer);
  const { data } = await recognizeWithRetry(lang, input);
  const toPt = 72 / dpi;
  const { scale = 1, offsetX = 0, offsetY = 0 } = geometry;
  const X = (px) => (px / scale + offsetX) * toPt;
  const Y = (py) => (py / scale + offsetY) * toPt;
  const H = (ph) => (ph / scale) * toPt;

  const allLines = [];
  (data.blocks || []).forEach((block, bi) => {
    for (const par of block.paragraphs || []) {
      for (const ln of par.lines || []) {
        if (ln.text && ln.text.trim()) allLines.push({ ln, col: bi });
      }
    }
  });
  const lineConf = ({ ln }) => {
    const ws = (ln.words || []).filter((w) => w.text && w.text.trim());
    return ws.length ? ws.reduce((s, w) => s + w.confidence, 0) / ws.length : 0;
  };
  const wordsOf = ({ ln }) => (ln.words || []).filter((w) => w.text && w.text.trim()).length;
  const isNoise = (l) => lineConf(l) < NOISE_MAX_CONFIDENCE && wordsOf(l) <= NOISE_MAX_WORDS;
  const rawLines = allLines.filter((l) => !isNoise(l));
  const droppedLines = allLines.length - rawLines.length;
  if (process.env.OCR_DEBUG) for (const l of allLines) if (!rawLines.includes(l)) console.log(`   dropped (conf ${lineConf(l).toFixed(0)}):`, l.ln.text.trim().slice(0, 80));

  const medianLine = median(rawLines.map(({ ln }) => H(ln.bbox.y1 - ln.bbox.y0))) || 20;
  const body = Math.max(9, Math.min(28, Math.round(medianLine * 0.8 * 2) / 2));

  let wordCount = 0;
  let confSum = 0;
  let lowCount = 0;
  const lineNodes = rawLines.map(({ ln, col }) => {
    const h = H(ln.bbox.y1 - ln.bbox.y0);
    const ratio = h / medianLine;
    // line boxes fluctuate with ascenders/diacritics: only clearly larger/smaller lines change size
    const fs = ratio > 1.35 || ratio < 0.6 ? Math.round(body * ratio * 2) / 2 : body;
    const words = (ln.words || []).filter((w) => w.text && w.text.trim());
    const fixed = fixHonorifics(words.map((w) => normalizeShaping(w.text)));
    const runs = [];
    if (words.length) {
      words.forEach((w, wi) => {
        wordCount++;
        confSum += w.confidence;
        const low = w.confidence < lowConfidence;
        if (low) lowCount++;
        runs.push({ text: fixed[wi] + (wi < words.length - 1 ? ' ' : ''), fs, bold: false, italic: false, lowConf: low || undefined });
      });
    } else runs.push({ text: normalizeShaping(ln.text.trim()), fs, bold: false, italic: false });
    // merge neighbouring runs with the same flags
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && !!last.lowConf === !!r.lowConf) last.text += r.text;
      else merged.push({ ...r });
    }
    const text = merged.map((r) => r.text).join('');
    return {
      kind: 'line',
      col,
      fs,
      runs: merged,
      text,
      dir: dominantDirection(text) || 'rtl',
      x0: X(ln.bbox.x0),
      x1: X(ln.bbox.x1),
      y: Y(ln.bbox.y1 - (ln.bbox.y1 - ln.bbox.y0) * 0.22), // approximate baseline
    };
  });

  const regionX0 = lineNodes.length ? Math.min(...lineNodes.map((l) => l.x0)) : 0;
  const regionX1 = lineNodes.length ? Math.max(...lineNodes.map((l) => l.x1)) : 1;
  const paragraphs = [];
  const cols = [...new Set(lineNodes.map((l) => l.col))];
  for (const c of cols) {
    const ls = lineNodes.filter((l) => l.col === c);
    const regionW = Math.max(...ls.map((l) => l.x1)) - Math.min(...ls.map((l) => l.x0));
    paragraphs.push(...linesToParagraphs(ls, { regionW, regionX0, regionX1 }));
  }
  for (const p of paragraphs) p.ocr = true;
  return {
    paragraphs,
    medianLine,
    body,
    confidence: wordCount ? confSum / wordCount : 0,
    words: wordCount,
    lowConfidenceWords: lowCount,
    droppedLines,
  };
}

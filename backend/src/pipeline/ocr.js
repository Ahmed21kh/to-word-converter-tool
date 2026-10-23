// OCR (Tesseract, local Arabic + English models) -> page model paragraphs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import { dominantDirection, normalizeShaping } from './arabic.js';
import { linesToParagraphs } from './layout.js';

const langPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'tessdata');
const workers = new Map();

async function getWorker(lang) {
  if (!workers.has(lang)) {
    workers.set(
      lang,
      (async () => {
        const w = await createWorker(lang.split('+'), 1, { langPath, gzip: true, cacheMethod: 'none', logger: () => {} });
        await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
        return w;
      })(),
    );
  }
  return workers.get(lang);
}

export async function terminateOcr() {
  for (const p of workers.values()) {
    try {
      await (await p).terminate();
    } catch { /* already gone */ }
  }
  workers.clear();
}

/** Grayscale + contrast normalisation: helps faded scans without destroying thin Arabic strokes. */
export async function preprocess(buffer) {
  return sharp(buffer).rotate().grayscale().normalise().png().toBuffer();
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] || 0;
};

/**
 * Recognise an image buffer and return paragraphs (points) in the same model as the text path.
 * Lines are regrouped with the layout engine's rules (line length, size change, bullets) because
 * Tesseract's own paragraph detection tends to glue headings and captions to body text.
 */
export async function recognize(buffer, { lang = 'ara+eng', dpi = 300, lowConfidence = 60 } = {}) {
  const worker = await getWorker(lang);
  const input = await preprocess(buffer);
  const { data } = await worker.recognize(input, {}, { blocks: true });
  const toPt = 72 / dpi;

  const rawLines = [];
  (data.blocks || []).forEach((block, bi) => {
    for (const par of block.paragraphs || []) {
      for (const ln of par.lines || []) {
        if (ln.text && ln.text.trim()) rawLines.push({ ln, col: bi });
      }
    }
  });
  const medianLine = median(rawLines.map(({ ln }) => (ln.bbox.y1 - ln.bbox.y0) * toPt)) || 20;
  const body = Math.max(9, Math.min(28, Math.round(medianLine * 0.8 * 2) / 2));

  let wordCount = 0;
  let confSum = 0;
  let lowCount = 0;
  const lineNodes = rawLines.map(({ ln, col }) => {
    const h = (ln.bbox.y1 - ln.bbox.y0) * toPt;
    const ratio = h / medianLine;
    // line boxes fluctuate with ascenders/diacritics: only clearly larger/smaller lines change size
    const fs = ratio > 1.35 || ratio < 0.6 ? Math.round(body * ratio * 2) / 2 : body;
    const words = (ln.words || []).filter((w) => w.text && w.text.trim());
    const runs = [];
    if (words.length) {
      words.forEach((w, wi) => {
        wordCount++;
        confSum += w.confidence;
        const low = w.confidence < lowConfidence;
        if (low) lowCount++;
        runs.push({ text: normalizeShaping(w.text) + (wi < words.length - 1 ? ' ' : ''), fs, bold: false, italic: false, lowConf: low || undefined });
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
      x0: ln.bbox.x0 * toPt,
      x1: ln.bbox.x1 * toPt,
      y: (ln.bbox.y1 - (ln.bbox.y1 - ln.bbox.y0) * 0.22) * toPt, // approximate baseline
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
  };
}

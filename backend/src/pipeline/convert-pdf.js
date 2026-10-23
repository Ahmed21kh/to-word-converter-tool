// Orchestrates a whole PDF: page tasks on the worker pool -> Quran guard -> docx.
import { writeFile } from 'node:fs/promises';
import { guardParagraph } from './quran.js';
import { buildDocx } from './docx-builder.js';
import { UNMAPPED } from './arabic.js';
import { savePreview } from './preview.js';

export const DEFAULT_OPTIONS = {
  format: 'docx', // docx | doc
  mode: 'smart', // smart | ocr | exact
  language: 'ar', // ar | en | auto
  quran: 'correct', // correct | verify | off
  ocr: 'auto', // auto | never
  arabicFont: 'Traditional Arabic',
  latinFont: 'Times New Roman',
  highlightUncertain: true,
  detectHeadings: true,
};

export function normalizeOptions(input = {}) {
  const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
  const o = { ...DEFAULT_OPTIONS };
  o.format = pick(input.format, ['docx', 'doc'], o.format);
  o.mode = pick(input.mode, ['smart', 'ocr', 'exact'], o.mode);
  o.language = pick(input.language, ['ar', 'en', 'auto'], o.language);
  o.quran = pick(input.quran, ['correct', 'verify', 'off'], o.quran);
  o.ocr = pick(input.ocr, ['auto', 'never'], o.ocr);
  const font = (v, d) => (typeof v === 'string' && /^[\p{L}\p{N} \-]{2,40}$/u.test(v) ? v : d);
  o.arabicFont = font(input.arabicFont, o.arabicFont);
  o.latinFont = font(input.latinFont, o.latinFont);
  for (const k of ['highlightUncertain', 'detectHeadings']) {
    if (input[k] !== undefined) o[k] = input[k] === true || input[k] === 'true' || input[k] === '1';
  }
  return o;
}

const errorPage = (n, message) => ({
  model: { n, width: 595, height: 842, blocks: [], margins: { top: 36, bottom: 36, left: 36, right: 36 }, method: 'error' },
  meta: { n, method: 'error', warnings: [`page-failed:${message}`], error: message, unmapped: 0 },
});

function* paragraphsOf(model) {
  for (const b of model.blocks) {
    if (b.type === 'p') yield b;
    else if (b.type === 'table') for (const c of b.cells) yield* c.paras;
  }
}

/**
 * Run the Quran guard over all pages.
 * @returns summary + findings list
 */
export function runQuranGuard(pages, mode) {
  const summary = { found: 0, verified: 0, corrected: 0, diacriticsFixed: 0, needsReview: 0, unmatched: 0, citationWarnings: 0, items: [] };
  for (const { model, meta } of pages) {
    if (model.method === 'image' || model.method === 'blank' || model.method === 'error') continue;
    for (const par of paragraphsOf(model)) {
      const { findings } = mode === 'off' ? { findings: [] } : guardParagraph(par, { mode });
      for (const f of findings) {
        summary.found++;
        if (f.status === 'verified') summary.verified++;
        else if (f.status === 'corrected') summary.corrected++;
        else if (f.status === 'diacritics-fixed') summary.diacriticsFixed++;
        else if (f.status === 'needs-review') summary.needsReview++;
        else if (f.status === 'unmatched') summary.unmatched++;
        if (f.citationWarning) summary.citationWarnings++;
        if (f.lowConfidence) summary.lowConfidence = (summary.lowConfidence || 0) + 1;
        if (f.status !== 'verified' || f.citationWarning) summary.items.push({ page: model.n, ...f });
      }
    }
    // what is still undecodable after the repairs is what the user has to look at
    let left = 0;
    for (const par of paragraphsOf(model)) for (const r of par.runs) left += r.text.split(UNMAPPED).length - 1;
    meta.unmapped = left;
  }
  return summary;
}

/**
 * @param ctx {jobId,file,workDir,outPath,options,pool,onProgress,isCancelled}
 */
export async function convertPdf(ctx) {
  const { jobId, file, workDir, outPath, options, pool, onProgress, isCancelled } = ctx;
  const t0 = Date.now();
  onProgress({ phase: 'analyzing', done: 0, total: 0 });
  const info = await pool.run({ type: 'info', file }, { jobId });
  const total = info.numPages;
  onProgress({ phase: 'converting', done: 0, total });

  const taskOptions = { ...options, defaultDir: options.language === 'en' ? 'ltr' : 'rtl' };
  const results = new Array(total);
  let done = 0;
  const runPage = async (n, extra = {}) => {
    try {
      return await pool.run({ type: 'page', file, n, options: { ...taskOptions, ...extra }, workDir }, { jobId, timeoutMs: undefined });
    } catch (err) {
      if (err.message === 'cancelled') throw err;
      return errorPage(n, err.message);
    }
  };
  await Promise.all(Array.from({ length: total }, (_, i) => i + 1).map(async (n) => {
    results[n - 1] = await runPage(n);
    done++;
    onProgress({ phase: 'converting', done, total });
  }));
  if (isCancelled()) throw new Error('cancelled');

  // Document-level consistency for letter-reversed PDFs: pages with too little evidence follow the majority.
  let fwd = 0;
  let rev = 0;
  for (const { meta } of results) {
    if (meta.reversalEvidence) {
      fwd += meta.reversalEvidence.fwd;
      rev += meta.reversalEvidence.rev;
    }
  }
  if (rev >= 8 && rev > fwd * 2.5) {
    const weak = results.filter(({ meta }) => meta.method === 'text' && !meta.reversedFixed && meta.chars > 40 && meta.reversalEvidence && meta.reversalEvidence.fwd + meta.reversalEvidence.rev <= 3);
    await Promise.all(weak.map(async ({ meta }) => {
      results[meta.n - 1] = await runPage(meta.n, { reverseHint: true });
    }));
  }
  pool.broadcast({ type: 'release', file }).catch(() => {});

  onProgress({ phase: 'verifying', done: total, total });
  const quran = runQuranGuard(results, options.quran);

  onProgress({ phase: 'building', done: total, total });
  const pageModels = results.map((r) => r.model);
  if (ctx.previewDir) await savePreview(pageModels, ctx.previewDir, { name: ctx.title, rtl: options.language !== 'en' });
  const dirs = results.map((r) => r.meta.pageDir).filter(Boolean);
  const pageDir = dirs.filter((d) => d === 'rtl').length >= dirs.length / 2 && dirs.length ? 'rtl' : (options.language === 'en' ? 'ltr' : 'rtl');
  const buffer = await buildDocx(pageModels, { ...options, pageDir, title: ctx.title });
  await writeFile(outPath, buffer);

  return buildReport({ results, quran, total, startedAt: t0, bytes: buffer.length });
}

export function buildReport({ results, quran, total, startedAt, bytes }) {
  const methods = {};
  const warnings = [];
  const review = new Set();
  for (const { meta } of results) {
    methods[meta.method] = (methods[meta.method] || 0) + 1;
    for (const w of meta.warnings || []) {
      warnings.push({ page: meta.n, message: w });
      review.add(meta.n);
    }
    if (meta.method === 'ocr' && meta.confidence < 70) review.add(meta.n);
    if (meta.unmapped > 0) review.add(meta.n);
  }
  for (const it of quran.items) if (it.status === 'unmatched' || it.status === 'needs-review' || it.citationWarning || it.lowConfidence) review.add(it.page);
  const pages = results.map(({ meta }) => ({
    n: meta.n,
    method: meta.method,
    chars: meta.chars ?? 0,
    quality: meta.quality,
    confidence: meta.confidence,
    reversedFixed: meta.reversedFixed || undefined,
    tables: meta.tables || undefined,
    images: meta.images || undefined,
    columns: meta.columns > 1 ? meta.columns : undefined,
    unmapped: meta.unmapped || undefined,
    fallbackReason: meta.fallbackReason,
    warnings: meta.warnings?.length ? meta.warnings : undefined,
  }));
  return {
    pages: total,
    durationMs: Date.now() - startedAt,
    outputBytes: bytes,
    methods,
    quran,
    warnings,
    reviewPages: [...review].sort((a, b) => a - b),
    pageDetails: pages,
  };
}

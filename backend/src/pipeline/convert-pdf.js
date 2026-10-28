// Orchestrates a whole PDF: page tasks on the worker pool -> Quran guard -> docx.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { guardParagraph } from './quran.js';
import { fixHonorifics, fixHeadingBrackets, writesSalla, wordCounts } from './honorifics.js';
import { buildDocx } from './docx-builder.js';
import { UNMAPPED } from './arabic.js';
import { savePreview } from './preview.js';
import { visionStatus } from './vision-ocr.js';
import { settleRunningHeads } from './running-head.js';

export const DEFAULT_OPTIONS = {
  format: 'docx', // docx | doc
  mode: 'smart', // smart | ocr | exact
  language: 'ar', // ar (Arabic OCR model) | mixed (Arabic + English) | en
  engine: 'standard', // standard (free Tesseract) | ai (vision model, needs VISION_PROVIDER)
  quran: 'correct', // correct | verify | off
  ocr: 'auto', // auto | never
  arabicFont: 'Traditional Arabic',
  latinFont: 'Times New Roman',
  highlightUncertain: false, // doubtful words: yellow highlight + comment, only when asked
  detectHeadings: true,
  frontAsPictures: true, // AI reading of a scanned book: the cover and title pages before its first page of text stay pictures
  printMatch: false, // "matches the printed edition": one Word page per PDF page, text shrunk per page so nothing spills over
};

export function normalizeOptions(input = {}) {
  const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
  const o = { ...DEFAULT_OPTIONS };
  o.format = pick(input.format, ['docx', 'doc'], o.format);
  o.mode = pick(input.mode, ['smart', 'ocr', 'exact'], o.mode);
  o.language = pick(input.language, ['ar', 'en', 'mixed'], o.language);
  o.quran = pick(input.quran, ['correct', 'verify', 'off'], o.quran);
  o.ocr = pick(input.ocr, ['auto', 'never'], o.ocr);
  o.engine = pick(input.engine, ['standard', 'ai'], o.engine);
  const font = (v, d) => (typeof v === 'string' && /^[\p{L}\p{N} \-]{2,40}$/u.test(v) ? v : d);
  o.arabicFont = font(input.arabicFont, o.arabicFont);
  o.latinFont = font(input.latinFont, o.latinFont);
  for (const k of ['highlightUncertain', 'detectHeadings', 'frontAsPictures', 'printMatch']) {
    if (input[k] !== undefined) o[k] = input[k] === true || input[k] === 'true' || input[k] === '1';
  }
  // "matches the printed edition" is text only: pages as pictures (exact) cannot be part of it
  if (o.printMatch && o.mode === 'exact') o.mode = 'smart';
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
  const summary = { found: 0, verified: 0, corrected: 0, diacriticsFixed: 0, needsReview: 0, unmatched: 0, citationWarnings: 0, citationsFixed: 0, items: [] };
  // the verses quoted on the last paragraphs: a book explains a passage verse by verse, so short quotations come from near them
  let recent = [];
  // ﷺ first, over the whole document: once the book is seen to write it after every mention of the Prophet, the junk words the
  // reader made of it can be recognised much more widely
  const aiPars = pages.filter(({ model }) => !['image', 'blank', 'error'].includes(model.method)).flatMap(({ model }) => [...paragraphsOf(model)]).filter((p) => p.ai);
  for (const par of aiPars) { fixHonorifics(par); fixHeadingBrackets(par); }
  if (writesSalla(aiPars)) {
    const counts = wordCounts(aiPars);
    for (const par of aiPars) { fixHonorifics(par, { strict: true, counts }); fixHeadingBrackets(par); }
  }
  for (const { model, meta } of pages) {
    if (model.method === 'image' || model.method === 'blank' || model.method === 'error') continue;
    for (const par of paragraphsOf(model)) {
      const { findings, refs = [] } = mode === 'off' ? { findings: [] } : guardParagraph(par, { mode, context: recent });
      if (refs.length) recent = [...recent, ...refs].slice(-8);
      for (const f of findings) if (f.citationFixed) summary.citationsFixed++;
      for (const f of findings) {
        summary.found++;
        if (f.status === 'verified') summary.verified++;
        else if (f.status === 'corrected') summary.corrected++;
        else if (f.status === 'diacritics-fixed') summary.diacriticsFixed++;
        else if (f.status === 'needs-review') summary.needsReview++;
        else if (f.status === 'unmatched') summary.unmatched++;
        if (f.citationWarning) summary.citationWarnings++;
        if (f.lowConfidence) summary.lowConfidence = (summary.lowConfidence || 0) + 1;
        if (f.status !== 'verified' || f.citationWarning || f.citationFixed) summary.items.push({ page: model.n, ...f });
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
 * A book opens with pages that are not running text: the cover, the half-title, the copyright and title pages, the basmala.
 * Read as text they give scattered words; kept as pictures they look as printed (and cost no AI time). They are the pages before
 * the first one that is a block of full lines; only the first pages of a book are looked at, cheaply (no reading).
 * @returns {Promise<number>} how many leading pages are front matter (0 when no text page is found early on)
 */
async function frontMatter(pool, file, total, jobId) {
  const probes = [];
  for (let n = 1; n <= Math.min(8, total - 1); n++) {
    const probe = await pool.run({ type: 'probe', file, n }, { jobId }).catch(() => null);
    if (!probe) return 0;
    if (probe.lines >= 14 && probe.full >= 10 && probe.color < 0.05) {
      // the pages before the first page of text are front matter only if each looks like it: in colour (the cover), a few lines
      // (half-title, title page, basmala), or "lines" far from the text's own height (measured: decorated blocks of a title or
      // copyright page come out 3-10x as tall). A page of running text that merely has fewer lines (the end of a chapter) stops
      // the count, so its text is still read.
      let front = 0;
      while (front < probes.length) {
        const p = probes[front];
        const odd = p.lineH && (p.lineH > probe.lineH * 1.8 || p.lineH < probe.lineH * 0.75);
        if (!(p.color >= 0.05 || p.lines <= 6 || odd)) break;
        front++;
      }
      return front;
    }
    probes.push(probe);
  }
  return 0;
}

/**
 * @param ctx {jobId,file,workDir,outPath,options,pool,onProgress,isCancelled,waitIfPaused}
 */
export async function convertPdf(ctx) {
  const { jobId, file, workDir, outPath, options, pool, onProgress, isCancelled, waitIfPaused } = ctx;
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
  // A local AI model answers one page at a time, so do not queue every worker behind it (the queue wait would
  // count against the request timeout); a cloud API takes a few pages at once.
  const vision = options.engine === 'ai' ? visionStatus() : null;
  const lanes = Math.max(1, Math.min(total, vision?.available ? Number(process.env.AI_CONCURRENCY) || (vision.provider === 'claude' ? 4 : 2) : total));
  // Every converted page is kept in the work folder: a paused conversion (or one cut by a server restart) goes on from the
  // pages it has, it does not read them again.
  const saved = path.join(workDir, 'pages');
  await mkdir(saved, { recursive: true });
  const loadPage = (n) => readFile(path.join(saved, `${n}.json`), 'utf8').then(JSON.parse).catch(() => null);
  // the cover and title pages: pictures, or (printMatch, which keeps no pictures) their text in a box
  const front = vision?.available && (options.frontAsPictures || options.printMatch) ? await frontMatter(pool, file, total, jobId) : 0;
  const frontAs = options.printMatch ? { asCard: true } : { asPicture: true };
  let next = 0;
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (next < total) {
      // a pause takes effect between pages: the pages being read are finished first
      if (waitIfPaused) await waitIfPaused();
      if (isCancelled()) throw new Error('cancelled');
      if (next >= total) break;
      const n = ++next;
      let page = await loadPage(n);
      if (!page) {
        page = await runPage(n, n <= front ? frontAs : {});
        if (page.model?.method !== 'error') await writeFile(path.join(saved, `${n}.json`), JSON.stringify(page)).catch(() => {});
      }
      results[n - 1] = page;
      done++;
      onProgress({ phase: 'converting', done, total });
    }
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
  if (options.printMatch) dropPictures(results);

  onProgress({ phase: 'verifying', done: total, total });
  const quran = runQuranGuard(results, options.quran);

  onProgress({ phase: 'building', done: total, total });
  const pageModels = results.map((r) => r.model);
  // printMatch: the page numbers from the page sequence, the running titles as the book prints them
  const heads = settleRunningHeads(pageModels, { bookTitle: ctx.title });
  unifyAiFontSize(pageModels);
  if (ctx.previewDir) await savePreview(pageModels, ctx.previewDir, { name: ctx.title, rtl: options.language !== 'en', highlight: options.highlightUncertain });
  const dirs = results.map((r) => r.meta.pageDir).filter(Boolean);
  const pageDir = dirs.filter((d) => d === 'rtl').length >= dirs.length / 2 && dirs.length ? 'rtl' : (options.language === 'en' ? 'ltr' : 'rtl');
  const stats = {};
  const buffer = await buildDocx(pageModels, { ...options, pageDir, title: ctx.title, stats });
  await writeFile(outPath, buffer);

  const report = buildReport({ results, quran, total, startedAt: t0, bytes: buffer.length });
  if (options.printMatch) {
    const fitted = stats.fitted || [];
    report.printMatch = { pages: total, shrunk: fitted.length, smallestScale: fitted.length ? Math.min(...fitted.map((f) => f.scale)) : 1, heads };
  }
  return report;
}

/**
 * printMatch: Shamela takes no pictures, so none reaches the Word file. Whatever is still a picture (an ornament of a text page,
 * a page nothing could be read from) is left out, and the page is marked for review.
 */
export function dropPictures(results) {
  for (const { model, meta } of results) {
    const kept = model.blocks.filter((b) => b.type !== 'image');
    if (kept.length === model.blocks.length) continue;
    model.blocks = kept;
    meta.warnings = [...(meta.warnings || []), 'pictures-removed'];
    if (!kept.length) {
      model.method = 'blank';
      meta.method = 'blank';
    }
  }
}

/**
 * AI-read pages get the size measured on their own scan, which wobbles a little from page to page. A book is set in one size:
 * every AI page uses the median body size of the document (headings stay four points larger).
 */
export function unifyAiFontSize(models) {
  const ai = models.filter((m) => m.method === 'ai' && m.flow);
  const isHeading = (b) => b.align === 'center' && b.runs[0]?.bold;
  const sizes = ai.flatMap((m) => m.blocks.filter((b) => b.type === 'p' && !isHeading(b) && !b.footnote && !b.margin).map((b) => b.fs)).sort((a, b) => a - b);
  if (ai.length < 2 || !sizes.length) return;
  const body = sizes[Math.floor(sizes.length / 2)];
  for (const m of ai) {
    for (const b of m.blocks) {
      if (b.type !== 'p' || b.margin) continue; // a running title read as text (printMatch) stays smaller
      const fs = isHeading(b) ? body + 4 : b.footnote ? Math.round(body * (b.footRatio || 0.75) * 2) / 2 : body;
      b.fs = fs;
      for (const r of b.runs) r.fs = fs;
    }
  }
}

const INFO_NOTES = new Set(['front-matter-picture', 'front-matter-card']);

export function buildReport({ results, quran, total, startedAt, bytes }) {
  const methods = {};
  const warnings = [];
  const review = new Set();
  for (const { meta } of results) {
    methods[meta.method] = (methods[meta.method] || 0) + 1;
    for (const w of meta.warnings || []) {
      warnings.push({ page: meta.n, message: w });
      if (!INFO_NOTES.has(w)) review.add(meta.n); // a note on what was done on purpose is no reason to check the page
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
  const scan = {
    ocrPages: results.filter(({ meta }) => meta.method === 'ocr').length,
    diacriticsStripped: results.filter(({ meta }) => meta.diacriticsStripped).length,
    keptAsPictures: results.filter(({ meta }) => meta.method === 'image').length,
    aiPages: results.filter(({ meta }) => meta.method === 'ai').length,
    aiInputTokens: results.reduce((s, { meta }) => s + (meta.aiTokens?.input || 0), 0),
    aiOutputTokens: results.reduce((s, { meta }) => s + (meta.aiTokens?.output || 0), 0),
  };
  return {
    pages: total,
    scan,
    durationMs: Date.now() - startedAt,
    outputBytes: bytes,
    methods,
    quran,
    warnings,
    reviewPages: [...review].sort((a, b) => a - b),
    pageDetails: pages,
  };
}

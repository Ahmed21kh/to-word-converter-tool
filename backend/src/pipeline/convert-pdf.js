// Orchestrates a whole PDF: page tasks on the worker pool -> Quran guard -> docx.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { guardParagraph } from './quran.js';
import { fixHonorifics, fixHeadingBrackets, writesSalla, wordCounts } from './honorifics.js';
import { buildDocx } from './docx-builder.js';
import { UNMAPPED } from './arabic.js';
import { savePreview } from './preview.js';
import { visionStatus, geminiClient, createPageCache, deletePageCache, paragraphsToBlocks, PICTURE_PAGE, BLANK_PAGE, pageLabel } from './vision-ocr.js';
import { runBatch } from './gemini-batch.js';
import { settleRunningHeads, settlePageNumbers, fixHeadingsFromContents } from './running-head.js';
import { fixDoubtfulWords, fixDotSlips, fixMaqsuraHamza, fixItemNumbers, fixSplitWords } from './book-words.js';
import { fixWasla } from './wasla.js';
import { geminiConcurrency } from '../services/gemini-throttle.js';

export const DEFAULT_OPTIONS = {
  format: 'docx', // docx | doc
  mode: 'smart', // smart | ocr | exact
  language: 'ar', // ar (Arabic OCR model) | mixed (Arabic + English) | en
  // standard (free Tesseract) | ai (vision model, needs VISION_PROVIDER)
  engine: 'standard',
  quran: 'correct', // correct | verify | off
  ocr: 'auto', // auto | never
  arabicFont: 'Traditional Arabic',
  latinFont: 'Times New Roman',
  highlightUncertain: false, // doubtful words: yellow highlight + comment, only when asked
  detectHeadings: true,
  frontAsPictures: true, // AI reading of a scanned book: the cover and title pages before its first page of text stay pictures
  aiBatch: false, // AI reading through Gemini Batch Mode: half the price, the file is ready within 24 hours (usually sooner)
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
  // 'hybrid' (removed) is read as 'ai': a saved setting or an older page still sends it
  o.engine = pick(input.engine === 'hybrid' ? 'ai' : input.engine, ['standard', 'ai'], o.engine);
  const font = (v, d) => (typeof v === 'string' && /^[\p{L}\p{N} \-]{2,40}$/u.test(v) ? v : d);
  o.arabicFont = font(input.arabicFont, o.arabicFont);
  o.latinFont = font(input.latinFont, o.latinFont);
  for (const k of ['highlightUncertain', 'detectHeadings', 'frontAsPictures', 'printMatch', 'aiBatch']) {
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
/**
 * Gemini Batch Mode ("economy" option, half the price, answered within 24 hours). Pass 1: every page is rendered as for the
 * normal reading, but its Gemini reads are queued instead of sent (gemini-batch.js); a page that needs no reading (a good text
 * layer) is finished and kept. The queued reads go to Google as one job and are waited for; the normal page loop (pass 2) then
 * builds the pages from the answers, and reads live whatever the batch did not answer, so a failed or expired batch loses no
 * page. A job already sent (a restart while it waited) is not prepared or sent again.
 */
async function batchPass({ pool, file, total, jobId, workDir, taskOptions, isCover, frontAs, lanes, loadPage, saved, onProgress, isCancelled, waitIfPaused }) {
  const dir = path.join(workDir, 'batch');
  const sent = await readFile(path.join(dir, 'job.json'), 'utf8').then(() => true).catch(() => false);
  if (!sent) {
    let next = 0;
    let done = 0;
    onProgress({ phase: 'batchPreparing', done, total });
    await Promise.all(Array.from({ length: lanes }, async () => {
      while (next < total) {
        if (waitIfPaused) await waitIfPaused();
        if (isCancelled()) throw new Error('cancelled');
        if (next >= total) break;
        const n = ++next;
        if (!(await loadPage(n))) {
          const options = { ...taskOptions, ...(isCover(n) ? frontAs : {}), batch: { dir, collect: true } };
          const page = await pool.run({ type: 'page', file, n, options, workDir }, { jobId }).catch((err) => {
            if (err.message === 'cancelled') throw err;
            return null; // queued for the batch (DEFERRED), or failed: either way pass 2 reads it
          });
          if (page && page.model?.method !== 'error') await writeFile(path.join(saved, `${n}.json`), JSON.stringify(page)).catch(() => {});
        }
        onProgress({ phase: 'batchPreparing', done: ++done, total });
      }
    }));
  }
  onProgress({ phase: 'batchWaiting', done: 0, total });
  const result = await runBatch(geminiClient(), dir, visionStatus().model, { isCancelled, pollMs: Number(process.env.GEMINI_BATCH_POLL_MS) || 30_000 });
  return { dir, result };
}

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
 * The back cover: the pages at the end of the book in colour (at most two, and none of the front matter's). Read as text, its
 * blurb on a coloured ground gave scattered words; it is taken as the front cover is.
 * @returns {Promise<number>} how many trailing pages are the back cover
 */
async function backMatter(pool, file, total, front, jobId) {
  let back = 0;
  for (let n = total; n > Math.max(front, total - 2); n--) {
    const probe = await pool.run({ type: 'probe', file, n }, { jobId }).catch(() => null);
    if (!probe || probe.color < 0.05) break;
    back++;
  }
  return back;
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
  // count against the request timeout); a cloud API takes a few pages at once. Gemini: as many pages as its server-wide limit
  // has turns (GEMINI_CONCURRENCY), so a page never spends its time limit waiting for one (a fourth page on three turns, while
  // an overloaded model takes a minute per answer, is what ran out of time).
  const vision = options.engine === 'ai' ? visionStatus() : null;
  const aiLanes = () => (vision.provider === 'gemini' ? geminiConcurrency() : vision.external ? 4 : 2);
  const lanes = Math.max(1, Math.min(total, vision?.available ? Number(process.env.AI_CONCURRENCY) || aiLanes() : total));
  // Every converted page is kept in the work folder: a paused conversion (or one cut by a server restart) goes on from the
  // pages it has, it does not read them again.
  const saved = path.join(workDir, 'pages');
  await mkdir(saved, { recursive: true });
  const loadPage = (n) => readFile(path.join(saved, `${n}.json`), 'utf8').then(JSON.parse).catch(() => null);
  // the cover and title pages: pictures, or (printMatch, which keeps no pictures) their text in a box
  const covers = vision?.available && (options.frontAsPictures || options.printMatch);
  const front = covers ? await frontMatter(pool, file, total, jobId) : 0;
  const back = covers && total > 2 ? await backMatter(pool, file, total, front, jobId) : 0;
  const isCover = (n) => n <= front || n > total - back;
  const frontAs = options.printMatch ? { asCard: true } : { asPicture: true };
  const gemini = vision?.available && vision.provider === 'gemini';
  // a worked example for the reader, cached once for the whole book (GEMINI_EXEMPLAR; nothing without it)
  if (gemini) taskOptions.aiCache = await createPageCache(vision.model);
  const batch = gemini && options.aiBatch ? await batchPass({ pool, file, total, jobId, workDir, taskOptions, isCover, frontAs, lanes, loadPage, saved, onProgress, isCancelled, waitIfPaused }) : null;
  if (batch) taskOptions.batch = { dir: batch.dir };
  // the printed pages, small, for the preview beside the converted ones: drawn by the workers the reading leaves idle
  const sources = [];
  if (ctx.previewDir) await mkdir(ctx.previewDir, { recursive: true });
  let next = 0;
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (next < total) {
      // a pause takes effect between pages: the pages being read are finished first
      if (waitIfPaused) await waitIfPaused();
      if (isCancelled()) throw new Error('cancelled');
      if (next >= total) break;
      const n = ++next;
      if (ctx.previewDir) sources.push(pool.run({ type: 'source', file, n, out: path.join(ctx.previewDir, `src-${n}.jpg`) }, { jobId }).catch(() => {}));
      let page = await loadPage(n);
      if (!page) {
        page = await runPage(n, isCover(n) ? frontAs : {});
        if (page.model?.method !== 'error') await writeFile(path.join(saved, `${n}.json`), JSON.stringify(page)).catch(() => {});
      }
      results[n - 1] = page;
      ctx.onPage?.(page.meta); // the job log: how the page was read
      done++;
      onProgress({ phase: 'converting', done, total });
    }
  }));
  if (isCancelled()) throw new Error('cancelled');
  // (a cancelled job leaves its cache to expire by itself, in two hours at most)
  await deletePageCache(taskOptions.aiCache);

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
  await Promise.all(sources);
  pool.broadcast({ type: 'release', file }).catch(() => {});
  if (options.printMatch) dropPictures(results);

  onProgress({ phase: 'verifying', done: total, total });
  const quran = runQuranGuard(results, options.quran);

  onProgress({ phase: 'building', done: total, total });
  const pageModels = results.map((r) => r.model);
  // a word the reader was unsure of, or got a dot wrong in, set by the words the book prints elsewhere
  fixDoubtfulWords(pageModels);
  fixDotSlips(pageModels);
  // a word split in two at a letter that does not join the next ("شيو خه"), and "بز" for "بن" in a line of names
  fixSplitWords(pageModels);
  // an alef maqsura with a dagger alef over it (علىٰ) that the reader took for a ya with a hamza ("يتهادئ")
  fixMaqsuraHamza(pageModels);
  // a numbered item read with a digit too many ("٣ـ" as "٣٢–"), set by the items before and after it
  fixItemNumbers(pageModels);
  // a book that prints hamzat al-wasl (ٱ): its alifs written so, where the reader wrote a plain alif or took the mark for a hamza
  fixWasla(pageModels);
  // printMatch: the page numbers from the page sequence, the running titles as the book prints them
  const heads = settleRunningHeads(pageModels, { bookTitle: ctx.title });
  // the page number under the text: from the page sequence, centred at the foot of each page from where the book's numbering starts
  const pageNumbers = settlePageNumbers(pageModels);
  // the calligraphic chapter titles and the فصلٌ ornament, as the table of contents prints them
  const contents = fixHeadingsFromContents(pageModels);
  unifyAiFontSize(pageModels);
  // a cover or title page read as text: once its lines are settled they are plain centred paragraphs, not lines in a box (a table,
  // which Shamela takes for a picture); the title on a cover is not a heading of the book
  for (const m of pageModels) m.blocks = m.blocks.flatMap((b) => (b.type === 'table' && b.card ? b.cells[0].paras.map((x) => ({ ...x, align: 'center', noHeading: true })) : [b]));
  if (options.printMatch) fillEmptyPages(pageModels);
  if (ctx.previewDir) await savePreview(pageModels, ctx.previewDir, { name: ctx.title, rtl: options.language !== 'en', highlight: options.highlightUncertain, source: true });
  const dirs = results.map((r) => r.meta.pageDir).filter(Boolean);
  const pageDir = dirs.filter((d) => d === 'rtl').length >= dirs.length / 2 && dirs.length ? 'rtl' : (options.language === 'en' ? 'ltr' : 'rtl');
  const stats = {};
  const buffer = await buildDocx(pageModels, { ...options, pageDir, title: ctx.title, stats });
  await writeFile(outPath, buffer);

  const report = buildReport({ results, quran, total, startedAt: t0, bytes: buffer.length });
  report.pageNumbers = pageNumbers;
  report.contents = contents;
  if (batch) report.aiBatch = batch.result;
  if (options.printMatch) {
    const fitted = stats.fitted || [];
    report.printMatch = { pages: total, shrunk: fitted.length, smallestScale: fitted.length ? Math.min(...fitted.map((f) => f.scale)) : 1, heads };
  }
  return report;
}

/**
 * printMatch: Shamela takes no pictures, so none reaches the Word file. Whatever is still a picture (an ornament of a text page,
 * a page kept whole as a picture by a conversion saved before) is left out, and the page is marked for review; a page left with
 * nothing on it is named by fillEmptyPages.
 */
export function dropPictures(results) {
  for (const { model, meta } of results) {
    const kept = model.blocks.filter((b) => b.type !== 'image');
    if (kept.length === model.blocks.length) continue;
    model.blocks = kept;
    meta.warnings = [...(meta.warnings || []), 'pictures-removed'];
    if (!kept.length) {
      model.pictureDropped = true;
      model.method = 'blank';
      meta.method = 'blank';
    }
  }
}

/**
 * printMatch: no Word page is left empty. A page with no text of its own (a blank page of the book, a picture that was dropped,
 * a card whose every line was a guess) gets one centred line saying what it is.
 */
export function fillEmptyPages(models) {
  const hasText = (b) => (b.type === 'p' && !b.margin && b.runs?.some((r) => r.text.trim())) || b.type === 'table';
  let filled = 0;
  for (const m of models) {
    if (m.blocks.some(hasText)) continue;
    const [p] = paragraphsToBlocks([{ text: m.pictureDropped ? PICTURE_PAGE : BLANK_PAGE, heading: false, center: true }], { bodyPt: 16 });
    m.blocks = [...m.blocks, pageLabel(p)];
    // flowed inside the margins of an AI-read page (FLOW_MARGINS of process-page.js)
    if (!m.flow) { m.flow = true; m.margins = { top: 36, bottom: 30, left: 42, right: 42 }; }
    filled++;
  }
  return filled;
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
  // A page the AI could not read (the standard OCR read it instead) takes its size from the height of its line boxes, which the
  // diacritics make tall: 22 pt for a book set in 15. Its sizes are scaled so its own body size is the book's, and kept between a
  // footnote's size and a heading's; its lines keep their printed spacing and places.
  for (const m of models) {
    if (m.method !== 'ocr') continue;
    const chars = new Map();
    for (const b of m.blocks) {
      if (b.type !== 'p' || b.margin) continue;
      for (const r of b.runs) chars.set(r.fs || b.fs, (chars.get(r.fs || b.fs) || 0) + r.text.length);
    }
    const own = [...chars].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!own || Math.abs(own - body) < 0.5) continue;
    const size = (fs) => Math.min(body + 4, Math.max(Math.round(body * 0.62 * 2) / 2, Math.round(((fs || own) * body) / own * 2) / 2));
    for (const b of m.blocks) {
      if (b.type !== 'p' || b.margin) continue;
      for (const r of b.runs) r.fs = size(r.fs || b.fs);
      b.fs = size(b.fs);
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
    // input tokens a prompt cache served (billed at the cache price), and pages a fallback reader read (ai-fallback:*)
    aiCachedTokens: results.reduce((s, { meta }) => s + (meta.aiTokens?.cached || 0), 0),
    aiFallbackPages: results.filter(({ meta }) => meta.aiVia && meta.warnings?.some((w) => w.startsWith('ai-fallback:'))).length,
    // pages read by each AI model (a fallback model, once the first one's quota is used up, shows here)
    aiModels: results.reduce((m, { meta }) => (meta.aiModel ? { ...m, [meta.aiModel]: (m[meta.aiModel] || 0) + 1 } : m), {}),
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

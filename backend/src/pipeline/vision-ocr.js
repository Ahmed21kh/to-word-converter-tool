// "AI reading" of page images with a vision model: far more accurate than Tesseract on diacritised Arabic books.
//
// Providers (set VISION_PROVIDER):
//   claude  - Anthropic API through the official SDK. Needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / an
//             `ant auth login` profile). Pages are sent to Anthropic. Billed per use.
//   ollama  - a local model served by Ollama (free, nothing leaves your machine), e.g. VISION_MODEL=qwen2.5vl:7b.
//   llamacpp - a local llama.cpp server (the llama-server.exe that ships with Ollama) running Qari-OCR, a 2B model trained on
//             diacritised Arabic. Free, local, much smaller and faster than a general 7B model. See scripts/start-qari.ps1.
//
// Everything else (layout, Quran verification, docx) is shared with the normal pipeline.
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { dominantDirection, normalizeShaping, stripMarks } from './arabic.js';
import { replaceRange } from './quran.js';
import { sallaSlots, sallaLetters } from './honorifics.js';
import { createCanvas } from '@napi-rs/canvas';
import { segmentLines, hasRule, findFootnoteRule } from './text-lines.js';
import { wordConfidence } from './token-confidence.js';

const DEFAULT_MODELS = { claude: 'claude-opus-5-5', ollama: 'qwen2.5vl:7b', llamacpp: 'qari-ocr' };

export const NO_TEXT = '[[NO_TEXT]]';

export function visionStatus() {
  const provider = (process.env.VISION_PROVIDER || '').trim().toLowerCase();
  if (!['claude', 'ollama', 'llamacpp'].includes(provider)) return { available: false, provider: null, model: null };
  return { available: true, provider, model: process.env.VISION_MODEL || DEFAULT_MODELS[provider], external: provider === 'claude' };
}

// Shared by every prompt: the reader works on Arabic only, and the letters that differ by dots only are where it goes wrong.
const ARABIC_FOCUS = [
  'LANGUAGE: the text is Arabic (classical, usually fully diacritised, from a printed book). Think and write in Arabic script only.',
  'Never translate, explain, describe the image, answer in English or any other language, or transliterate.',
  'Letters that differ only by their dots look alike: ف/ق, ب/ت/ث/ن/ي, ج/ح/خ, د/ذ, ر/ز, س/ش, ص/ض, ط/ظ, ع/غ, ه/ة.',
  'Decide each one from the number and position of the dots actually printed, never from what the word "should" be.',
  'Copy the printed words even when they look like a misspelling or an unusual word; never replace a word by a more common one.',
].join('\n');

const SYSTEM_PROMPT = [
  'You are a meticulous OCR engine for Arabic books. Transcribe ALL the text on the page image exactly as it is printed.',
  '',
  ARABIC_FOCUS,
  '',
  'Rules:',
  '- Keep every diacritic (tashkeel: fatha, damma, kasra, shadda, sukun, tanween, dagger alif, madda, wasla) exactly as printed.',
  '  Never add, remove or "correct" diacritics or spelling, and do not modernise the orthography: copy what is printed.',
  '- Quranic verses printed between ornate brackets stay between \uFD3F and \uFD3E, exactly as printed.',
  '- Write the calligraphic honorific glyph that stands for "salla Allahu alayhi wa sallam" as \uFDFA.',
  '- Reading order is right-to-left, top-to-bottom (columns: right column first). A running header or page number is never part of a paragraph: put it on its own line.',
  '- Plain text only. Separate paragraphs with one blank line. Inside a paragraph join the printed lines with single spaces.',
  '- A centered or bold section heading goes on its own line prefixed with "# ".',
  '- Citations such as [آل عمران: ٣] stay in their paragraph, as printed.',
  '- A table: one line per row, cells separated by " | ".',
  `- If the page has no readable text (cover art, ornaments, a blank page) output exactly: ${NO_TEXT}`,
  '- Output the transcription only: no commentary, no translation, no markdown other than "# ", no code fences.',
].join('\n');

const USER_PROMPT = 'Transcribe this page.';

// One text line at a time: the image is small and sharp, so the model sees every dot and diacritic.
// Measured on a diacritised page (680 letters): this wording reads 97.5% of the letters. A longer prompt with rules about Arabic or
// about the dots made the 7B model worse (93-95%), and so did dropping the bracket sentence, so "Arabic only" is enforced afterwards
// by cleanArabicLine, and a second reading with another prompt was no help (both readings repeat the same mistakes).
const LINE_SYSTEM_PROMPT = `You are a meticulous OCR engine for Arabic books. Transcribe the text of this image exactly as printed, keeping every diacritic. Quran brackets stay between ${String.fromCharCode(0xfd3f)} and ${String.fromCharCode(0xfd3e)}. Output only the text.`;
const LINE_USER_PROMPT = 'Transcribe this line.';

/** Drops letters of other scripts (a vision model sometimes drifts into Latin or Chinese) and ornate brackets mis-read from a "و". */
export function cleanArabicLine(text, { arabicOnly = true } = {}) {
  let out = '';
  for (const ch of String(text)) {
    if (arabicOnly && /\p{L}/u.test(ch) && !/\p{Script=Arabic}/u.test(ch)) continue;
    if (!/[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Z}]/u.test(ch)) continue; // control / private-use junk
    out += ch;
  }
  for (const o of [String.fromCharCode(0xfd3e), String.fromCharCode(0xfd3f), '{', '}']) out = out.split(o).join('');
  for (const o of ['♠', '♣', '♥', '♦', '◆', '◇', '❖', '❋', '✦']) out = out.split(o).join('*');
  // empty parentheses / "()*" are what is left of a verse bracket the reader could not make out
  for (const junk of ['()*', '( )', '()']) out = out.split(junk).join(' ');
  return out.split(' ').filter(Boolean).join(' ');
}

/**
 * This book prints its section titles in square brackets on their own line: "[خبر زكريا ومريم]". The model often glues such a
 * title to the paragraph that follows, so a paragraph that starts with a short bracketed phrase (no digits or colon, which
 * would make it a citation like [آل عمران: ٣]) is split into a heading and the paragraph.
 */
function splitBracketHeading(p) {
  if (p.heading || !p.text.startsWith('[')) return [p];
  const end = p.text.indexOf(']');
  const inner = p.text.slice(1, end);
  const rest = p.text.slice(end + 1).trim();
  if (end < 3 || end > 90 || !rest || /[0-9٠-٩۰-۹:\[]/.test(inner)) return [p];
  return [{ text: p.text.slice(0, end + 1), heading: true }, { text: rest, heading: false }];
}

/** Turn the model's plain-text answer into paragraphs. */
export function parseTranscription(raw) {
  let text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  if (!text || (text.includes(NO_TEXT) && text.split(NO_TEXT).join('').trim().length < 3)) return { noText: true, paragraphs: [] };
  // the model sometimes writes the marker next to real text (an ornament beside a header): it is never page content
  text = text.split(NO_TEXT).join(' ').split(String.fromCharCode(10)).map((l) => l.split(' ').filter(Boolean).join(' ')).join(String.fromCharCode(10)).trim();
  // curly braces never occur in a printed Arabic book except as a model's rendering of the ornate verse brackets
  text = text.split('{').join(String.fromCharCode(0xfd3f)).split('}').join(String.fromCharCode(0xfd3e));
  const paragraphs = text
    .split(/\n{2,}/)
    .map((blk) => blk.split('\n').map((l) => l.trim()).filter(Boolean).join(' ').trim())
    .filter(Boolean)
    .map((p) => (p.startsWith('# ') ? { text: p.slice(2).trim(), heading: true } : { text: p, heading: false }))
    .flatMap(splitBracketHeading)
    .map((p) => ({ ...p, text: normalizeShaping(p.text) }));
  return { noText: paragraphs.length === 0, paragraphs };
}

let anthropic = null;
function claudeClient() {
  // reads ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / profile / ANTHROPIC_BASE_URL from the environment
  anthropic ||= new Anthropic({ maxRetries: 4, timeout: 150_000 });
  return anthropic;
}

async function viaClaude(jpeg, model, system = SYSTEM_PROMPT, user = USER_PROMPT, maxTokens = 16000) {
  const response = await claudeClient().messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
        { type: 'text', text: user },
      ],
    }],
  });
  if (response.stop_reason === 'refusal') return { refused: true, text: '', usage: response.usage };
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return { text, truncated: response.stop_reason === 'max_tokens', usage: response.usage };
}

async function viaOllama(jpeg, model, system = SYSTEM_PROMPT, user = USER_PROMPT, maxTokens = 2600, { probs = false, numCtx, timeoutMs, penalty } = {}) {
  const base = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      ...(probs ? { logprobs: true, top_logprobs: 4 } : {}),
      options: { temperature: 0, num_ctx: numCtx || Number(process.env.OLLAMA_NUM_CTX) || 6144, num_predict: maxTokens, ...(penalty ? { repeat_penalty: penalty } : {}) },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user, images: [jpeg.toString('base64')] },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs || Number(process.env.VISION_TIMEOUT_MS) || 170_000),
  });
  if (!res.ok) throw new Error(`Ollama answered HTTP ${res.status}`);
  const body = await res.json();
  if (process.env.VISION_DEBUG) console.error(`ollama: load ${(body.load_duration / 1e9).toFixed(1)}s, prompt ${body.prompt_eval_count} tok ${(body.prompt_eval_duration / 1e9).toFixed(2)}s, out ${body.eval_count} tok ${(body.eval_duration / 1e9).toFixed(2)}s, total ${(body.total_duration / 1e9).toFixed(1)}s`);
  return { text: body.message?.content || '', logprobs: body.logprobs, usage: { input_tokens: body.prompt_eval_count, output_tokens: body.eval_count } };
}

// Qari-OCR was trained with exactly this instruction (page or single line images); other wording makes it chatty.
const QARI_PROMPT = 'Below is the image of one page of a document, as well as some raw textual content that was previously extracted for it. Just return the plain text representation of this document as if you were reading it naturally. Do not hallucinate.';

/** llama.cpp server (OpenAI-compatible API). Answers carry token probabilities in the same shape as Ollama's. */
async function viaLlamaCpp(jpeg, maxTokens = 2000, { probs = false, timeoutMs, penalty } = {}) {
  const base = (process.env.LLAMA_URL || 'http://127.0.0.1:8081').split('/').filter((p, i, a) => p || i < a.length - 1).join('/');
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      temperature: 0,
      max_tokens: maxTokens,
      ...(penalty ? { repeat_penalty: penalty } : {}),
      ...(probs ? { logprobs: true, top_logprobs: 4 } : {}),
      ...(process.env.VISION_NO_CACHE ? { cache_prompt: false } : {}), // benchmarks: repeated images would be answered from the cache
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
        { type: 'text', text: QARI_PROMPT },
      ] }],
    }),
    signal: AbortSignal.timeout(timeoutMs || Number(process.env.VISION_TIMEOUT_MS) || 170_000),
  });
  if (!res.ok) throw new Error(`llama.cpp server answered HTTP ${res.status}`);
  const body = await res.json();
  if (process.env.VISION_DEBUG && body.timings) console.error(`llama.cpp: prompt ${body.timings.prompt_n} tok ${(body.timings.prompt_ms / 1000).toFixed(2)}s, out ${body.timings.predicted_n} tok ${(body.timings.predicted_ms / 1000).toFixed(2)}s`);
  const choice = body.choices?.[0] || {};
  const logprobs = (choice.logprobs?.content || []).map((t) => ({ token: t.token, logprob: t.logprob, bytes: t.bytes, top_logprobs: t.top_logprobs || [] }));
  return { text: choice.message?.content || '', logprobs, truncated: choice.finish_reason === 'length', usage: { input_tokens: body.usage?.prompt_tokens, output_tokens: body.usage?.completion_tokens } };
}

/**
 * Read one page image.
 * @param {Buffer} jpeg page render (JPEG)
 * @returns {Promise<{paragraphs:{text:string,heading:boolean}[], noText:boolean, refused?:boolean, truncated?:boolean, usage?:object, model:string}>}
 */
export async function readPageWithAi(jpeg, { arabicOnly = true, ptPerPx, font, probs = false } = {}) {
  const st = visionStatus();
  if (!st.available) throw new Error('AI reading is not configured (set VISION_PROVIDER)');
  // a local model reads far more accurately line by line (and tells how sure it is); a large cloud model reads the whole page
  const byLines = st.provider !== 'claude' && (process.env.VISION_MODE || 'lines') !== 'page';
  if (byLines) {
    const res = await readPageByLines(jpeg, st.model, { arabicOnly, provider: st.provider, ptPerPx, font, probs });
    if (res) return res;
    // no text line on the page (a cover, an ornament): Qari reads lines, a whole page would not even fit its context
    if (st.provider === 'llamacpp') return { paragraphs: [], noText: true, usage: { output_tokens: 0 }, model: st.model };
  }
  const out = st.provider === 'claude' ? await viaClaude(jpeg, st.model)
    : st.provider === 'llamacpp' ? await viaLlamaCpp(jpeg, 2000)
      : await viaOllama(jpeg, st.model);
  if (out.refused) return { paragraphs: [], noText: false, refused: true, usage: out.usage, model: st.model };
  const parsed = parseTranscription(out.text);
  if (arabicOnly) for (const p of parsed.paragraphs) p.text = p.text.split(' ').map((w) => cleanArabicLetters(w)).filter(Boolean).join(' ');
  return { ...parsed, truncated: out.truncated, usage: out.usage, model: st.model };
}

const cleanArabicLetters = (s) => Array.from(s).filter((ch) => !(/\p{L}/u.test(ch) && !/\p{Script=Arabic}/u.test(ch))).join('');
/** Words the reader is less sure about than this are highlighted in the Word file (AI_FLAG_CONF, 0..1). */
const flagConf = () => Number(process.env.AI_FLAG_CONF) || 0.5;

/**
 * Read the page one text line at a time. Returns null when no lines can be found (the caller then reads the whole page).
 * Each paragraph carries `runs`; a word the model was unsure about gets lowConf and the other possible spellings (alts).
 * The token probabilities behind that are only asked for when they are shown (`probs`, the "highlight uncertain words" option):
 * the server ranks its whole vocabulary on the CPU for every token it writes, which costs about a fifth of the reading time.
 * @param {Buffer} jpeg the (enhanced) page body
 */
export async function readPageByLines(jpeg, model, { arabicOnly = true, provider = 'ollama', ptPerPx, font, probs = false } = {}) {
  const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const boxes = segmentLines(data, w, h);
  if (!boxes.length) return null;
  // a running header (title, page number and a drawn rule) is not read as text: its box is returned so the page keeps it as a picture
  let headerBox = null;
  const ruleY = findFootnoteRule(data, w, h, boxes);
  if (boxes.length > 3 && boxes[0].y1 < h * 0.2 && hasRule(data, w, boxes[0].y0, boxes[0].y1)) headerBox = boxes.shift();
  let tokens = 0;
  // footnote lines are set smaller than the model was trained on (14 pt and up): they are enlarged more, up to the size of the body text
  const isFootBox = (b) => ruleY !== null && (b.y0 + b.y1) / 2 > ruleY;
  const bodyH = median(boxes.filter((b) => !isFootBox(b)).map((b) => b.y1 - b.y0)) || 1;
  // Several lines at once: the model's speed is limited by memory bandwidth while it writes, so Ollama writes parallel lines
  // (OLLAMA_NUM_PARALLEL) in nearly the same time as one. Results are kept in line order.
  const parallel = Math.max(1, Number(process.env.VISION_LINE_PARALLEL) || 8);
  const envNum = (name, d) => (process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : d);
  // white space kept around each line (px). Measured: tighter crops cut the image tokens by a quarter but made the reader drop words
  const lineMargin = envNum('VISION_LINE_MARGIN', 12);
  const linePad = envNum('VISION_LINE_PAD', 20);
  /** Read one line (or the part [left, right) of it) and return its words. */
  async function readBox(box, left = 0, right = w, enlarge = 1) {
    const y0 = Math.max(0, box.y0 - lineMargin);
    const y1 = Math.min(h, box.y1 + lineMargin);
    const crop = await sharp(data, { raw: { width: w, height: h, channels: 1 } })
      .extract({ left, top: y0, width: right - left, height: y1 - y0 })
      .extend({ top: linePad, bottom: linePad, left: 20, right: 20, background: { r: 255, g: 255, b: 255 } })
      .resize({ width: Math.min(2800, Math.round((right - left) * enlarge * (Number(process.env.VISION_LINE_SCALE) || 1.0) * (isFootBox(box) ? Math.min(1.5, Math.max(1, bodyH / (box.y1 - box.y0))) : 1))) })
      .jpeg({ quality: 92 })
      .toBuffer();
    const ask = (penalty) => (provider === 'llamacpp'
      ? viaLlamaCpp(crop, 300, { probs, timeoutMs: 90_000, penalty })
      : viaOllama(crop, model, LINE_SYSTEM_PROMPT, LINE_USER_PROMPT, 300, { probs, numCtx: 2048, timeoutMs: 90_000, penalty }));
    let out;
    try { out = await ask(); } catch { out = await ask(); } // one retry
    let looped = out.truncated || hasLoop(out.text);
    if (looped) { // looping on one word: read the line again with a penalty on repeats
      try { const again = await ask(1.15); if (!again.truncated && !hasLoop(again.text)) { out = again; looped = false; } } catch { /* keep the first answer */ }
    }
    tokens += out.usage?.output_tokens || 0;
    const conf = wordConfidence(out.logprobs || []);
    const words = (conf.words.length ? conf.words : String(out.text || '').split(/\s+/).filter(Boolean).map((t) => ({ text: t, conf: 1, alts: [] })))
      .map((x) => {
        const text = cleanArabicLine(x.text, { arabicOnly });
        const alts = x.alts.map((a) => cleanArabicLine(a.text, { arabicOnly })).filter((a) => a && a !== text);
        return { text, conf: x.conf, alts: [...new Set(alts)] };
      })
      .filter((x) => x.text && x.text !== NO_TEXT);
    // still looping: keep one copy of the repeated word and mark the whole line as doubtful
    let kept = looped ? collapseLoops(words).map((x) => ({ ...x, conf: Math.min(x.conf, 0.2) })) : words;
    // a line with hardly any diacritics was printed without them: marks the model added on its own are removed
    if (isMostlyPlain(kept.map((x) => x.text).join(' '))) kept = kept.map((x) => ({ ...x, text: stripMarks(x.text), alts: x.alts.map((a) => stripMarks(a)) }));
    return kept;
  }
  const read = new Array(boxes.length);
  let next = 0;
  async function worker() {
    while (next < boxes.length) {
      const k = next++;
      read[k] = { ...boxes[k], words: await readBox(boxes[k]), footnote: isFootBox(boxes[k]) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, boxes.length) }, worker));
  await rereadShortLines(read, { w, readBox });
  await markSallaLines(read, { w, readBox });
  const lines = read.filter((l) => l.words.length);
  if (!lines.length) return { paragraphs: [], noText: true, usage: { output_tokens: tokens }, model };
  // The page as it was printed: where the text block sits, how far apart its lines are, and the size that makes a line of the Word
  // document as wide as a printed line (measured with the document font) so lines break where the book breaks them.
  const widest = Math.max(...lines.map((l) => l.x1 - l.x0));
  const full = lines.filter((l) => l.x1 - l.x0 >= widest * 0.9);
  const textBox = { x0: median(full.map((l) => l.x0)), x1: median(full.map((l) => l.x1)), y0: lines[0].y0 };
  const gaps = boxes.slice(1).map((b, i) => b.y0 - boxes[i].y0).filter((g) => g > 0);
  const lineGapPt = ptPerPx && gaps.length ? median(gaps) * ptPerPx : undefined;
  let bodyPt;
  if (ptPerPx) {
    bodyPt = fitFontPt(full.map((l) => ({ text: l.words.map((x) => x.text).join(' '), widthPt: (l.x1 - l.x0) * ptPerPx })), font)
      || (lineGapPt ? Math.min(16, Math.max(11, Math.round((lineGapPt / 2.1) * 2) / 2)) : undefined);
  }
  // footnotes are set smaller: the ratio of their line spacing to the body's
  const pitchOf = (set) => { const g = set.slice(1).map((b, i) => b.y0 - set[i].y0).filter((v) => v > 0); return g.length ? median(g) : 0; };
  const bodyBoxes = lines.filter((l) => !l.footnote);
  const footBoxes = lines.filter((l) => l.footnote);
  const footRatio = pitchOf(bodyBoxes) && pitchOf(footBoxes) ? Math.min(0.9, Math.max(0.62, pitchOf(footBoxes) / pitchOf(bodyBoxes))) : 0.75;
  return { paragraphs: unifyDigits(fixNoteNumbers(groupLines(lines)), arabicOnly), noText: false, usage: { output_tokens: tokens }, model, mode: 'lines', bodyPt, lineGapPt, textBox, headerBox, footRatio };
}

const lettersOf = (words) => words.reduce((n, x) => n + stripMarks(x.text).length, 0);

/**
 * The reader now and then skips part of a line (the start of a verse after its ornate bracket, the second half of a poetry line).
 * Such a line says far fewer letters than its ink is wide, measured against the page's own full lines. It is read again enlarged
 * (measured: the skipped words come back at 1.4x), and the new reading replaces it when it says clearly more and keeps what it said.
 */
export async function rereadShortLines(read, { w, readBox }) {
  const density = (l) => lettersOf(l.words) / Math.max(1, l.x1 - l.x0);
  const typical = median(read.filter((l) => l.words.length >= 4 && l.x1 - l.x0 > w * 0.6).map(density));
  if (!typical) return 0;
  let replaced = 0;
  const short = read.filter((l) => l.words.length && l.x1 - l.x0 > w * 0.4 && density(l) < typical * 0.7);
  await Promise.all(short.slice(0, 6).map(async (l) => {
    const words = await readBox(l, 0, w, 1.4);
    const before = new Set(l.words.map((x) => stripMarks(x.text)));
    const kept = words.filter((x) => before.has(stripMarks(x.text))).length;
    if (process.env.VISION_DEBUG) console.error('reread', (density(l) / typical).toFixed(2), l.words.map((x) => x.text).join(' '), '=>', words.map((x) => x.text).join(' '));
    if (lettersOf(words) >= lettersOf(l.words) * 1.2 && kept >= before.size * 0.6) { l.words = words; replaced++; }
  }));
  return replaced;
}

const SALLA = 'ﷺ';
const letterSim = (a, b) => {
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
};

/**
 * The reader cannot read the ﷺ ligature: it writes a junk word for it, a different one at every reading ("مَيْتٍ،", then "وَكَمْ،",
 * then "بَكِّي،" for the same glyph), while a real word after "رسول الله" ("وَفْدُ") reads the same each time. A line with a mention of
 * the Prophet is read again enlarged, and the word after the mention becomes ﷺ where the two readings disagree.
 */
export async function markSallaLines(read, { w, readBox }) {
  let marked = 0;
  const lines = read.filter((l) => l.words.length && sallaSlots(l.words.map((x) => x.text)).length);
  await Promise.all(lines.slice(0, 12).map(async (l) => {
    const again = (await readBox(l, 0, w, 1.4)).map((x) => x.text);
    const slotsA = sallaSlots(l.words.map((x) => x.text));
    const slotsB = sallaSlots(again);
    if (slotsA.length !== slotsB.length) return; // the readings do not line up: nothing is changed
    const same = (x, y, min = 0.5) => letterSim(sallaLetters(x), sallaLetters(y)) >= min;
    for (const [n, i] of [...slotsA.entries()].reverse()) { // from the end: an insertion does not move the slots before it
      const j = slotsB[n];
      const a = l.words[i].text;
      if (process.env.VISION_DEBUG) console.error('salla', a, '|', again.slice(j, j + 4).join(' '));
      if (same(a, again[j])) continue; // read the same twice: a real word
      // the word comes a little later in the second reading ("رَسُولُ اللهِ مَكَّةَ" / "رَسُولُ اللهِ وَلِيُّ مَكَّةَ", "… مُلْكًا،" /
      // "… وَلِهِ قَد اسْتَلَبَهُ مُلْكًا"): a real word, and the first reading dropped the glyph (and maybe more) before it
      if (again.slice(j + 1, j + 5).some((x) => same(a, x, 0.75))) {
        l.words.splice(i, 0, { text: SALLA, conf: 1, alts: [] });
        marked++;
        continue;
      }
      if (!sallaLetters(a)) { // only punctuation after the name ("بِالرَّسُولِ ]"), where the second reading saw a (junk) word
        const b = sallaLetters(again[j]);
        if (b && b.length <= 4) { l.words.splice(i, 0, { text: SALLA, conf: 1, alts: [] }); marked++; }
        continue;
      }
      if (sallaLetters(a).length > 7) continue;
      l.words[i] ={ ...l.words[i], text: a.replace(/[\p{L}\p{M}ـ]+/u, SALLA), conf: 1, alts: [] };
      marked++;
    }
  }));
  return marked;
}

/** Fewer than one diacritic per four letters: the printed line has none (any marks in the answer were added by the model). */
export function isMostlyPlain(text) {
  const s = String(text).split(' ').join('');
  const letters = stripMarks(s).length;
  return letters > 0 && (s.length - letters) / letters < 0.25;
}

/** A small model sometimes loops on one word until it runs out of tokens: four identical words in a row (letters only) is never real text. */
export function hasLoop(text) {
  const w = String(text).split(' ').filter(Boolean).map((x) => stripMarks(x));
  let run = 1;
  for (let i = 1; i < w.length; i++) {
    run = w[i] === w[i - 1] ? run + 1 : 1;
    if (run >= 4) return true;
  }
  return false;
}

/** Keep one occurrence of a word repeated 3+ times in a row. */
export function collapseLoops(words) {
  const out = [];
  for (const x of words) {
    const n = out.length;
    if (n >= 2 && stripMarks(out[n - 1].text) === stripMarks(x.text) && stripMarks(out[n - 2].text) === stripMarks(x.text)) continue;
    out.push(x);
  }
  return out;
}

/**
 * Font size (points) at which the full-width printed lines fill the same width in `fontName` (default Traditional Arabic, the
 * converter's default). Null when the font is not installed on this machine (then the caller falls back to the line spacing).
 */
export function fitFontPt(fullLines, fontName = 'Traditional Arabic') {
  if (!fullLines.length) return null;
  const ctx = createCanvas(10, 10).getContext('2d');
  const probe = 'قالَ ابنُ إسْحاقَ وقَدِمَ على رَسُولِ اللهِ';
  ctx.font = `100px "${fontName}"`;
  const known = ctx.measureText(probe).width;
  ctx.font = '100px "NoSuchFontXYZ"';
  if (Math.abs(known - ctx.measureText(probe).width) < 1) return null;
  ctx.font = `100px "${fontName}"`;
  const sizes = fullLines.map((l) => (l.widthPt / Math.max(1, ctx.measureText(l.text).width)) * 100 * 0.9).filter((v) => v > 0);
  if (!sizes.length) return null;
  return Math.min(22, Math.max(12, Math.round(median(sizes) * 2) / 2));
}

const INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const indic = (n) => String(n).split('').map((c) => INDIC_DIGITS[Number(c)]).join('');

/**
 * Footnotes are numbered 1, 2, 3 ... on every page, and the tiny numbers are what the reader misreads most ((١) read as (٢) or (ه)).
 * The n-th note that starts with a parenthesised number gets n; a reference "(ا)" in the text is the first note's reference (١).
 */
/**
 * A book set with Arabic-Indic digits (٠-٩) has no Western ones: when the page has at least one Arabic-Indic digit, the Western digits the
 * reader mixed in ("7", "11") are written as Arabic-Indic too. A page with only Western digits is left as it is.
 */
export function unifyDigits(paragraphs, arabic = true) {
  if (!arabic) return paragraphs;
  const all = paragraphs.map((p) => p.text).join(' ');
  if (![...all].some((c) => INDIC_DIGITS.includes(c))) return paragraphs;
  const conv = (s) => [...s].map((c) => (c >= '0' && c <= '9' ? INDIC_DIGITS[Number(c)] : c)).join('');
  for (const p of paragraphs) {
    p.text = conv(p.text);
    for (const r of p.runs || []) r.text = conv(r.text);
  }
  return paragraphs;
}

export function fixNoteNumbers(paragraphs) {
  let n = 0;
  for (const p of paragraphs) {
    if (p.footnote) {
      const close = p.text.indexOf(')');
      if (!p.text.startsWith('(') || close < 2 || close > 5) {
        // no number: a note that starts at the right edge (no hanging indent) lost its number to the reader; an indented line continues the note above
        if (!p.indent) {
          n++;
          p.text = `(${indic(n)}) ${p.text}`;
          if (p.runs.length) p.runs[0].text = `(${indic(n)}) ${p.runs[0].text}`;
        }
        continue;
      }
      n++;
      const fixed = indic(n);
      replaceRange(p.runs, 1, close, fixed);
      p.text = `(${fixed})${p.text.slice(close + 1)}`;
    } else {
      for (const r of p.runs || []) r.text = r.text.split('(ا)').join('(١)');
      p.text = p.text.split('(ا)').join('(١)');
    }
  }
  return paragraphs;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/**
 * Lines -> paragraphs and headings from the geometry of the page: a paragraph ends on a line that stops short of the left edge
 * (right-to-left text) and a new one starts on an indented line; a short, centred line or a [bracketed] title is a heading.
 */
export function groupLines(lines) {
  const widths = lines.map((l) => l.x1 - l.x0);
  const maxW = Math.max(...widths);
  const fullLines = lines.filter((l) => l.x1 - l.x0 >= maxW * 0.9);
  const R = median(fullLines.map((l) => l.x1));
  const L = median(fullLines.map((l) => l.x0));
  const span = Math.max(1, R - L);
  const endsEarly = (l) => l.x0 > L + span * 0.1;
  const indented = (l) => l.x1 < R - span * 0.04;
  const centred = (l) => Math.abs((l.x0 - L) - (R - l.x1)) <= span * 0.06 && l.x1 - l.x0 < span * 0.9;

  // a [bracketed] title is printed alone on its line, whatever its width
  const lineText = (l) => l.words.map((x) => x.text).join(' ');
  const isTitle = (l) => { const t = lineText(l); return t.startsWith('[') && t.endsWith(']'); };
  const groups = [];
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    if (!prev || endsEarly(prev) || indented(l) || isTitle(l) || isTitle(prev)) groups.push([]);
    groups[groups.length - 1].push(l);
  });

  return groups.map((g) => {
    const words = g.flatMap((l) => l.words);
    const text = words.map((x) => x.text).join(' ');
    const bracket = text.startsWith('[') && text.endsWith(']');
    const heading = g.length === 1 && (bracket || (centred(g[0]) && words.length <= 6));
    // a longer centred line is a line of poetry: centred, but in the size and weight of the body
    const center = !heading && g.length === 1 && centred(g[0]);
    const flag = flagConf();
    const runs = [];
    let plain = '';
    words.forEach((x, i) => {
      const piece = normalizeShaping(x.text);
      const space = i < words.length - 1 ? ' ' : '';
      if (x.conf < flag) {
        if (plain) runs.push({ text: plain, lowConf: false });
        runs.push({ text: piece, lowConf: true, alts: x.alts.length ? x.alts : undefined });
        plain = space;
      } else plain += piece + space;
    });
    if (plain) runs.push({ text: plain, lowConf: false });
    // how far the first line starts from the right edge of the text block (an indented paragraph)
    const indent = heading || center ? 0 : Math.max(0, R - g[0].x1);
    return { text: normalizeShaping(text), heading, center, footnote: g.every((l) => l.footnote), indent: indent > span * 0.03 ? indent : 0, runs };
  });
}

/** Page model paragraphs (flow layout) from the transcription. */
export function paragraphsToBlocks(paragraphs, { bodyPt, ptPerPx, lineGapPt, footRatio = 0.75 } = {}) {
  const chars = paragraphs.reduce((s, p) => s + p.text.length, 0);
  let body = 12;
  if (chars <= 1400) body = 15;
  else if (chars <= 1800) body = 14;
  else if (chars <= 2300) body = 13;
  if (bodyPt) body = bodyPt; // measured from the page: the size the book is printed in
  return paragraphs.map((p, idx) => {
    const dir = dominantDirection(p.text) || 'rtl';
    const fs = p.heading ? body + 4 : p.footnote ? Math.round(body * footRatio * 2) / 2 : body;
    return {
      type: 'p',
      runs: p.runs ? p.runs.map((r) => ({ text: r.text, fs, bold: !!(p.heading || r.verse), italic: false, lowConf: r.lowConf || undefined, alts: r.alts })) : [{ text: p.text, fs, bold: p.heading, italic: false }],
      dir,
      align: p.heading || p.center ? 'center' : (p.text.length > 200 ? 'both' : 'start'),
      fs,
      lineCount: p.heading ? 1 : Math.max(1, Math.ceil(p.text.length / 70)),
      lineGap: lineGapPt ? lineGapPt * 0.97 * (p.footnote ? footRatio : 1) : null,
      footnote: !!p.footnote,
      footRatio: p.footnote ? footRatio : undefined,
      ruleAbove: !!p.footnote && !(paragraphs[idx - 1] && paragraphs[idx - 1].footnote),
      firstLine: p.indent && ptPerPx ? p.indent * ptPerPx : 0,
      ocr: true, // lets the Quran guard also look for verses that have no brackets
      ai: true,
    };
  });
}

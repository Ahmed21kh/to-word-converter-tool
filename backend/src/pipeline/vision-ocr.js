// "AI reading" of page images with a vision model: far more accurate than Tesseract on diacritised Arabic books.
//
// Providers (set VISION_PROVIDER):
//   claude  - Anthropic API through the official SDK. Needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / an
//             `ant auth login` profile). Pages are sent to Anthropic. Billed per use.
//   gemini  - Google Gemini API through the official @google/genai SDK. Needs GEMINI_API_KEY; GEMINI_MODEL picks the model
//             (default gemini-3.8-flash, a fixed version: an alias such as gemini-flash-latest moves to a new model, with a
//             quota of its own, without notice). Pages are sent to Google.
//   ollama  - a local model served by Ollama (free, nothing leaves your machine), e.g. VISION_MODEL=qwen2.5vl:7b.
//   llamacpp - a local llama.cpp server (the llama-server.exe that ships with Ollama) running Qari-OCR, a 2B model trained on
//             diacritised Arabic. Free, local, much smaller and faster than a general 7B model. See scripts/start-qari.ps1.
//
// LOCAL_AI=1 switches to the local reader (LOCAL_AI_PROVIDER: llamacpp by default, or ollama) and turns the cloud provider off.
//
// Everything else (layout, Quran verification, docx) is shared with the normal pipeline.
import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { dominantDirection, normalizeShaping, stripMarks, dropShortVowels, fixDaggerAlef } from './arabic.js';
import { replaceRange, matchKey, rasmKey } from './quran.js';
import { sallaSlots, sallaLetters } from './honorifics.js';
import { createCanvas } from '@napi-rs/canvas';
import { segmentLines, isHeadLine, footNumberBox, findFootnoteRule, lineOrnament, isolateLine, lineGaps, markVerses, findSeparators, textBlock, findLeader } from './text-lines.js';
import { wordConfidence } from './token-confidence.js';
import { lineNumbers, readPageDigits } from './page-digits.js';
import { findSalla } from './salla-glyph.js';
import { batchKey, batchAnswer, queueRequest, restRequest, DeferredRead } from './gemini-batch.js';
import pRetry from 'p-retry';
import { withGemini, holdGemini, withLocalReader } from '../services/gemini-throttle.js';

const DEFAULT_MODELS = { claude: 'claude-opus-5-5', gemini: 'gemini-3.8-flash', ollama: 'qwen2.5vl:7b', llamacpp: 'qari-ocr' };
const CLOUD = ['claude', 'gemini'];
const LOCAL = ['ollama', 'llamacpp'];

export const NO_TEXT = '[[NO_TEXT]]';

export function visionStatus() {
  const local = /^(1|true|yes|on)$/i.test((process.env.LOCAL_AI || '').trim());
  const provider = (local ? process.env.LOCAL_AI_PROVIDER || 'llamacpp' : process.env.VISION_PROVIDER || '').trim().toLowerCase();
  if (!(local ? LOCAL : [...CLOUD, ...LOCAL]).includes(provider)) return { available: false, provider: null, model: null };
  const model = provider === 'gemini' ? process.env.GEMINI_MODEL || DEFAULT_MODELS.gemini : process.env.VISION_MODEL || DEFAULT_MODELS[provider];
  return { available: true, provider, model, external: CLOUD.includes(provider) };
}

// Shared by every prompt: the reader works on Arabic only, and the letters that differ by dots only are where it goes wrong.
const ARABIC_FOCUS = [
  'LANGUAGE: the text is Arabic (classical, usually fully diacritised, from a printed book). Think and write in Arabic script only.',
  'Never translate, explain, describe the image, answer in English or any other language, or transliterate.',
  'Letters that differ only by their dots look alike: ف/ق, ب/ت/ث/ن/ي, ج/ح/خ, د/ذ, ر/ز, س/ش, ص/ض, ط/ظ, ع/غ, ه/ة.',
  'Decide each one from the number and position of the dots actually printed, never from what the word "should" be.',
  'Copy the printed words even when they look like a misspelling or an unusual word; never replace a word by a more common one.',
].join('\n');

// What a cloud reader writes for a word it cannot read with certainty; the word is highlighted in the Word file (markIllegible)
export const ILLEGIBLE = '⟦؟⟧';

// The page prompt of every cloud reader (and of a local model told VISION_MODE=page). It is the same for every page, so a
// provider's prompt cache can serve it. Verses are copied as printed and never completed from memory: the Quran guard checks them
// against the Mushaf afterwards, and a verse "remembered" past the page is the commonest invented text.
const SYSTEM_PROMPT = [
  'You are a meticulous OCR engine for printed Arabic books. Transcribe ALL the text on the page image exactly as it is printed.',
  '',
  ARABIC_FOCUS,
  '',
  'Fidelity:',
  '- Copy only what is printed. Never add, remove, correct, complete or modernise a letter, word, diacritic or spelling.',
  '- Keep every diacritic exactly where it is printed: fatha, damma, kasra, sukun, shadda together with its vowel, the three tanween,',
  '  dagger alif (ٰ), madda, hamza above or below, wasla (ٱ). A word printed without marks stays without marks: never vowel it yourself.',
  `- A word you cannot read with certainty (faded, smudged, torn, cut off at the edge) is written ${ILLEGIBLE}, one per word.`,
  '  Never guess it from the context or from memory. A few marked words are far better than one invented word.',
  '- Quranic verses printed between ornate brackets stay between ﴿ and ﴾, exactly as printed. Write only the verse words',
  '  printed on this page, even when you know the verse by heart: never continue or complete it from memory.',
  '- The calligraphic honorific glyph for "salla Allahu alayhi wa sallam" is written ﷺ (one character). Printed as words, it stays words.',
  '- Digits keep their printed script (Arabic-Indic ٠-٩ stay Arabic-Indic). Citations such as [آل عمران: ٣] stay in their paragraph.',
  '',
  'Order and form:',
  '- Reading order is right-to-left within a line, lines top to bottom, the right column before the left one.',
  '- Write normal Unicode Arabic in logical order: never reverse the letters of a word or the words of a line, and never use',
  '  Arabic presentation forms.',
  '- Keep every punctuation mark and symbol (، ؛ ؟ « » ( ) [ ] ﴿ ﴾ * and the like) where it is printed.',
  '- Separate paragraphs with one blank line. Inside a paragraph join the printed lines with single spaces.',
  '- A centred or bold section heading goes on its own line prefixed with "# ".',
  '- A running header or page number is never part of a paragraph: put it on its own line.',
  '- A line of poetry printed in two halves side by side goes on its own line: its right half, then " // ", then its left half.',
  '- Footnotes (the notes printed below the short rule at the foot of the page) come last, after a line holding only "---".',
  '  Each note, opening with its number such as (١), is a paragraph of its own: never join two notes or a note and the text.',
  '- A table: one line per row, cells separated by " | ".',
  `- If the page has no readable text (cover art, ornaments, a blank page) output exactly: ${NO_TEXT}`,
  '',
  'Output the transcription only, from the first printed word to the last: no introduction, commentary, translation, notes,',
  'markdown other than "# ", or code fences.',
].join('\n');

const USER_PROMPT = 'Transcribe this page.';
// a band of a page (readInBands): it is cut between lines, and the reader must not finish a sentence or verse the cut stopped
const bandPrompt = (k, n) => `Transcribe this image: part ${k + 1} of ${n} of a page, cut between lines. It may start or end in the middle of a sentence or a verse: copy it as printed, never complete it.`;

// One text line at a time: the image is small and sharp, so the model sees every dot and diacritic.
// Measured on a diacritised page (680 letters): this wording reads 97.5% of the letters. A longer prompt with rules about Arabic or
// about the dots made the 7B model worse (93-95%), and so did dropping the bracket sentence, so "Arabic only" is enforced afterwards
// by cleanArabicLine, and a second reading with another prompt was no help (both readings repeat the same mistakes).
const LINE_SYSTEM_PROMPT = `You are a meticulous OCR engine for Arabic books. Transcribe the text of this image exactly as printed, keeping every diacritic. Quran brackets stay between ${String.fromCharCode(0xfd3f)} and ${String.fromCharCode(0xfd3e)}. Output only the text.`;
const LINE_USER_PROMPT = 'Transcribe this line.';

/**
 * What a reader writes for a picture it cannot read (a cover photo): Markdown images "![](https://i.imgur.com/....jpg)", links to
 * image files. No printed page holds them, and a library such as Shamela takes them for pictures. A website the book prints stays.
 */
export function dropImageLinks(text) {
  return String(text)
    .replace(/!\[[^\]]*\]\([^)]*\)?/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\S*https?:\/\/\S*\.(?:jpe?g|png|gif|webp|bmp|svg)\S*/gi, ' ')
    .replace(/\S*i\.imgur\.com\S*/gi, ' ');
}

/** Drops letters of other scripts (a vision model sometimes drifts into Latin or Chinese) and ornate brackets mis-read from a "و". */
export function cleanArabicLine(text, { arabicOnly = true } = {}) {
  let out = '';
  for (const ch of dropImageLinks(String(text))) {
    if (arabicOnly && /\p{L}/u.test(ch) && !/\p{Script=Arabic}/u.test(ch)) continue;
    if (!/[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Z}]/u.test(ch)) continue; // control / private-use junk
    out += ch;
  }
  for (const o of [String.fromCharCode(0xfd3e), String.fromCharCode(0xfd3f), '{', '}']) out = out.split(o).join('');
  for (const o of ['♠', '♣', '♥', '♦', '◆', '◇', '❖', '❋', '✦']) out = out.split(o).join('*');
  // the book's guillemets, written as CJK double angle brackets ("الحضرمية 》")
  out = out.split('《').join('«').split('》').join('»');
  // empty parentheses / "()*" are what is left of a verse bracket the reader could not make out
  for (const junk of ['()*', '( )', '()']) out = out.split(junk).join(' ');
  // a box of catalogue data comes back as a Markdown table ("| | |---|---| | ردمك: ..."): no printed Arabic line has a "|"
  out = out.split('|').join(' ');
  return out.split(' ').filter((t) => t && !/^[-:]{3,}$/.test(t)).join(' ');
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
  let text = dropImageLinks(String(raw || '')).replace(/\r\n?/g, '\n').trim();
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  if (!text || (text.includes(NO_TEXT) && text.split(NO_TEXT).join('').trim().length < 3)) return { noText: true, paragraphs: [] };
  // the model sometimes writes the marker next to real text (an ornament beside a header): it is never page content
  text = text.split(NO_TEXT).join(' ').split(String.fromCharCode(10)).map((l) => l.split(' ').filter(Boolean).join(' ')).join(String.fromCharCode(10)).trim();
  // curly braces never occur in a printed Arabic book except as a model's rendering of the ornate verse brackets
  text = text.split('{').join(String.fromCharCode(0xfd3f)).split('}').join(String.fromCharCode(0xfd3e));
  const paragraphs = text
    .split(/\n{2,}/)
    .flatMap((blk) => {
      // the lines of a block join into one paragraph, but for a verse ("right half // left half"): a paragraph of its own
      const out = [];
      let prose = [];
      for (const l of blk.split('\n').map((x) => x.trim()).filter(Boolean)) {
        if (l.split(VERSE_HALVES).length === 2) { if (prose.length) out.push(prose.join(' ')); prose = []; out.push(l); } else prose.push(l);
      }
      if (prose.length) out.push(prose.join(' '));
      return out;
    })
    .filter(Boolean)
    .map((p) => (p.startsWith('# ') ? { text: p.slice(2).trim(), heading: true } : { text: p, heading: false }))
    .flatMap(splitBracketHeading)
    .map((p) => {
      const halves = p.text.split(VERSE_HALVES);
      if (halves.length !== 2 || p.heading) return { ...p, text: normalizeShaping(halves.join(' ')) };
      const [a, b] = halves.map((x) => normalizeShaping(x.trim()));
      return { text: `${a} ${b}`, heading: false, poem: true, runs: [{ text: `${a} `, tab: true }, { text: b, tab: true }] };
    });
  return { noText: paragraphs.length === 0, paragraphs };
}

// what a cloud reader writes between the two halves of a verse (SYSTEM_PROMPT)
const VERSE_HALVES = /\s+\/\/\s+/;

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
  if (response.stop_reason === 'refusal') return { refused: true, reason: 'refusal', text: '', usage: response.usage };
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return { text, truncated: response.stop_reason === 'max_tokens', usage: response.usage };
}

let gemini = null;
export function geminiClient() {
  // GEMINI_BASE_URL only points the SDK at another endpoint (the tests' mock)
  gemini ||= new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      // well inside the page's time limit (PAGE_TIMEOUT_MS), so a page Gemini is slow on is still read by the standard OCR
      // a page answers in 10-20 s; a minute without an answer is an overloaded model, and the next one is asked (viaGemini)
      timeout: Number(process.env.GEMINI_TIMEOUT_MS) || 60_000,
      // no retries in the SDK: viaGemini retries (p-retry), each attempt in a turn of the server-wide limit (gemini-throttle.js)
      ...(process.env.GEMINI_BASE_URL ? { baseUrl: process.env.GEMINI_BASE_URL } : {}),
    },
  });
  return gemini;
}

// an answer Gemini stopped itself: safety filters, or "recitation" (a long Quran passage can be held back as quoted text)
const GEMINI_STOPPED = ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'OTHER'];
// Classical fiqh, history and hadith speak of war, punishment and the body: the default filters stop such pages for nothing.
// RECITATION is not a filter setting and cannot be switched off (readCloudPage reads such a page in bands).
const GEMINI_SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
  .map((category) => ({ category, threshold: 'BLOCK_NONE' }));
// Gemini 3 prices an image by this setting, not by its pixels: HIGH is about 1120 tokens, MEDIUM about 560. Set for page reads only:
// a line image (a running head) needs no more than the default.
const pageMedia = () => process.env.GEMINI_MEDIA_RESOLUTION || 'MEDIA_RESOLUTION_HIGH';

/** A live answer (SDK object) or a batch answer (plain JSON): the same fields. Thought parts are never page text. */
function readGeminiAnswer(r, model) {
  const usage = {
    input_tokens: r.usageMetadata?.promptTokenCount,
    output_tokens: r.usageMetadata?.candidatesTokenCount,
    cached_tokens: r.usageMetadata?.cachedContentTokenCount || 0,
  };
  const cand = r.candidates?.[0];
  const reason = r.promptFeedback?.blockReason || cand?.finishReason;
  const text = (cand?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (r.promptFeedback?.blockReason || GEMINI_STOPPED.includes(reason)) return { refused: true, reason, text: '', usage, model };
  return { text, truncated: reason === 'MAX_TOKENS', usage, model };
}

// Models whose quota is used up are not asked again before Google says (per page worker): the free tier allows only a few
// requests a day for the larger models, and each refused request would otherwise cost the page its time.
const geminiBlocked = new Map(); // model -> time it may be asked again
// How each model is told not to think: copying text needs no thinking (it costs time and output tokens), but the models take
// different settings (3.x Flash: thinkingBudget 0; Flash-Lite: thinkingLevel MINIMAL; Pro cannot switch it off). A model that
// rejects the setting is asked again without it, and remembered.
const geminiThinking = new Map();
const thinkingFor = (m) => (geminiThinking.has(m) ? geminiThinking.get(m)
  : /pro/i.test(m) ? null : /lite/i.test(m) ? { thinkingLevel: 'MINIMAL' } : { thinkingBudget: 0 });
const geminiNoMedia = new Set(); // models that refused mediaResolution

/** How long Google asks to wait after a 429 ("Please retry in 12h31m27.9s", or a RetryInfo "45s"), in ms; null when not said. */
export function geminiRetryMs(message) {
  const s = String(message || '');
  const info = s.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (info) return Math.round(Number(info[1]) * 1000);
  const m = s.match(/retry in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return Math.round(((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0)) * 1000);
}

/**
 * @param {object} [o]
 * @param {{dir:string, collect?:boolean}} [o.batch] the answers of a batch job (gemini-batch.js); `collect` queues the request
 *   instead of sending it (pass 1 of a batch conversion) and throws DeferredRead
 * @param {{name:string, model:string, system:string}} [o.cache] an explicit context cache made for one model and system prompt
 * @param {string} [o.media] mediaResolution of the image
 * @param {number} [o.deadline] how long the request may wait for its turn (ms since the epoch)
 */
async function geminiOnce(jpeg, model, system, user, maxTokens, { batch, cache, media, deadline } = {}) {
  const thinking = thinkingFor(model);
  if (geminiNoMedia.has(model)) media = undefined;
  const maxOutputTokens = thinking ? maxTokens : maxTokens + 8192;
  if (batch?.dir) {
    const key = batchKey(model, system, user, maxTokens, jpeg);
    const answer = await batchAnswer(batch.dir, key);
    if (answer) return readGeminiAnswer(answer, model);
    if (batch.collect) {
      await queueRequest(batch.dir, key, restRequest({ system, user, jpeg, maxOutputTokens, thinking, mediaResolution: media, safetySettings: GEMINI_SAFETY }));
      throw new DeferredRead();
    }
  }
  // a cache belongs to one model and one system prompt: a fallback model, or a line read, gets the instruction inline
  const cached = cache && cache.model === model && cache.system === system;
  let response;
  try {
    // the turn is given back before any second request below
    response = await withGemini(() => geminiClient().models.generateContent({
      model,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
          { text: user },
        ],
      }],
      config: {
        // with a cache the system instruction is the cache's own: sending it again is refused
        ...(cached ? { cachedContent: cache.name } : { systemInstruction: system }),
        temperature: 0,
        maxOutputTokens,
        safetySettings: GEMINI_SAFETY,
        ...(media ? { mediaResolution: media } : {}),
        ...(thinking ? { thinkingConfig: thinking } : {}),
      },
    }), { deadline });
  } catch (err) {
    // the cache expired or was deleted: the page is read without it
    if (cached && (err?.status === 403 || err?.status === 404)) return geminiOnce(jpeg, model, system, user, maxTokens, { batch, media, deadline });
    if (err?.status !== 400) throw err;
    // a setting the model does not take: thinking first (as before), then the media resolution; each is remembered
    if (thinking) geminiThinking.set(model, null);
    else if (media) geminiNoMedia.add(model);
    else throw err;
    return geminiOnce(jpeg, model, system, user, maxTokens, { batch, cache, media, deadline });
  }
  return readGeminiAnswer(response, model);
}

/**
 * An explicit context cache of the page prompt with a worked example: GEMINI_EXEMPLAR is a page image (JPEG) of the kind of book
 * being converted, with its checked transcription next to it (same name, .txt). The prompt alone (about 700 tokens) is below the
 * size Google caches and is discounted by its implicit caching anyway; the example (about 5k tokens) is what makes a cache worth
 * having, and the cache is what makes the example affordable on every page. Made once per job (main thread), passed to the page
 * workers, deleted at the end. Null without an example, or when Google declines (a model without caching): pages go uncached.
 * @returns {Promise<{name:string, model:string, system:string}|null>}
 */
export async function createPageCache(model, { ttlSeconds = 2 * 3600 } = {}) {
  const file = process.env.GEMINI_EXEMPLAR;
  if (!file) return null;
  try {
    const [jpeg, text] = await Promise.all([readFile(file), readFile(file.replace(/\.[a-z]+$/i, '.txt'), 'utf8')]);
    const c = await geminiClient().caches.create({
      model,
      config: {
        displayName: 'arabic-ocr-page',
        ttl: `${ttlSeconds}s`,
        systemInstruction: SYSTEM_PROMPT,
        contents: [
          { role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }, { text: USER_PROMPT }] },
          { role: 'model', parts: [{ text: text.trim() }] },
        ],
      },
    });
    return { name: c.name, model, system: SYSTEM_PROMPT };
  } catch {
    return null;
  }
}

export async function deletePageCache(cache) {
  if (cache?.name) await geminiClient().caches.delete({ name: cache.name }).catch(() => {});
}

/** The models tried after GEMINI_MODEL (GEMINI_FALLBACK_MODEL, comma separated; empty = none). */
export const geminiFallbacks = () => (process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-3.5-flash-lite').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Read with Gemini, over the chain GEMINI_MODEL, then GEMINI_FALLBACK_MODEL (default gemini-3.5-flash-lite: a model of its own
 * capacity and its own daily quota). One p-retry loop of up to GEMINI_RETRIES (2) retries:
 *   - Google's load (503 overloaded, 504 / no answer within GEMINI_TIMEOUT_MS, the connection dropped): the next model of the
 *     chain is asked at once, and only a return to the first one waits, an exponential pause from GEMINI_RETRY_PAUSE_MS (2 s: 2,
 *     4, 8, 16 s, each up to twice that at random, so the pages of a book do not all come back at the same moment);
 *   - a per-minute limit (429, Google says to wait seconds): every request of the server waits that long (holdGemini), then
 *     the same model is asked again;
 *   - a daily limit (429, hours): the model is left out of the chain until Google's reset time, and the next one is asked at once.
 * `o`: batch / cache / media, as geminiOnce.
 */
async function viaGemini(jpeg, model, system = SYSTEM_PROMPT, user = USER_PROMPT, maxTokens = 16000, o = {}) {
  const chain = [...new Set([model, ...geminiFallbacks()])];
  const usable = () => chain.filter((m) => (geminiBlocked.get(m) || 0) <= Date.now());
  // retries end in time for the page's own limit (PAGE_TIMEOUT_MS), so a page that cannot be read still gets the standard OCR
  const deadline = Date.now() + (Number(process.env.GEMINI_RETRY_BUDGET_MS) || 60_000);
  const retries = Number(process.env.GEMINI_RETRIES) >= 0 && process.env.GEMINI_RETRIES !== '' ? Math.floor(Number(process.env.GEMINI_RETRIES)) : 2;
  // how long a per-minute limit asks to wait, when that still fits in the time left; null for anything else
  const shortWait = (err) => {
    const wait = err?.status === 429 ? geminiRetryMs(err.message) : null;
    return wait !== null && wait <= 65_000 && Date.now() + wait + 500 < deadline ? wait + 500 : null;
  };
  let turn = 0; // the attempt's place in the chain of usable models
  let asked = null;
  let quotaErr = null;
  try {
    return await pRetry(() => {
      const models = usable();
      if (!models.length) throw Object.assign(new Error('Gemini quota used up (free tier daily limit): try again later or enable billing'), { cause: quotaErr, quota: true });
      asked = models[turn % models.length];
      return geminiOnce(jpeg, asked, system, user, maxTokens, { ...o, deadline });
    }, {
      retries,
      factor: 2,
      minTimeout: Number(process.env.GEMINI_RETRY_PAUSE_MS) || 2000,
      maxTimeout: 30_000,
      randomize: true,
      maxRetryTime: Math.max(1, deadline - Date.now()),
      // what the failure means for the next attempt; a retry (and its pause) is spent only on a round of the chain
      shouldConsumeRetry: ({ error }) => {
        if (shortWait(error) !== null || error?.quota) return true;
        if (error?.status === 429) { // the daily limit: until Google's reset
          geminiBlocked.set(asked, Date.now() + Math.max(geminiRetryMs(error.message) ?? 60_000, 60_000));
          quotaErr = error;
          return false;
        }
        if (!geminiTransient(error)) return true;
        turn++;
        return turn % Math.max(1, usable().length) === 0;
      },
      onFailedAttempt: ({ error }) => { const wait = shortWait(error); if (wait) holdGemini(wait); },
      // never asked again: a bad request, a request queued for a batch, one that found no free turn in time, no model left
      shouldRetry: ({ error, retryDelay }) => {
        if (error?.quota || !usable().length) return false;
        if (shortWait(error) !== null || error?.status === 429) return true;
        return geminiTransient(error) && Date.now() + retryDelay + 15_000 < deadline;
      },
    });
  } catch (err) {
    if (err?.status === 429 && !usable().length) throw Object.assign(new Error('Gemini quota used up (free tier daily limit): try again later or enable billing'), { cause: err });
    throw err;
  }
}

/**
 * A failure that is Google's load or the network, not the page: overloaded, server error, no answer in time (the SDK aborts
 * the request: "This operation was aborted"), or the connection failed or dropped (Node's fetch: "fetch failed", with the
 * socket's own code in `cause`).
 */
const NETWORK = /timed? ?out|deadline|abort|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR|socket|other side closed|network/i;
export function geminiTransient(err) {
  if ([500, 502, 503, 504].includes(err?.status)) return true;
  if (err?.status) return false;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  return NETWORK.test(String(err?.message)) || NETWORK.test(String(err?.cause?.code || err?.cause?.message || ''));
}

// Every Ollama request asks for the same context size: Ollama loads the model again (seconds, and a burst of GPU memory) whenever a
// request asks for another one. OLLAMA_KEEP_ALIVE keeps it loaded between pages and jobs (Ollama's own default unloads it after 5 min).
const OLLAMA_LINE_CTX = 2048;
async function viaOllama(jpeg, model, system = SYSTEM_PROMPT, user = USER_PROMPT, maxTokens = 2600, opts = {}) {
  return withLocalReader('ollama', () => askOllama(jpeg, model, system, user, maxTokens, opts));
}
async function askOllama(jpeg, model, system, user, maxTokens, { probs = false, numCtx, timeoutMs, penalty } = {}) {
  const base = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
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

/**
 * A request to the local server that waits for it when it is down (stopped, or being started again by the API: a job checks it
 * every few seconds), up to two minutes, so the pages after a crash are still read by the AI instead of the standard OCR. A
 * request that times out is not repeated, and a server that never answered (not installed, failed to start) is not waited for:
 * the standard OCR takes over at once.
 */
let llamaAnswered = false;
async function fetchWhileDown(url, init, waitMs = Number(process.env.LLAMA_WAIT_MS) || 120_000) {
  const until = Date.now() + (llamaAnswered ? waitMs : 0);
  for (let delay = 1000; ; delay = Math.min(delay * 2, 10_000)) {
    try {
      const res = await fetch(url, init);
      llamaAnswered = true;
      return res;
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || Date.now() + delay > until) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** llama.cpp server (OpenAI-compatible API). Answers carry token probabilities in the same shape as Ollama's. */
async function viaLlamaCpp(jpeg, maxTokens = 2000, opts = {}) {
  return withLocalReader('llamacpp', () => askLlamaCpp(jpeg, maxTokens, opts));
}
async function askLlamaCpp(jpeg, maxTokens, { probs = false, timeoutMs, penalty } = {}) {
  const base = (process.env.LLAMA_URL || 'http://127.0.0.1:8081').split('/').filter((p, i, a) => p || i < a.length - 1).join('/');
  const res = await fetchWhileDown(`${base}/v1/chat/completions`, {
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
export async function readPageWithAi(jpeg, { arabicOnly = true, ptPerPx, font, probs = false, card = false, batch, cache } = {}) {
  const st = visionStatus();
  if (!st.available) throw new Error('AI reading is not configured (set VISION_PROVIDER)');
  // a local model reads far more accurately line by line (and tells how sure it is); a large cloud model reads the whole page
  const byLines = !st.external && (process.env.VISION_MODE || 'lines') !== 'page';
  if (byLines) {
    const res = await readPageByLines(jpeg, st.model, { arabicOnly, provider: st.provider, ptPerPx, font, probs, card });
    if (res) { fixBasmala(res.paragraphs); return res; }
    // no text line on the page (a cover, an ornament): kept as a picture. A whole page does not fit Qari's context, and for Ollama
    // it would ask for a larger context than the lines do, which reloads the model
    return { paragraphs: [], noText: true, usage: { output_tokens: 0 }, model: st.model };
  }
  const out = st.external ? await readCloudPage(jpeg, st, { arabicOnly, batch, cache })
    : st.provider === 'llamacpp' ? await viaLlamaCpp(jpeg, 2000)
      : await viaOllama(jpeg, st.model);
  if (out.refused) return { paragraphs: [], noText: false, refused: true, usage: out.usage, model: out.model || st.model, tried: out.tried };
  // the local fallback reader gives paragraphs, already cleaned
  if (out.paragraphs) { fixBasmala(out.paragraphs); return out; }
  const parsed = parseTranscription(out.text);
  parsed.paragraphs = markFootnotes(parsed.paragraphs, { rule: card ? false : await hasFootnoteRule(jpeg).catch(() => false) });
  if (arabicOnly) {
    const clean = (s) => s.split(' ').map((w) => cleanArabicLetters(w)).filter(Boolean).join(' ');
    for (const p of parsed.paragraphs) {
      p.text = clean(p.text);
      for (const r of p.runs || []) r.text = clean(r.text) + (r.text.endsWith(' ') ? ' ' : '');
    }
  }
  fixBasmala(parsed.paragraphs);
  parsed.paragraphs = parsed.paragraphs.map(markIllegible);
  return { ...parsed, truncated: out.truncated, usage: out.usage, model: out.model || st.model, via: out.via, tried: out.tried, bands: out.bands };
}

// A page whose text could not be copied (a cover in calligraphy, ornaments, a stamp): what the page is, named the way a book's
// contents would name it. printMatch writes that name where the picture would have been (Shamela takes no pictures).
export const PAGE_LABELS = ['غلاف الكتاب', 'صفحة العنوان', 'البسملة', 'مقدمة الكتاب', 'تعريف الكتاب', 'ترجمة المؤلف', 'الإهداء', 'بيانات النشر', 'فهرس الكتاب', 'صفحة زخرفية', 'صفحة فارغة'];
const DESCRIBE_PROMPT = [
  'You are shown one page of a printed Arabic book whose text could not be transcribed (a decorated cover, calligraphy,',
  'ornaments, a stamp, a page of a book\'s front matter). Say what this page is, as a short Arabic name of two to five words,',
  'the way a table of contents would name it.',
  `Prefer one of: ${PAGE_LABELS.join('، ')}.`,
  'When none fits, write your own short Arabic name for it. Never transcribe the page, never explain.',
  'Output the name only, in Arabic script, on one line.',
].join('\n');
const DESCRIBE_USER = 'What is this page?';

// printMatch: what is written on a page that has no text of its own, so that no Word page is empty
export const PICTURE_PAGE = '[صفحة مصورة]';
export const BLANK_PAGE = '[صفحة فارغة]';
/** A page's name as a paragraph: centred, never taken for a heading of the book or for a verse. */
export const pageLabel = (p) => ({ ...p, align: 'center', noHeading: true, pageLabel: true, ocr: false });

/** The model's answer as a page name: one short Arabic line, or null (anything else is not a name). */
export function cleanPageLabel(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const name = line.replace(/[#*"'«»“”[\]()،,.:;؛!؟?\-–—_]/g, ' ').split(/\s+/).filter(Boolean).join(' ');
  if (!name || name.includes('NO_TEXT') || /[A-Za-z]/.test(name) || !/[؀-ۿ]/.test(name)) return null;
  if (name.length > 40 || name.split(' ').length > 6) return null;
  // a listed name, whatever marks the reader put on it, is written as listed
  return PAGE_LABELS.find((l) => stripMarks(l) === stripMarks(name)) || name;
}

/**
 * Name a page nothing could be read from (cleanPageLabel), or null. A cloud model or a general local model (Ollama) is asked;
 * the local Qari reader only copies text, and cannot name a page.
 */
export async function describePageWithAi(jpeg) {
  const st = visionStatus();
  if (!st.available || st.provider === 'llamacpp') return null;
  const out = st.provider === 'gemini' ? await viaGemini(jpeg, st.model, DESCRIBE_PROMPT, DESCRIBE_USER, 1024, { media: 'MEDIA_RESOLUTION_MEDIUM' })
    : st.provider === 'claude' ? await viaClaude(jpeg, st.model, DESCRIBE_PROMPT, DESCRIBE_USER, 100)
      : await viaOllama(jpeg, st.model, DESCRIBE_PROMPT, DESCRIBE_USER, 40);
  return out?.refused ? null : cleanPageLabel(out?.text);
}

/** A word the reader marked unreadable becomes a highlighted run (lowConf), so a proof-reader finds it in the Word file. */
export function markIllegible(p) {
  if (!p.text.includes(ILLEGIBLE)) return p;
  const runs = [];
  // the runs a verse already has (its halves, each opening on a tab) are split in turn
  for (const run of p.runs || [{ text: p.text }]) {
    run.text.split(ILLEGIBLE).forEach((part, i) => {
      const tab = run.tab && !runs.some((r) => r.from === run) ? { tab: true } : {};
      if (i) runs.push({ text: ILLEGIBLE, lowConf: true, ...tab, from: run });
      else if (part) runs.push({ text: part, lowConf: false, ...tab, from: run });
      if (i && part) runs.push({ text: part, lowConf: false, from: run });
    });
  }
  return { ...p, runs: runs.map(({ from, ...r }) => r) };
}

/** Does the page image show the short rule that sets the footnotes off from the text? */
async function hasFootnoteRule(jpeg) {
  const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
  const boxes = segmentLines(data, info.width, info.height);
  return boxes.length > 2 && findFootnoteRule(data, info.width, info.height, boxes) !== null;
}

const NOTE_DIGIT = '[0-9٠-٩۰-۹]';
// a note opens with its number "(١)", "(١، ٢)" (one note for two references), or with "=" (a note carried over from the page before)
const NOTE_START = new RegExp(`^(?:\\(\\s*${NOTE_DIGIT}{1,2}(?:\\s*[،,-]\\s*${NOTE_DIGIT}{1,2})*\\s*\\)|=)`);
const digitValue = (c) => { const k = c.charCodeAt(0); return k >= 0x6f0 ? k - 0x6f0 : k >= 0x660 ? k - 0x660 : k - 48; };
const noteNumber = (text) => {
  const m = text.match(new RegExp(`^\\(\\s*(${NOTE_DIGIT}{1,2})`));
  return m ? [...m[1]].reduce((n, c) => n * 10 + digitValue(c), 0) : null;
};

/**
 * The footnotes of a page read whole (a cloud reader), marked `footnote` so they are set smaller under a rule, as printed:
 *   - the paragraphs after the "---" line the reader was asked to write before them (when the page shows the rule, or they open
 *     with a note number);
 *   - without it, on a page that shows the rule: the last paragraphs, each opening with a note number, from the note (١) on.
 * Notes the reader joined into one paragraph ("(١) ... للمتوسل. (٢) حديث ...") are split at the next number in turn.
 */
export function markFootnotes(paragraphs, { rule = false } = {}) {
  const isSep = (p) => !p.heading && /^[-–—_ـ]{3,}$/.test(p.text.replace(/\s+/g, ''));
  const sep = paragraphs.findLastIndex(isSep);
  let start = -1;
  let list;
  if (sep > 0 && sep < paragraphs.length - 1 && (rule || NOTE_START.test(paragraphs[sep + 1].text))) {
    list = paragraphs.filter((_, i) => i !== sep);
    start = sep;
  } else {
    list = paragraphs.filter((p) => !isSep(p)); // a drawn rule is no text
    let k = list.length;
    while (rule && k > 1 && !list[k - 1].heading && NOTE_START.test(list[k - 1].text)) k--;
    if (k < list.length) {
      // a list numbered in the text just above the notes is not a note: the notes start again at (١)
      const first = list.slice(k).findLastIndex((p) => noteNumber(p.text) === 1);
      start = first < 0 ? k : k + first - (first > 0 && list[k + first - 1].text.startsWith('=') ? 1 : 0);
    }
  }
  if (start < 0) return list;
  return [...list.slice(0, start), ...list.slice(start).flatMap((p) => splitNotes(p).map((x) => ({ ...x, heading: false, footnote: true })))];
}

/** One paragraph per note: split before the next note's number "(n+1)" when it follows the end of a sentence. */
function splitNotes(p) {
  let n = noteNumber(p.text);
  if (n === null || p.runs) return [p];
  const out = [];
  let rest = p.text;
  for (;;) {
    const next = new RegExp(`([.:؛»)\\]=…])\\s+\\(\\s*${NOTE_DIGIT}{1,2}\\s*\\)`, 'g');
    let cut = -1;
    for (const m of rest.matchAll(next)) {
      if (noteNumber(rest.slice(m.index + m[1].length).trimStart()) === n + 1) { cut = m.index + m[1].length; break; }
    }
    if (cut < 0) break;
    out.push({ ...p, text: rest.slice(0, cut).trim() });
    rest = rest.slice(cut).trim();
    n++;
  }
  out.push({ ...p, text: rest });
  return out;
}

/**
 * A cloud page read that does not give up at the first refusal or error. In turn:
 *   1. the provider's model (Gemini: GEMINI_MODEL, then GEMINI_FALLBACK_MODEL when its quota is used up, as viaGemini does);
 *   2. Gemini held the page back as RECITATION / OTHER (a page of Quran): the same model again, the page in bands;
 *   3. the readers of VISION_FALLBACK, in its order: `claude` (needs ANTHROPIC_API_KEY; no recitation stop, model
 *      VISION_FALLBACK_MODEL, default Haiku) and `llamacpp` (the local Qari reader, when its server is running).
 * What is still unread comes back refused (or throws, when every reader failed), and processPage reads it with the standard OCR.
 * `via` names the reader that answered and `tried` what the ones before it said, for the job report.
 */
async function readCloudPage(jpeg, st, { arabicOnly = true, batch, cache } = {}) {
  const tried = [];
  let lastErr = null;
  const attempt = async (via, read) => {
    try {
      const out = await read();
      if (out && !out.refused) return { ...out, via, tried };
      tried.push(`${via}:${out?.reason || 'refused'}`);
      return out;
    } catch (err) {
      if (err?.deferred) throw err; // pass 1 of a batch: the page waits for the batch, nothing else is tried
      tried.push(`${via}:${String(err?.message).slice(0, 60)}`);
      lastErr = err;
      return null;
    }
  };
  const o = { batch, cache, media: pageMedia() };
  let out;
  if (st.provider === 'gemini') {
    out = await attempt('gemini', () => viaGemini(jpeg, st.model, SYSTEM_PROMPT, USER_PROMPT, 16000, o));
    if (out?.via) return out;
    if (out?.refused && ['RECITATION', 'OTHER'].includes(out.reason)) {
      const banded = await attempt('gemini-bands', () => readInBands(jpeg, (piece, user) => viaGemini(piece, st.model, SYSTEM_PROMPT, user, 8000, { media: o.media })));
      if (banded?.via) return banded;
    }
  } else {
    out = await attempt('claude', () => viaClaude(jpeg, st.model));
    if (out?.via) return out;
  }
  for (const f of (process.env.VISION_FALLBACK || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    let next;
    if (f === 'claude' && st.provider !== 'claude') next = await attempt('claude', () => viaClaude(jpeg, process.env.VISION_FALLBACK_MODEL || 'claude-haiku-5-5'));
    else if (f === 'llamacpp') next = await attempt('llamacpp', async () => (await readPageByLines(jpeg, DEFAULT_MODELS.llamacpp, { provider: 'llamacpp', arabicOnly })) || { refused: true, reason: 'no-lines' });
    else continue;
    if (next?.via) return next;
    out = next || out;
  }
  if (lastErr && !out?.refused) throw Object.assign(new Error(`AI reading failed (${tried.join(', ')})`), { cause: lastErr });
  return { refused: true, text: '', tried, usage: out?.usage, model: st.model };
}

const ENDS_SENTENCE = /[.!؟:﴾\])»]$/;

/**
 * Read the page in horizontal bands of at most VISION_BAND_LINES (8) text lines, cut in the white space between lines, and join
 * the readings: for a page Gemini holds back as recitation (shorter passages usually pass). Each band also gets the whole image
 * budget of a request, so its small diacritics get more detail. Null when a band is held back too.
 */
export async function readInBands(jpeg, readPiece, { maxLines = Number(process.env.VISION_BAND_LINES) || 8 } = {}) {
  const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const boxes = segmentLines(data, w, h);
  if (boxes.length < 2) return null;
  const per = Math.min(maxLines, Math.ceil(boxes.length / 2)); // at least two bands: the point is a smaller piece
  const cuts = [0];
  for (let i = per; i < boxes.length; i += per) cuts.push(Math.round((boxes[i - 1].y1 + boxes[i].y0) / 2));
  cuts.push(h);
  const usage = { input_tokens: 0, output_tokens: 0 };
  let text = '';
  let truncated = false;
  let model;
  for (let k = 0; k < cuts.length - 1; k++) {
    const piece = await sharp(jpeg).extract({ left: 0, top: cuts[k], width: w, height: cuts[k + 1] - cuts[k] }).jpeg({ quality: 92 }).toBuffer();
    const out = await readPiece(piece, bandPrompt(k, cuts.length - 1));
    if (out.refused) return null;
    usage.input_tokens += out.usage?.input_tokens || 0;
    usage.output_tokens += out.usage?.output_tokens || 0;
    truncated ||= out.truncated;
    model = out.model;
    const part = String(out.text || '').trim();
    if (!part || part === NO_TEXT) continue;
    // a paragraph cut by a band goes on in the next one: one newline joins them (parseTranscription splits on blank lines only),
    // unless the band ended a sentence or the next one opens with a heading
    text += !text ? part : (ENDS_SENTENCE.test(text) || part.startsWith('# ') ? '\n\n' : '\n') + part;
  }
  return { text: text || NO_TEXT, truncated, usage, model, bands: cuts.length - 1 };
}

/**
 * Read one line image (8-bit grey) that is known to be a single line, such as a running title or a page number: one request, no
 * search for lines in it. Small pieces (a lone digit) are enlarged to the height of a body line, with white space around them as
 * the line reader is used to.
 */
export async function readLineImage(gray, w, h, { arabicOnly = true, minHeight = 60, penalty } = {}) {
  const st = visionStatus();
  if (!st.available) throw new Error('AI reading is not configured (set VISION_PROVIDER)');
  const scale = Math.max(1, minHeight / Math.max(1, h));
  const jpeg = await sharp(Buffer.from(gray.buffer, gray.byteOffset, gray.length), { raw: { width: w, height: h, channels: 1 } })
    .resize({ width: Math.round(w * scale), height: Math.round(h * scale) })
    .extend({ top: 20, bottom: 20, left: 40, right: 40, background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 92 })
    .toBuffer();
  const out = st.provider === 'llamacpp' ? await viaLlamaCpp(jpeg, 120, { timeoutMs: 60_000, penalty })
    : st.provider === 'ollama' ? await viaOllama(jpeg, st.model, LINE_SYSTEM_PROMPT, LINE_USER_PROMPT, 120, { numCtx: OLLAMA_LINE_CTX, timeoutMs: 60_000, penalty })
      : st.provider === 'gemini' ? await viaGemini(jpeg, st.model, LINE_SYSTEM_PROMPT, LINE_USER_PROMPT, 200)
        : await viaClaude(jpeg, st.model, LINE_SYSTEM_PROMPT, LINE_USER_PROMPT, 200);
  const text = out.refused ? '' : cleanArabicLine(normalizeShaping(String(out.text || '').split('\n').join(' ')), { arabicOnly });
  return { text: text === NO_TEXT ? '' : text, usage: out.usage };
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
export async function readPageByLines(jpeg, model, { arabicOnly = true, provider = 'ollama', ptPerPx, font, probs = false, card = false } = {}) {
  const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const boxes = segmentLines(data, w, h);
  if (!boxes.length) return null;
  // a title page (lines of many sizes) has few lines and its words are rarely repeated in the book: how sure the reader is of each
  // word, and what else it could be, is asked for there whatever the option (fixDoubtfulWords sets a doubtful word by the words of
  // the book)
  // and each of its lines is a paragraph of its own, centred, as on a cover
  if (boxes.titlePage) { probs = true; card = true; }
  // a running header (title, page number and a drawn rule) is not read as text: its box is returned so the page keeps it as a picture
  let headerBox = null;
  const ruleY = findFootnoteRule(data, w, h, boxes);
  if (isHeadLine(data, w, h, boxes)) headerBox = boxes.shift();
  // the page number standing alone under the text is not the book's text: read by the shapes of its digits (the line reader writes
  // "١١" as "1 1"), it is returned apart, and the book's numbers are set from the page sequence (settlePageNumbers)
  let footer = null;
  const numBox = card ? null : footNumberBox(data, w, h, boxes);
  if (numBox) {
    const b = numBox;
    const pad = Math.round((b.y1 - b.y0) * 0.3);
    const x0 = Math.max(0, b.x0 - pad), x1 = Math.min(w, b.x1 + pad), y0 = Math.max(0, b.y0 - pad), y1 = Math.min(h, b.y1 + pad);
    const cw = x1 - x0;
    const cut = new Uint8Array(cw * (y1 - y0));
    for (let y = y0; y < y1; y++) cut.set(data.subarray(y * w + x0, y * w + x1), (y - y0) * cw);
    const num = await readPageDigits(cut, cw, y1 - y0).catch(() => null);
    if (num) { footer = { n: num.n, indic: num.indic, sure: num.sure }; boxes.pop(); }
  }
  // a line that opens with an ornament (❋) is read from after it, and the ornament is written as "*"; a ﷺ glyph in a line is
  // written as ﷺ, the parts of the line on either side of it read apart
  for (const b of boxes) {
    const cut = lineOrnament(data, w, h, b);
    if (cut !== null) b.ornament = cut;
    const salla = await findSalla(data, w, h, b).catch(() => []);
    if (salla.length) b.salla = salla;
  }
  let tokens = 0;
  // footnote lines are set smaller than the model was trained on (14 pt and up): they are enlarged more, up to the size of the body text
  const isFootBox = (b) => ruleY !== null && (b.y0 + b.y1) / 2 > ruleY;
  const bodyH = median(boxes.filter((b) => !isFootBox(b)).map((b) => b.y1 - b.y0)) || 1;
  // lines of poetry (two halves, white space between them in the middle) and rows of ornaments between paragraphs ("****")
  if (!card) markVerses(data, w, boxes);
  const separators = card ? [] : findSeparators(data, w, h, boxes);
  for (const s of separators) if (s.line) boxes.splice(boxes.indexOf(s.line), 1);
  if (process.env.VISION_DEBUG) {
    console.error(`page ${w}x${h}, rule ${ruleY}, ${boxes.length} lines, separators ${JSON.stringify(separators)}`);
    for (const b of boxes) console.error(`  line y ${b.y0}-${b.y1} x ${b.x0}-${b.x1}${b.ornament !== undefined ? ` ornament<${b.ornament}` : ''}${b.verseGap ? ` VERSE ${b.verseGap.x0}-${b.verseGap.x1}` : ''} gaps ${JSON.stringify(lineGaps(data, w, b).map((g) => [g.x0, g.x1]))}`);
  }
  // Several lines at once: the model's speed is limited by memory bandwidth while it writes, so Ollama writes parallel lines
  // (OLLAMA_NUM_PARALLEL) in nearly the same time as one. Results are kept in line order.
  const parallel = Math.max(1, Number(process.env.VISION_LINE_PARALLEL) || 8);
  const envNum = (name, d) => (process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : d);
  // white space kept around each line (px). Measured: tighter crops cut the image tokens by a quarter but made the reader drop words
  const lineMargin = envNum('VISION_LINE_MARGIN', 12);
  const linePad = envNum('VISION_LINE_PAD', 20);
  /**
   * Read one line (or the part [left, right) of it) and return its words. The whole line is its ink and a line's height either
   * side: a speck of the scan out in the margin is not shown to the reader (it wrote one as a full stop before a title).
   */
  async function readBox(box, left = Math.max(0, box.x0 - (box.y1 - box.y0)), right = Math.min(w, box.x1 + (box.y1 - box.y0)), enlarge = 1) {
    if (box.ornament !== undefined) right = Math.min(right, box.ornament);
    // the reader makes words of a ﷺ glyph ("وَشَيْءٌ"), and of a line with a wide gap in it (a verse's two halves, two notes)
    // reads one side only: the line is read in parts, up to each and from after it
    const words = [];
    const room = (box.y1 - box.y0) * 0.5; // narrower than that, a part holds no word
    const gaps = lineGaps(data, w, box, left, right);
    // a verse's halves: the gap between them, also where it is narrower than the gaps a line is cut at
    const verse = box.verseGap && (gaps.find((g) => g.x0 <= box.verseGap.x1 && g.x1 >= box.verseGap.x0) || { ...box.verseGap });
    if (verse && !gaps.includes(verse)) gaps.push(verse);
    const cuts = [
      ...(box.salla || []).map((g) => ({ ...g, text: SALLA })),
      ...gaps,
    ].filter((g) => g.x0 >= left && g.x1 < right).sort((a, b) => b.x1 - a.x1);
    let end = right;
    let second = -1; // the first word of a verse's second half
    for (const g of cuts) {
      if (g.x1 >= end) continue; // inside a part already cut off
      if (end - g.x1 > room) words.push(...await readSpan(box, g.x1 + 1, end, enlarge));
      if (g.text) words.push({ text: g.text, conf: 1, alts: [] });
      if (g === verse) second = words.length;
      end = g.x0;
    }
    if (end - left > room) words.push(...await readSpan(box, left, end, enlarge));
    if (second > 0 && second < words.length) words[second] = { ...words[second], half: true };
    return box.ornament !== undefined && words.length ? [{ text: '*', conf: 1, alts: [] }, ...words] : words;
  }
  /** Read the part [left, right) of a line and return its words. */
  async function readSpan(box, left, right, enlarge) {
    const y0 = Math.max(0, box.y0 - lineMargin);
    const y1 = Math.min(h, box.y1 + lineMargin);
    // the margin around the line without the pieces of its neighbours that reach into it
    const crop = await sharp(Buffer.from(isolateLine(data, w, box, left, right, y0, y1).buffer), { raw: { width: right - left, height: y1 - y0, channels: 1 } })
      .extend({ top: linePad, bottom: linePad, left: 20, right: 20, background: { r: 255, g: 255, b: 255 } })
      .resize({ width: Math.min(2800, Math.round((right - left) * enlarge * (Number(process.env.VISION_LINE_SCALE) || 1.0) * (isFootBox(box) ? Math.min(1.5, Math.max(1, bodyH / (box.y1 - box.y0))) : 1))) })
      .jpeg({ quality: 92 })
      .toBuffer();
    const ask = (penalty) => (provider === 'llamacpp'
      ? viaLlamaCpp(crop, 300, { probs, timeoutMs: 90_000, penalty })
      : viaOllama(crop, model, LINE_SYSTEM_PROMPT, LINE_USER_PROMPT, 300, { probs, numCtx: OLLAMA_LINE_CTX, timeoutMs: 90_000, penalty }));
    let out;
    // one retry after a dropped connection (the server restarting); a line that ran out of time is not asked again: the slot
    // limit means it was being read, so a second try takes as long and ends the same, and the page's own time limit runs meanwhile
    try { out = await ask(); } catch (err) { if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw err; out = await ask(); }
    let looped = out.truncated || hasLoop(out.text);
    if (looped) { // looping on one word: read the line again with a penalty on repeats
      try { const again = await ask(1.15); if (!again.truncated && !hasLoop(again.text)) { out = again; looped = false; } } catch { /* keep the first answer */ }
    } else if (hasEcho(out.text)) {
      // a phrase said twice in place of the words after it ("على نظمه على نظمه" for "على نظمه بما قاله الإمام الشاطبي"): read again
      // with a penalty on repeats, and kept when the echo is gone and nothing else is (a printed "الله أكبر الله أكبر" stays)
      try {
        const again = await ask(1.15);
        if (!again.truncated && !hasEcho(again.text) && stripMarks(again.text).length >= stripMarks(out.text).length * 0.95) out = again;
      } catch { /* keep the first answer */ }
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
    // a loop of nothing but scraps ("م ، م ،") was read from a rule or an ornament, not from words
    // and so is a line of five scraps or more with no digit ("ه ه م ه ه جه" over a title): no printed line is only that
    const scraps = kept.every((x) => stripMarks(x.text).replace(/[^\p{L}\p{N}]/gu, '').length <= 2 && !/[0-9٠-٩۰-۹]/.test(x.text));
    if (scraps && (looped || kept.length >= 5)) kept = [];
    // and a line of nothing but stops and commas (",..") was read from specks of the scan
    if (kept.every((x) => !/[\p{L}\p{N}*]/u.test(x.text))) kept = [];
    // a line with hardly any diacritics is printed with a few (كُتب، يُحسِن، علىٰ، فعلاً): Qari writes the marks it sees and keeps
    // them; a general vision model adds case endings of its own there, so only its short vowels go (shadda, tanwin, the dagger
    // alef and hamza are letters' shapes it does not invent)
    if (provider !== 'llamacpp' && isMostlyPlain(kept.map((x) => x.text).join(' '))) {
      kept = kept.map((x) => ({ ...x, text: dropShortVowels(x.text), alts: x.alts.map((a) => dropShortVowels(a)) }));
    }
    kept = kept.map((x) => ({ ...x, text: fixDaggerAlef(x.text), alts: x.alts.map((a) => fixDaggerAlef(a)) }));
    // a bracketed title written with its brackets turned round ("]في الماء المستعمل[", "]في آداب قاضي الحاجة]")
    if (kept.length && /^[[\]]/.test(kept[0].text) && /[[\]]$/.test(kept[kept.length - 1].text) && !(kept[0].text.startsWith('[') && kept[kept.length - 1].text.endsWith(']'))) {
      kept[0] = { ...kept[0], text: `[${kept[0].text.slice(1)}` };
      const z = kept.length - 1;
      kept[z] = { ...kept[z], text: `${kept[z].text.slice(0, -1)}]` };
    }
    return setNumbers(kept, box, left, right);
  }
  /**
   * The numbers of a line (a year, a date) as the shapes of their digits read them: the reader writes other digits than the
   * printed ones (١٢٩٣ as ١١٤٤, ٩٧٩ as "٩:٤٩", ٨٩١ as ١٩١). Its numbers of two digits or more, but a note's number in its brackets
   * ("[١٧]", too short for the shapes to find), are set when the page shows as many numbers of three digits or more in that part
   * of the line, in the same order. A year in a bracket ("(٨٩١هـ)", "[البقرة: ٢٥٥]") is one of them.
   */
  async function setNumbers(words, box, left, right) {
    const text = words.map((x) => x.text).join(' ');
    const digits = (m) => m[0].replace(/[^0-9٠-٩۰-۹]/g, '').length;
    const noteNumber = (m) => digits(m) < 3 && /[([{﴿«]/.test(text[m.index - 1] || '') && /[)\]}﴾»]/.test(text[m.index + m[0].length] || '');
    // a number as the reader wrote it, its digits perhaps split by a colon, a dot or spaces ("٩:٤٩", "9 12", "٢٠٠٢ . ٢"), or two
    // numbers of a reference ("١٠/١٢٥", "١٤٢-١٦٧") that the shapes give as one; and, failing that, digits a comma parts too ("١٤٤"
    // read "٥ ، ١")
    const numbersIn = (re) => [...text.matchAll(re)].filter((m) => !noteNumber(m));
    const strict = numbersIn(/[0-9٠-٩۰-۹]+(?:[ :./\-–ـ_]{1,3}[0-9٠-٩۰-۹]+)*/g);
    const loose = numbersIn(/[0-9٠-٩۰-۹]+(?:[ :./\-–ـ_،,]{1,3}[0-9٠-٩۰-۹]+)*/g);
    if (!loose.some((m) => digits(m) >= 2)) return words;
    const numbers = (await lineNumbers(data, w, h, box).catch(() => [])).filter((r) => r.x0 >= left && r.x1 < right);
    if (process.env.VISION_DEBUG) console.error('numbers', JSON.stringify(loose.map((m) => m[0])), '=>', JSON.stringify(numbers.map((r) => r.text)));
    // the shapes find the numbers of three digits or more: the reader's numbers of three digits are set by them when as many, a day
    // beside a year ("( ١١ ) محرم ( ١٤٢١هـ )") left as it is; then those of two digits too, and a year the reader cut down to one
    // digit ("أغسطس ٢ م" for ٢٠٠٢) is still one of the line's numbers
    const groups = [strict, loose].flatMap((all) => [3, 2, 1].map((least) => all.filter((m) => digits(m) >= least)))
      .find((g) => g.length && g.length === numbers.length);
    if (!groups) return words;
    const starts = [];
    words.reduce((at, x) => { starts.push(at); return at + x.text.length + 1; }, 0);
    const wordAt = (pos) => starts.findLastIndex((s) => s <= pos);
    const out = words.map((x) => ({ ...x }));
    // from the end of the line, so that the words before a number keep their places
    for (let k = groups.length - 1; k >= 0; k--) {
      const m = groups[k];
      const i = wordAt(m.index);
      const j = wordAt(m.index + m[0].length - 1);
      const head = out[i].text.slice(0, m.index - starts[i]);
      const tail = out[j].text.slice(m.index + m[0].length - starts[j]);
      out.splice(i, j - i + 1, { ...out[i], text: head + numbers[k].text + tail, conf: 1, alts: [] });
    }
    return out;
  }
  /**
   * A line of a table of contents, in its parts: the title (right of the dot leader) by the reader, the page number (left of it) by
   * the shapes of its digits, as a page number is read; the leader written as dots. Null when the line has no leader.
   */
  async function readContentsLine(box) {
    const lead = findLeader(data, w, box);
    if (!lead) return null;
    const lh = box.y1 - box.y0;
    const title = await readBox(box, lead.x1 + 1, Math.min(w, box.x1 + lh));
    const words = [...title, { text: '.'.repeat(Math.min(lead.count, 40)), conf: 1, alts: [] }];
    if (lead.x0 - box.x0 > lh * 0.2) {
      const x0 = Math.max(0, box.x0 - Math.round(lh * 0.3));
      const x1 = lead.x0 - 1;
      const cut = new Uint8Array((x1 - x0) * lh);
      for (let y = 0; y < lh; y++) cut.set(data.subarray((box.y0 + y) * w + x0, (box.y0 + y) * w + x1), y * (x1 - x0));
      const num = await readPageDigits(cut, x1 - x0, lh).catch(() => null);
      words.push(...(num ? [{ text: num.text, conf: 1, alts: [] }] : await readBox(box, x0, lead.x0)));
    }
    return words;
  }
  /**
   * The number of an item that opens a line: the first group of ink from the line's right end (up to the space after it), read as a
   * page number is read, when it is no wider than a digit or two and its shapes fit digits plainly. `dash`: a flat stroke beside it.
   */
  async function itemNumber(box) {
    const lh = box.y1 - box.y0;
    const inkAt = (x) => { for (let y = box.y0; y < box.y1; y++) if (data[y * w + x] < 140) return true; return false; };
    let start = -1;
    let gap = 0;
    let x = box.x1 - 1;
    for (; x >= box.x0; x--) {
      if (inkAt(x)) { if (start < 0) start = x; gap = 0; } else if (start >= 0 && ++gap >= lh * 0.15) break;
    }
    const x0 = x + gap;
    const x1 = start + 1;
    if (start < 0 || x1 - x0 > lh * 1.6 || x1 - x0 < 3) return null;
    const cw = x1 - x0;
    const cut = new Uint8Array(cw * lh);
    for (let y = 0; y < lh; y++) cut.set(data.subarray((box.y0 + y) * w + x0, (box.y0 + y) * w + x1), y * cw);
    const num = await readPageDigits(cut, cw, lh).catch(() => null);
    if (!num || num.sure < 0.1 || !num.indic) return null;
    // a flat stroke on the line's foot, left of the digit: the ـ of "٥ـ"
    let dash = false;
    for (let y = Math.round(lh * 0.5); y < lh && !dash; y++) {
      let run = 0;
      for (let i = 0; i < cw && !dash; i++) { run = cut[y * cw + i] < 140 ? run + 1 : 0; if (run >= lh * 0.2) dash = true; }
    }
    return { ...num, dash };
  }
  const read = new Array(boxes.length);
  const textWidth = Math.max(...boxes.map((b) => b.x1)) - Math.min(...boxes.map((b) => b.x0));
  let next = 0;
  async function worker() {
    while (next < boxes.length) {
      const k = next++;
      const contents = card ? null : await readContentsLine(boxes[k]);
      let words = contents || await readBox(boxes[k]);
      // a short line read as nothing ("( ب )" alone in the middle of the page) is read again, twice the size
      if (!words.length && !card && boxes[k].x1 - boxes[k].x0 < textWidth * 0.4) words = await readBox(boxes[k], undefined, undefined, 2);
      read[k] = { ...boxes[k], words, footnote: isFootBox(boxes[k]), leader: !!contents };
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, boxes.length) }, worker));
  // a numbered item ("٥ـ وقبل سفره"): the reader takes its digit for a letter or another digit (٥ for ه, ٤ for م, ٦ for ٧), so the
  // first group of ink of a line that it read as a lone digit or such a letter is read by the shapes of its digits; not the ه of a
  // year the line before ends with ("سنة ( ٨٧٥ / هـ )")
  if (!card) {
    for (let k = 0; k < read.length; k++) {
      const l = read[k];
      const first = l.words[0]?.text || '';
      if (l.leader || !/^(?:[0-9٠-٩]{1,2}|[همو])[ـ\-–.]?$/.test(first) || l.words.length < 2) continue;
      if (/^[همو]/.test(first) && k && /[0-9٠-٩(]\s*$/.test(read[k - 1].words.map((x) => x.text).join(' '))) continue;
      const num = await itemNumber(l);
      if (process.env.VISION_DEBUG) console.error('item', l.y0, first, '=>', JSON.stringify(num));
      if (!num) continue;
      l.words = [{ text: num.text + (num.dash ? 'ـ' : first.replace(/^[^ـ\-–.]+/, '')), conf: 1, alts: [] }, ...l.words.slice(1)];
    }
  }
  if (process.env.VISION_DEBUG) for (const l of read) console.error(`  read ${l.y0}: ${l.words.map((x) => x.text).join(' ')}`);
  // a cover or a title page (`card`): no second readings (its calligraphy would ask for one on every line, in vain), and each printed
  // line stays a paragraph of its own, as it is set on the page
  if (!card) {
    await rereadShortLines(read, { w, readBox });
    await markSallaLines(read, { w, readBox });
  }
  const lines = read.filter((l) => l.words.length);
  if (!lines.length) return { paragraphs: [], noText: true, usage: { output_tokens: tokens }, model };
  // The page as it was printed: where the text block sits, how far apart its lines are, and the size that makes a line of the Word
  // document as wide as a printed line (measured with the document font) so lines break where the book breaks them.
  // (not measured against the widest line: a speck of the scan in the margin widens a line's box)
  const block = textBlock(lines);
  const full = lines.filter((l) => !l.words.some((x) => x.half) && l.x1 - l.x0 >= block.span * 0.9 && l.x1 - l.x0 <= block.span * 1.05);
  const textBox = { x0: block.L, x1: block.R, y0: lines[0].y0 };
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
  // a row of ornaments is written as that many "*", a line of its own
  const withSeparators = [...lines, ...separators.map((s) => ({ ...s, separator: true, footnote: false, words: [{ text: Array(Math.min(6, s.count)).fill('*').join(' '), conf: 1, alts: [] }] }))] // spaced as printed: "* * *"
    .sort((a, b) => a.y0 - b.y0);
  const paragraphs = card ? lines.map((l) => cardLine(l.words)) : unifyDigits(fixNoteNumbers(groupLines(withSeparators)), arabicOnly);
  return { paragraphs, noText: false, usage: { output_tokens: tokens }, model, mode: 'lines', bodyPt, lineGapPt, textBox, headerBox, footRatio, footer };
}

/** One printed line of a card as a paragraph: centred, its words marked when the reader was unsure of them (`lowConf`). */
function cardLine(words) {
  const flag = flagConf();
  const runs = [];
  words.forEach((x, i) => {
    const text = normalizeShaping(x.text) + (i < words.length - 1 ? ' ' : '');
    const lowConf = x.conf < flag;
    const last = runs[runs.length - 1];
    // a doubtful word is a run of its own, with the other spellings the reader saw
    if (lowConf) runs.push({ text, lowConf, alts: x.alts.length ? x.alts : undefined });
    else if (last && !last.lowConf) last.text += text;
    else runs.push({ text, lowConf });
  });
  return { text: normalizeShaping(words.map((x) => x.text).join(' ')), heading: false, center: true, footnote: false, indent: 0, runs };
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
  // a cycle of one to three words, four times over ("م ، م ، م ، م ،", read from a dashed rule)
  for (let p = 1; p <= 3; p++) {
    let run = 0;
    for (let i = p; i < w.length; i++) {
      run = w[i] === w[i - p] ? run + 1 : 0;
      if (run >= 3 * p) return true;
    }
  }
  return false;
}

/** A phrase of two or three words said twice in a row (six letters or more): what a small model writes in place of words it skipped. */
export function hasEcho(text) {
  const w = String(text).split(' ').filter(Boolean).map((x) => stripMarks(x).replace(/[^\p{L}]/gu, ''));
  for (let p = 2; p <= 3; p++) {
    for (let i = 2 * p; i <= w.length; i++) {
      const a = w.slice(i - 2 * p, i - p);
      const b = w.slice(i - p, i);
      if (a.every((x, k) => x && x === b[k]) && a.join('').length >= 6) return true;
    }
  }
  return false;
}

/** Keep one occurrence of a word repeated 3+ times in a row. */
export function collapseLoops(words) {
  const same = (a, b) => stripMarks(a.text) === stripMarks(b.text);
  const out = [];
  for (const x of words) {
    out.push(x);
    // a cycle of p words already there twice: its third turn is dropped
    for (let p = 1; p <= 3; p++) {
      const n = out.length;
      if (n >= 3 * p && Array.from({ length: p }, (_, k) => n - 1 - k).every((i) => same(out[i], out[i - p]) && same(out[i], out[i - 2 * p]))) {
        out.splice(n - p, p);
        break;
      }
    }
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
  let afterVerse = false;
  for (const p of paragraphs) {
    const continues = afterVerse;
    afterVerse = !!(p.poem && p.footnote);
    if (p.poem) continue; // a verse quoted in a note
    if (p.footnote) {
      // a number the reader made scraps of, its "(" lost ("; ) الروم", "١) الروم"): the note's number, written again
      const scraps = p.text.match(/^[^\p{L}(]{0,4}\)\s*/u);
      if (scraps && p.runs?.[0]?.text.startsWith(scraps[0])) {
        n++;
        p.runs[0].text = `(${indic(n)}) ${p.runs[0].text.slice(scraps[0].length)}`;
        p.text = `(${indic(n)}) ${p.text.slice(scraps[0].length)}`;
        continue;
      }
      const close = p.text.indexOf(')');
      if (!p.text.startsWith('(') || close < 2 || close > 5) {
        // no number: a note that starts at the right edge (no hanging indent) lost its number to the reader; an indented line
        // continues the note above, and so does the text after a verse the note quotes, and a note opened by "=" (the end of a note
        // of the page before)
        if (!p.indent && !continues && !/^\s*=/.test(p.text)) {
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

export const BASMALA = 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ';
const BASMALA_REST = rasmKey(matchKey('الرحمن الرحيم'));
const BASMALA_ALL = ['بسم', 'الله', 'الرحمن', 'الرحيم'].map((x) => rasmKey(matchKey(x))).join('');
const rasmOf = (words) => rasmKey(words.map(matchKey).join(''));
const shapeSim = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(1, a.length, b.length);
};

/**
 * The basmala of a title page or of the head of a book is drawn in calligraphy, which the reader cannot read: "بسم الله" comes
 * out right and the rest as other words ("بِسَمِّ اللهِ لِكَمِّ الْجَبَّةِ"). A line of its own that starts with "بسم الله" and goes on
 * with words shaped like "الرحمن الرحيم" (measured by letter shapes, dots aside: misreadings 0.5 and up, a real phrase such as
 * "وبه نستعين" or "الحمد لله" 0.4 at most) is the basmala, and is written in full: with diacritics when the reading had them.
 */
export function fixBasmala(paragraphs, { minSim = 0.45, alone = false } = {}) {
  for (const p of paragraphs) {
    const words = p.text.split(' ').filter(Boolean);
    // the whole basmala drawn in calligraphy, misread from its first word on ("بِشَمَلَةٍ لِخَمَّالِ خَمَّتْكِ", "لِشَمَلِ لِلَّذَا لِخَيَّلِ إِلَخَمَنِّي"): a
    // short line of its own shaped like it (measured: such readings 0.5-0.63 by letter shapes, short headings 0.38 at most)
    const opens = rasmOf(words.slice(0, 2)) === rasmOf(['بسم', 'الله']);
    const drawn = !opens && !p.footnote && words.length >= 2 && words.length <= 5 && shapeSim(rasmOf(words), BASMALA_ALL) >= 0.5;
    if (drawn) { setBasmala(p); continue; }
    // read right as far as "بسم الله": the words after it decide ("وبه نستعين" is a real phrase)
    if (words.length < 3 || words.length > 5 || !opens) continue;
    // `alone`: the only line of its page. Whatever the reader made of "الرحمن الرحيم" there keeps the article of both words
    // ("الله اله", "لكم الجمن"), where a real phrase after the basmala's first words does not ("وبه نستعين")
    const articles = alone && words.length <= 4 && words.slice(2).every((x) => /^ا?ل/.test(stripMarks(x)));
    if (!articles && shapeSim(rasmOf(words.slice(2)), BASMALA_REST) < minSim) continue;
    setBasmala(p);
  }
  return paragraphs;
}

function setBasmala(p) {
  const text = stripMarks(p.text) === p.text ? stripMarks(BASMALA) : BASMALA;
  if (text === p.text) return;
  p.text = text;
  if (p.runs) p.runs = [{ text, lowConf: false }];
}

/**
 * Lines -> paragraphs and headings from the geometry of the page: a paragraph ends on a line that stops short of the left edge
 * (right-to-left text) and a new one starts on an indented line; a short, centred line or a [bracketed] title is a heading.
 */
export function groupLines(lines) {
  const { L, R, span } = textBlock(lines.filter((l) => !l.separator));
  const endsEarly = (l) => l.x0 > L + span * 0.1;
  const indented = (l) => l.x1 < R - span * 0.04;
  // the two sides of a centred line agree within a third of the narrower one (a short title set far in from both) and 2% of the
  // line at least: a paragraph's one line, indented, is 82 px in on the right and 143 px on the left
  const centred = (l) => {
    const left = l.x0 - L;
    const right = R - l.x1;
    return Math.abs(left - right) <= Math.max(span * 0.02, Math.min(span * 0.06, Math.min(left, right) * 0.3)) && l.x1 - l.x0 < span * 0.9;
  };

  // a [bracketed] title is printed alone on its line, whatever its width
  const lineText = (l) => l.words.map((x) => x.text).join(' ');
  const isTitle = (l) => { const t = lineText(l); return t.startsWith('[') && t.endsWith(']'); };
  // a verse is read in its two halves (the first word of the second one marked `half`); the second half opening with a note's
  // number is a second note beside the first, not a verse
  const halfAt = (l) => l.words.findIndex((x) => x.half);
  const isVerse = (l) => halfAt(l) > 0 && !(l.footnote && /^\(\s*[0-9٠-٩۰-۹]/.test(l.words[halfAt(l)].text));
  // its own paragraph: a verse, a row of ornaments, a line of a table of contents, the first line of the footnotes (and the text
  // above them stays apart from them)
  const alone = (l) => isVerse(l) || l.separator || l.leader;
  const groups = [];
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    // an item opened by an ornament (❋) is a paragraph of its own
    if (!prev || endsEarly(prev) || indented(l) || isTitle(l) || isTitle(prev) || l.ornament !== undefined
      || alone(l) || alone(prev) || !!l.footnote !== !!prev.footnote) groups.push([]);
    groups[groups.length - 1].push(l);
  });

  const flag = flagConf();
  const runsOf = (words, last = true) => {
    const runs = [];
    let plain = '';
    words.forEach((x, i) => {
      const piece = normalizeShaping(x.text);
      const space = i < words.length - 1 || !last ? ' ' : '';
      if (x.conf < flag) {
        if (plain) runs.push({ text: plain, lowConf: false });
        runs.push({ text: piece, lowConf: true, alts: x.alts.length ? x.alts : undefined });
        plain = space;
      } else plain += piece + space;
    });
    if (plain) runs.push({ text: plain, lowConf: false });
    return runs;
  };
  return groups.map((g) => {
    const words = g.flatMap((l) => l.words);
    const text = words.map((x) => x.text).join(' ');
    const footnote = g.every((l) => l.footnote);
    if (g.length === 1 && g[0].separator) return { text, heading: false, center: true, footnote, indent: 0, runs: [{ text, lowConf: false }] };
    if (g.length === 1 && isVerse(g[0])) {
      // each half on a tab of its own: the first at the middle of the right half of the line, the second at that of the left one
      const k = halfAt(g[0]);
      const [a, b] = [runsOf(words.slice(0, k), false), runsOf(words.slice(k))];
      a[0] = { ...a[0], tab: true };
      b[0] = { ...b[0], tab: true };
      return { text: normalizeShaping(text), heading: false, center: false, poem: true, footnote, indent: 0, runs: [...a, ...b] };
    }
    const bracket = text.startsWith('[') && text.endsWith(']');
    // a footnote is never a heading, however short its line ("(١) الروم: قال فيه الشاطبي:")
    const heading = !footnote && g.length === 1 && (bracket || (centred(g[0]) && words.length <= 6));
    // a longer centred line is a line of poetry: centred, but in the size and weight of the body
    const center = !heading && !footnote && g.length === 1 && centred(g[0]);
    const runs = runsOf(words);
    // how far the first line starts from the right edge of the text block (an indented paragraph)
    const indent = heading || center ? 0 : Math.max(0, R - g[0].x1);
    return { text: normalizeShaping(text), heading, center, footnote, indent: indent > span * 0.03 ? indent : 0, runs };
  });
}

const NOTE_NUMBER = /^\s*[([]\s*([0-9٠-٩۰-۹]{1,3})\s*[)\]]/;
const NOTE_MARK = /\s?([([]\s*([0-9٠-٩۰-۹]{1,3})\s*[)\]])(?=[\s.,،؛:!?؟»”"]|$)/g;
const numberOf = (s) => Number(s.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0));

/**
 * The marks in the text that point to the page's notes ("والفقه(١)."): the number of a note of the page in its brackets, just after a
 * word, is raised as the book prints it (a run of its own with `sup`), and set against the word ("الفقه (١)" is "الفقه(١)").
 */
export function raiseNoteMarks(blocks) {
  const notes = new Set(blocks.filter((b) => b.type === 'p' && b.footnote)
    .map((b) => b.runs.map((r) => r.text).join('').match(NOTE_NUMBER)).filter(Boolean).map((m) => numberOf(m[1])));
  if (!notes.size) return blocks;
  // a mark set high over a title in large type ("كتاب الفرائض⁽¹⁾") is a line of its own to the reader: it goes back to the end of
  // the title under it
  const textOf = (b) => b.runs.map((r) => r.text).join('').trim();
  blocks = blocks.filter((b, i) => {
    const m = b.type === 'p' && !b.footnote && textOf(b).match(/^[([]\s*([0-9٠-٩۰-۹]{1,3})\s*[)\]]$/);
    const next = blocks[i + 1];
    if (!m || !notes.has(numberOf(m[1])) || !next || next.type !== 'p' || next.footnote || !textOf(next)) return true;
    const last = next.runs[next.runs.length - 1];
    last.text = last.text.trimEnd();
    next.runs.push({ ...last, text: textOf(b).replace(/\s+/g, ''), sup: true, lowConf: undefined, alts: undefined });
    return false;
  });
  for (const b of blocks) {
    if (b.type !== 'p' || b.footnote || b.poem) continue;
    let before = '';
    b.runs = b.runs.flatMap((r) => {
      const out = [];
      let at = 0;
      if (!r.sup && !r.verse) {
        for (const m of r.text.matchAll(NOTE_MARK)) {
          if (!notes.has(numberOf(m[2])) || !/[\p{L}\p{M}]$/u.test(before + r.text.slice(0, m.index))) continue;
          if (m.index > at) out.push({ ...r, text: r.text.slice(at, m.index) });
          out.push({ ...r, text: m[1].replace(/\s+/g, ''), sup: true, lowConf: undefined, alts: undefined });
          at = m.index + m[0].length;
        }
      }
      before += r.text;
      if (!out.length) return [r];
      if (at < r.text.length) out.push({ ...r, text: r.text.slice(at) });
      return out;
    });
  }
  return blocks;
}

/** Page model paragraphs (flow layout) from the transcription. */
export function paragraphsToBlocks(paragraphs, { bodyPt, ptPerPx, lineGapPt, footRatio = 0.75 } = {}) {
  const chars = paragraphs.reduce((s, p) => s + p.text.length, 0);
  let body = 12;
  if (chars <= 1400) body = 15;
  else if (chars <= 1800) body = 14;
  else if (chars <= 2300) body = 13;
  if (bodyPt) body = bodyPt; // measured from the page: the size the book is printed in
  return raiseNoteMarks(paragraphs.map((p, idx) => {
    const dir = dominantDirection(p.text) || 'rtl';
    const fs = p.heading ? body + 4 : p.footnote ? Math.round(body * footRatio * 2) / 2 : body;
    return {
      type: 'p',
      runs: p.runs ? p.runs.map((r) => ({ text: r.text, fs, bold: !!(p.heading || r.verse), italic: false, lowConf: r.lowConf || undefined, alts: r.alts, tab: r.tab || undefined })) : [{ text: p.text, fs, bold: p.heading, italic: false }],
      dir,
      align: p.poem ? 'start' : p.heading || p.center ? 'center' : (p.text.length > 200 ? 'both' : 'start'),
      poem: p.poem || undefined,
      fs,
      lineCount: p.heading || p.poem ? 1 : Math.max(1, Math.ceil(p.text.length / 70)),
      lineGap: lineGapPt ? lineGapPt * 0.97 * (p.footnote ? footRatio : 1) : null,
      footnote: !!p.footnote,
      footRatio: p.footnote ? footRatio : undefined,
      ruleAbove: !!p.footnote && !(paragraphs[idx - 1] && paragraphs[idx - 1].footnote),
      firstLine: p.indent && ptPerPx ? p.indent * ptPerPx : 0,
      ocr: true, // lets the Quran guard also look for verses that have no brackets
      ai: true,
    };
  }));
}

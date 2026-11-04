// "AI reading" of page images with a vision model: far more accurate than Tesseract on diacritised Arabic books.
//
// Providers (set VISION_PROVIDER):
//   claude  - Anthropic API through the official SDK. Needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / an
//             `ant auth login` profile). Pages are sent to Anthropic. Billed per use.
//   gemini  - Google Gemini API through the official @google/genai SDK. Needs GEMINI_API_KEY; GEMINI_MODEL picks the model
//             (default gemini-flash-latest). Pages are sent to Google.
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
import { dominantDirection, normalizeShaping, stripMarks } from './arabic.js';
import { replaceRange, matchKey, rasmKey } from './quran.js';
import { sallaSlots, sallaLetters } from './honorifics.js';
import { createCanvas } from '@napi-rs/canvas';
import { segmentLines, isHeadLine, findFootnoteRule, lineOrnament, isolateLine, lineGaps } from './text-lines.js';
import { wordConfidence } from './token-confidence.js';
import { lineNumbers } from './page-digits.js';
import { findSalla } from './salla-glyph.js';
import { batchKey, batchAnswer, queueRequest, restRequest, DeferredRead } from './gemini-batch.js';

const DEFAULT_MODELS = { claude: 'claude-opus-5-5', gemini: 'gemini-flash-latest', ollama: 'qwen2.5vl:7b', llamacpp: 'qari-ocr' };
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
      timeout: Number(process.env.GEMINI_TIMEOUT_MS) || 75_000,
      // a server error is tried once more; a quota answer (429) is handled below, a slow answer (504) is not waited for twice
      retryOptions: { attempts: 2, httpStatusCodes: [500, 502, 503], maxDelay: 5 },
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
 */
async function geminiOnce(jpeg, model, system, user, maxTokens, { batch, cache, media } = {}) {
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
    response = await geminiClient().models.generateContent({
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
    });
  } catch (err) {
    // the cache expired or was deleted: the page is read without it
    if (cached && (err?.status === 403 || err?.status === 404)) return geminiOnce(jpeg, model, system, user, maxTokens, { batch, media });
    if (err?.status !== 400) throw err;
    // a setting the model does not take: thinking first (as before), then the media resolution; each is remembered
    if (thinking) geminiThinking.set(model, null);
    else if (media) geminiNoMedia.add(model);
    else throw err;
    return geminiOnce(jpeg, model, system, user, maxTokens, { batch, cache, media });
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

/**
 * Read with Gemini: GEMINI_MODEL first, then the models of GEMINI_FALLBACK_MODEL (comma separated, default
 * gemini-flash-lite-latest; empty = none) once a model's quota is used up. A per-minute limit (a short wait) is waited for once.
 * `o`: batch / cache / media, as geminiOnce.
 */
async function viaGemini(jpeg, model, system = SYSTEM_PROMPT, user = USER_PROMPT, maxTokens = 16000, o = {}) {
  const fallback = (process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-flash-lite-latest').split(',').map((s) => s.trim()).filter(Boolean);
  // retries end in time for the page's own limit (PAGE_TIMEOUT_MS), so a page that cannot be read still gets the standard OCR
  const deadline = Date.now() + (Number(process.env.GEMINI_RETRY_BUDGET_MS) || 100_000);
  const fits = (ms) => Date.now() + ms < deadline;
  let quotaErr = null;
  let lastErr = null;
  for (const m of [...new Set([model, ...fallback])]) {
    if ((geminiBlocked.get(m) || 0) > Date.now()) continue;
    for (let attempt = 0; ; attempt++) {
      try {
        return await geminiOnce(jpeg, m, system, user, maxTokens, o);
      } catch (err) {
        if (err?.deferred) throw err;
        if (err?.status === 429) {
          // a per-minute limit (Google says to wait seconds) is waited for; a daily one blocks the model until Google says
          const wait = geminiRetryMs(err.message);
          if (attempt < 2 && wait !== null && wait <= 65_000 && fits(wait + 500)) { await sleep(wait + 500); continue; }
          geminiBlocked.set(m, Date.now() + Math.max(wait ?? 60_000, 60_000));
          quotaErr = err;
          break;
        }
        if (!geminiTransient(err)) throw err;
        // the model is overloaded ("high demand", 503) or slow (504): asked again after a pause, then the next model
        lastErr = err;
        const base = Number(process.env.GEMINI_RETRY_PAUSE_MS) || 5000;
        const pause = (attempt + 1) * base * (1 + Math.random() * 0.6);
        if (attempt < 2 && fits(pause + 15_000)) { await sleep(pause); continue; }
        break;
      }
    }
  }
  if (lastErr) throw lastErr;
  const err = new Error('Gemini quota used up (free tier daily limit): try again later or enable billing');
  err.cause = quotaErr;
  throw err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A failure that is Google's load, not the page: overloaded, server error, deadline, or the connection dropped. */
export function geminiTransient(err) {
  if ([500, 502, 503, 504].includes(err?.status)) return true;
  if (err?.status) return false;
  return err?.name === 'AbortError' || /timed? ?out|deadline|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(String(err?.message));
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
async function viaLlamaCpp(jpeg, maxTokens = 2000, { probs = false, timeoutMs, penalty } = {}) {
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
    // no text line on the page (a cover, an ornament): Qari reads lines, a whole page would not even fit its context
    if (st.provider === 'llamacpp') return { paragraphs: [], noText: true, usage: { output_tokens: 0 }, model: st.model };
  }
  const out = st.external ? await readCloudPage(jpeg, st, { arabicOnly, batch, cache })
    : st.provider === 'llamacpp' ? await viaLlamaCpp(jpeg, 2000)
      : await viaOllama(jpeg, st.model);
  if (out.refused) return { paragraphs: [], noText: false, refused: true, usage: out.usage, model: out.model || st.model, tried: out.tried };
  // the local fallback reader gives paragraphs, already cleaned
  if (out.paragraphs) { fixBasmala(out.paragraphs); return out; }
  const parsed = parseTranscription(out.text);
  parsed.paragraphs = markFootnotes(parsed.paragraphs, { rule: card ? false : await hasFootnoteRule(jpeg).catch(() => false) });
  if (arabicOnly) for (const p of parsed.paragraphs) p.text = p.text.split(' ').map((w) => cleanArabicLetters(w)).filter(Boolean).join(' ');
  fixBasmala(parsed.paragraphs);
  parsed.paragraphs = parsed.paragraphs.map(markIllegible);
  return { ...parsed, truncated: out.truncated, usage: out.usage, model: out.model || st.model, via: out.via, tried: out.tried, bands: out.bands };
}

/** A word the reader marked unreadable becomes a highlighted run (lowConf), so a proof-reader finds it in the Word file. */
export function markIllegible(p) {
  if (!p.text.includes(ILLEGIBLE)) return p;
  const runs = [];
  p.text.split(ILLEGIBLE).forEach((part, i) => {
    if (i) runs.push({ text: ILLEGIBLE, lowConf: true });
    if (part) runs.push({ text: part, lowConf: false });
  });
  return { ...p, runs };
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
    : st.provider === 'ollama' ? await viaOllama(jpeg, st.model, LINE_SYSTEM_PROMPT, LINE_USER_PROMPT, 120, { numCtx: 2048, timeoutMs: 60_000, penalty })
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
  // Several lines at once: the model's speed is limited by memory bandwidth while it writes, so Ollama writes parallel lines
  // (OLLAMA_NUM_PARALLEL) in nearly the same time as one. Results are kept in line order.
  const parallel = Math.max(1, Number(process.env.VISION_LINE_PARALLEL) || 8);
  const envNum = (name, d) => (process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : d);
  // white space kept around each line (px). Measured: tighter crops cut the image tokens by a quarter but made the reader drop words
  const lineMargin = envNum('VISION_LINE_MARGIN', 12);
  const linePad = envNum('VISION_LINE_PAD', 20);
  /** Read one line (or the part [left, right) of it) and return its words. */
  async function readBox(box, left = 0, right = w, enlarge = 1) {
    if (box.ornament !== undefined) right = Math.min(right, box.ornament);
    // the reader makes words of a ﷺ glyph ("وَشَيْءٌ"), and of a line with a wide gap in it (a verse's two halves, two notes)
    // reads one side only: the line is read in parts, up to each and from after it
    const words = [];
    const room = (box.y1 - box.y0) * 0.5; // narrower than that, a part holds no word
    const cuts = [
      ...(box.salla || []).map((g) => ({ ...g, text: SALLA })),
      ...lineGaps(data, w, box, left, right),
    ].filter((g) => g.x0 >= left && g.x1 < right).sort((a, b) => b.x1 - a.x1);
    let end = right;
    for (const g of cuts) {
      if (g.x1 >= end) continue; // inside a part already cut off
      if (end - g.x1 > room) words.push(...await readSpan(box, g.x1 + 1, end, enlarge));
      if (g.text) words.push({ text: g.text, conf: 1, alts: [] });
      end = g.x0;
    }
    if (end - left > room) words.push(...await readSpan(box, left, end, enlarge));
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
    // a loop of nothing but scraps ("م ، م ،") was read from a rule or an ornament, not from words
    // and so is a line of five scraps or more with no digit ("ه ه م ه ه جه" over a title): no printed line is only that
    const scraps = kept.every((x) => stripMarks(x.text).replace(/[^\p{L}\p{N}]/gu, '').length <= 2 && !/[0-9٠-٩۰-۹]/.test(x.text));
    if (scraps && (looped || kept.length >= 5)) kept = [];
    // a line with hardly any diacritics was printed without them: marks the model added on its own are removed
    if (isMostlyPlain(kept.map((x) => x.text).join(' '))) kept = kept.map((x) => ({ ...x, text: stripMarks(x.text), alts: x.alts.map((a) => stripMarks(a)) }));
    return setNumbers(kept, box, left, right);
  }
  /**
   * The numbers of a line (a year, a date) as the shapes of their digits read them: the reader writes other digits than the
   * printed ones (١٢٩٣ as ١١٤٤, ٩٧٩ as "٩:٤٩"). Its numbers of two digits or more, outside brackets (a note's number "[١٧]"), are
   * set when the page shows as many numbers of three digits or more in that part of the line, in the same order.
   */
  async function setNumbers(words, box, left, right) {
    const text = words.map((x) => x.text).join(' ');
    // a number as the reader wrote it, its digits perhaps split by a colon, a dot or spaces ("٩:٤٩", "9 12", "٢٠٠٢ . ٢")
    const all = [...text.matchAll(/[0-9٠-٩۰-۹]+(?:[ :.]{1,3}[0-9٠-٩۰-۹]+)*/g)]
      .filter((m) => !/[([{﴿«]/.test(text[m.index - 1] || '') && !/[)\]}﴾»]/.test(text[m.index + m[0].length] || ''));
    const digits = (m) => m[0].replace(/[^0-9٠-٩۰-۹]/g, '').length;
    let groups = all.filter((m) => digits(m) >= 2);
    if (!groups.length) return words;
    const numbers = (await lineNumbers(data, w, h, box).catch(() => [])).filter((r) => r.x0 >= left && r.x1 < right);
    // a year the reader cut down to one digit ("أغسطس ٢ م" for ٢٠٠٢) is still one of the line's numbers
    if (numbers.length !== groups.length) groups = all;
    if (numbers.length !== groups.length) return words;
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
  const read = new Array(boxes.length);
  let next = 0;
  async function worker() {
    while (next < boxes.length) {
      const k = next++;
      read[k] = { ...boxes[k], words: await readBox(boxes[k]), footnote: isFootBox(boxes[k]) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, boxes.length) }, worker));
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
  const paragraphs = card ? lines.map((l) => cardLine(l.words)) : unifyDigits(fixNoteNumbers(groupLines(lines)), arabicOnly);
  return { paragraphs, noText: false, usage: { output_tokens: tokens }, model, mode: 'lines', bodyPt, lineGapPt, textBox, headerBox, footRatio };
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

const BASMALA = 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ';
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
    // an item opened by an ornament (❋) is a paragraph of its own
    if (!prev || endsEarly(prev) || indented(l) || isTitle(l) || isTitle(prev) || l.ornament !== undefined) groups.push([]);
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

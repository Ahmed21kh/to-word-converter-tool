// Quran guard: finds Quran quotations in the converted text, aligns them against the
// canonical Uthmani text (Hafs) and repairs / reports differences.
//
// Matching is tolerant to missing letters, wrong diacritics, merged or split words, so
// it can repair glyphs that the PDF's text layer (or OCR) failed to decode.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stripMarks, toWesternDigits, UNMAPPED } from './arabic.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

let DB = null;

const FOLD = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ی': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ي', 'ک': 'ك' };
const DROP = new Set(['ء', 'ا', 'ۥ', 'ۦ', 'ـ']);

/** Letters-only comparison key: no marks, folded hamza/alef/ya forms, no alef (Uthmani vs Imla'i). */
export function matchKey(word) {
  let out = '';
  for (const ch of stripMarks(word)) {
    const c = FOLD[ch] ?? ch;
    if (DROP.has(c) || /[\s\u200B-\u200F"'.,:;؛،]/.test(c)) continue;
    out += c;
  }
  return out;
}

/** Stricter key for surah names (النساء and الناس must stay different). */
function nameKey(name) {
  let out = '';
  for (const ch of stripMarks(name)) {
    const c = FOLD[ch] ?? ch;
    if (!/[\s\u200B-\u200F\u0640]/.test(c)) out += c;
  }
  return out;
}

function load() {
  if (DB) return DB;
  const raw = JSON.parse(readFileSync(path.join(dataDir, 'quran-uthmani.json'), 'utf8'));
  const surahNames = JSON.parse(readFileSync(path.join(dataDir, 'surah-names.json'), 'utf8'));
  const words = [];
  for (const [s, a, text] of raw) {
    for (const w of text.split(/\s+/).filter(Boolean)) words.push({ s, a, w, key: matchKey(w) });
  }
  const index = new Map();
  words.forEach((w, i) => {
    if (!w.key) return;
    if (!index.has(w.key)) index.set(w.key, []);
    index.get(w.key).push(i);
  });
  const nameKeys = surahNames.map((n) => nameKey(n));
  // first word index of every verse (and a sentinel) for citation-anchored matching
  const verseStart = new Map();
  words.forEach((w, i) => {
    const k = `${w.s}:${w.a}`;
    if (!verseStart.has(k)) verseStart.set(k, i);
  });
  DB = { words, index, surahNames, nameKeys, verseStart };
  return DB;
}

// ---- edit distance ----------------------------------------------------------------
const distCache = new Map();
function wordCost(a, b) {
  if (a === b) return 0;
  const k = `${a}|${b}`;
  const hit = distCache.get(k);
  if (hit !== undefined) return hit;
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 1;
  // the unmapped-glyph marker in `a` is a wildcard standing for 1-4 missing letters
  const rows = [Array.from({ length: m + 1 }, (_, j) => j)];
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    const wild = a[i - 1] === UNMAPPED;
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(rows[i - 1][j] + 1, cur[j - 1] + 1, rows[i - 1][j - 1] + (wild || a[i - 1] === b[j - 1] ? 0 : 1));
      if (wild) for (let k = 2; k <= 4 && j - k >= 0; k++) cur[j] = Math.min(cur[j], rows[i - 1][j - k] + 0.15 * k);
    }
    rows.push(cur);
  }
  const c = rows[n][m] / Math.max(n, m);
  if (distCache.size > 200000) distCache.clear();
  distCache.set(k, c);
  return c;
}

/** Semi-global alignment of quote keys Q against Quran words R (free start/end in R). */
function align(Q, R) {
  const m = Q.length;
  const n = R.length;
  const D = Array.from({ length: m + 1 }, () => new Float32Array(n + 1));
  const B = Array.from({ length: m + 1 }, () => new Uint8Array(n + 1));
  for (let i = 1; i <= m; i++) {
    D[i][0] = i;
    B[i][0] = 2;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const sub = D[i - 1][j - 1] + wordCost(Q[i - 1], R[j - 1].key);
      const del = D[i - 1][j] + 1;
      const ins = D[i][j - 1] + 1;
      if (sub <= del && sub <= ins) {
        D[i][j] = sub;
        B[i][j] = 1;
      } else if (del <= ins) {
        D[i][j] = del;
        B[i][j] = 2;
      } else {
        D[i][j] = ins;
        B[i][j] = 3;
      }
    }
  }
  let jEnd = 0;
  for (let j = 1; j <= n; j++) if (D[m][j] < D[m][jEnd]) jEnd = j;
  let i = m;
  let j = jEnd;
  while (i > 0) {
    if (j === 0) break;
    const b = B[i][j];
    if (b === 1) {
      i--;
      j--;
    } else if (b === 2) i--;
    else j--;
  }
  return { cost: D[m][jEnd], jStart: j, jEnd };
}

/**
 * Find the best Quran passage for a piece of text.
 * @returns {{start:number,end:number,sim:number,exact:boolean}|null} word range in the Quran stream
 */
export function findPassage(text, hint = null) {
  const { words, index, verseStart } = load();
  const Q = text.split(/\s+/).map(matchKey).filter(Boolean);
  if (Q.length < 2) return null;
  const votes = new Map();
  Q.forEach((k, i) => {
    const pos = index.get(k);
    if (!pos || pos.length > 600) return;
    const w = 1 / pos.length;
    for (const p of pos) votes.set(p - i, (votes.get(p - i) || 0) + w);
  });
  if (!votes.size) return null;
  const top = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  let best = null;
  for (const [d] of top) {
    const lo = Math.max(0, d - 4);
    const hi = Math.min(words.length, d + Q.length + 4);
    const R = words.slice(lo, hi);
    const { cost, jStart, jEnd } = align(Q, R);
    const sim = 1 - cost / Math.max(Q.length, jEnd - jStart);
    if (!best || sim > best.sim) best = { start: lo + jStart, end: lo + jEnd, sim, cost };
  }
  // A citation such as [البقرة: 255] anchors the search: it resolves repeated verses and rescues
  // quotations too damaged to be found on their own.
  if (hint) {
    const from = verseStart.get(`${hint.surah}:${hint.from}`);
    const nextKey = verseStart.get(`${hint.surah}:${hint.to + 1}`) ?? verseStart.get(`${hint.surah + 1}:1`) ?? words.length;
    if (from !== undefined) {
      const lo = from;
      const hi = nextKey;
      const { cost, jStart, jEnd } = align(Q, words.slice(lo, hi));
      const sim = 1 - cost / Math.max(Q.length, jEnd - jStart);
      if (jEnd > jStart && sim >= 0.45 && (!best || sim >= best.sim - 0.08 || best.sim < 0.78)) {
        const viaCitation = !best || best.start !== lo + jStart;
        best = { start: lo + jStart, end: lo + jEnd, sim, cost, viaCitation, anchored: true };
      }
    }
  }
  if (!best || best.end <= best.start) return null;
  best.exact = best.cost === 0;
  return best;
}

export function canonicalText(start, end) {
  return load().words.slice(start, end).map((w) => w.w).join(' ');
}

export function passageRef(start, end) {
  const { words, surahNames } = load();
  const a = words[start];
  const b = words[end - 1];
  const name = surahNames[a.s - 1];
  if (a.s === b.s) return { surah: a.s, name, from: a.a, to: b.a, label: a.a === b.a ? `${name}: ${a.a}` : `${name}: ${a.a}-${b.a}` };
  return { surah: a.s, name, from: a.a, to: b.a, label: `${name}: ${a.a} - ${surahNames[b.s - 1]}: ${b.a}` };
}

const MARK_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const marksRatio = (s) => {
  const letters = [...s.replace(MARK_RE, '')].filter((c) => /[ء-يٱ-ۓ]/.test(c)).length;
  const marks = (s.match(MARK_RE) || []).length;
  return letters ? marks / letters : 0;
};
// compare ignoring harmless differences in mark order and spacing
const canonicalForm = (s) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => [...w].reduce((acc, c) => {
      if (/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/.test(c) && acc.length && /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/.test(acc[acc.length - 1].at(-1))) {
        acc[acc.length - 1] += c;
      } else acc.push(c);
      return acc;
    }, []).map((cl) => [...cl].sort().join('')).join(''))
    .join(' ');

// ---- citation parsing ------------------------------------------------------------------
const CITE = /^[\s ]*[\[(\uFD3F\uFD3E]?[\s ]*(?:سورة[\s ]+)?([ء-يٱ  ]{2,24}?)[\s ]*[:：،\-–][\s ]*(?:الآية[\s ]+|آية[\s ]+)?([0-9٠-٩۰-۹]{1,3})(?:[\s ]*[-–][\s ]*([0-9٠-٩۰-۹]{1,3}))?[\s ]*[\])]/;

/** Parse "[البقرة: 255]" right after a verse. Returns null when there is no citation. */
function parseCitation(after) {
  const m = CITE.exec(after);
  if (!m) return null;
  const { nameKeys } = load();
  const key = nameKey(m[1].trim());
  const sIdx = nameKeys.findIndex((k) => k === key);
  const from = Number(toWesternDigits(m[2]));
  const to = m[3] ? Number(toWesternDigits(m[3])) : from;
  return { cited: `${m[1].trim()}: ${m[3] ? `${from}-${to}` : from}`, surah: sIdx === -1 ? null : sIdx + 1, from, to };
}

function citationMatches(cite, ref) {
  return cite.surah === ref.surah && cite.from <= ref.from && cite.to >= ref.to;
}

// ---- applying to runs --------------------------------------------------------------------------
/** Replace [start,end) of the concatenated run text; the new text takes the style of the first covered run. */
export function replaceRange(runs, start, end, replacement) {
  let pos = 0;
  let inserted = false;
  for (const r of runs) {
    const rs = pos;
    const re = pos + r.text.length;
    pos = re;
    if (re <= start || rs >= end) {
      if (!(rs <= start && start === end && start <= re && !inserted)) continue;
    }
    const a = Math.max(start, rs) - rs;
    const b = Math.min(end, re) - rs;
    r.text = r.text.slice(0, a) + (inserted ? '' : replacement) + r.text.slice(Math.max(a, b));
    inserted = true;
  }
  for (let i = runs.length - 1; i >= 0; i--) if (!runs[i].text) runs.splice(i, 1);
}

const BRACKETED = /[\uFD3E\uFD3F]([^\uFD3E\uFD3F]{3,}?)[\uFD3E\uFD3F]/g;

// A verse printed without diacritics is corrected in its letters only: the converter never adds marks the book does not have.
const ALEF_WASLA = String.fromCharCode(0x671);
const plainForm = (s) => stripMarks(s).split(ALEF_WASLA).join('ا');

/** Give [start,end) of the concatenated run text the extra properties, splitting runs at the edges. */
export function styleRange(runs, start, end, props) {
  let pos = 0;
  const out = [];
  for (const r of runs) {
    const rs = pos;
    const re = pos + r.text.length;
    pos = re;
    if (re <= start || rs >= end) { out.push(r); continue; }
    const a = Math.max(start, rs) - rs;
    const b = Math.min(end, re) - rs;
    if (a > 0) out.push({ ...r, text: r.text.slice(0, a) });
    out.push({ ...r, ...props, text: r.text.slice(a, b) });
    if (b < r.text.length) out.push({ ...r, text: r.text.slice(b) });
  }
  runs.splice(0, runs.length, ...out);
}

const INDIC = '٠١٢٣٤٥٦٧٨٩';
const toIndic = (n) => String(n).split('').map((c) => INDIC[Number(c)]).join('');

/**
 * The reader often drops or misreads the tiny number of a citation ("[آل عمران: ]", "[الإخلاص: ا]"). Once the guard has identified the
 * verse right before it, the number is known: only a citation WITHOUT any digit is completed, a printed number is never replaced.
 */
function fixMissingCitation(par, text, from, ref) {
  let i = from;
  while (i < text.length && text[i] === ' ') i++;
  if (text[i] !== '[') return;
  const close = text.indexOf(']', i);
  if (close < 0 || close - i > 40) return;
  const inner = text.slice(i + 1, close);
  const colon = inner.indexOf(':');
  if (colon < 0) return;
  if (inner.slice(colon + 1).split('').some((c) => '0123456789'.includes(c) || INDIC.includes(c))) return;
  replaceRange(par.runs, i + 1, close, `${ref.name}: ${toIndic(ref.from)}${ref.to !== ref.from ? '-' + toIndic(ref.to) : ''}`);
}

/** Verses of an AI-read paragraph are set apart as the book prints them (heavier weight) and are never marked as doubtful. */
function styleVerses(par) {
  const text = par.runs.map((r) => r.text).join('');
  BRACKETED.lastIndex = 0;
  const ranges = [];
  let m;
  while ((m = BRACKETED.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  for (const [a, b] of ranges.reverse()) styleRange(par.runs, a, b, { verse: true, lowConf: undefined, alts: undefined });
}

/**
 * Check one paragraph. Mutates paragraph.runs when a repair is made.
 * @returns {Array} findings
 */
const ORNATE_OPEN = String.fromCharCode(0xfd3f);
const ORNATE_CLOSE = String.fromCharCode(0xfd3e);

/**
 * Find Quran passages inside running text that has no ornate brackets (typical for OCR output, which has
 * lost the brackets and the diacritics). A passage is a run of >= minWords words that matches the Mushaf.
 * @returns {{start:number,end:number}[]} character ranges of the passages
 */
/**
 * How strong is the evidence that `text` really is the passage `hit`? Words that match exactly count by how
 * rare they are in the Quran: "إن الله لا" (very common) proves nothing, "أنزل عليك الكتاب" does.
 */
function evidence(text, hit) {
  const { words, index } = load();
  const region = new Set(words.slice(hit.start, hit.end).map((w) => w.key));
  let sum = 0;
  let n = 0;
  for (const k of text.split(' ').map(matchKey).filter(Boolean)) {
    if (region.has(k)) {
      n++;
      sum += Math.log(words.length / (index.get(k)?.length || 1));
    }
  }
  return { sum, n };
}

const MIN_EVIDENCE = 26; // nats (about 5-6 exactly matching distinctive words)
const MIN_EXACT_WORDS = 5;

/** Letter similarity (0..1) of a printed word and the Mushaf word at `index`. */
function wordSim(printed, index) {
  const a = matchKey(printed);
  const b = load().words[index]?.key || '';
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

export function findPlainQuranSpans(text, { minWords = 5, minSim = 0.74 } = {}) {
  const words = [...text.matchAll(/\S+/g)].map((m) => ({ w: m[0], start: m.index, end: m.index + m[0].length }));
  const joined = (a, b) => words.slice(a, b).map((x) => x.w).join(' ');
  const spans = [];
  let i = 0;
  while (i + minWords <= words.length) {
    const hit = findPassage(joined(i, i + minWords));
    if (!hit || hit.sim < minSim || hit.end - hit.start < minWords - 1) {
      i++;
      continue;
    }
    let best = hit;
    let j = i + minWords;
    while (j < words.length) { // extend right while the next word still belongs to the verse
      const h = findPassage(joined(i, j + 1));
      // a word is only taken into the verse when it looks like the Mushaf word it would stand for (never a plain word like "قال")
      if (h && h.sim >= minSim - 0.04 && h.cost <= best.cost + 0.5 && wordSim(words[j].w, h.end - 1) >= 0.5) { best = h; j++; } else break;
    }
    let k = i;
    while (k > 0) { // ... and left
      const h = findPassage(joined(k - 1, j));
      if (h && h.sim >= minSim - 0.04 && h.cost <= best.cost + 0.5 && wordSim(words[k - 1].w, h.start) >= 0.5) { best = h; k--; } else break;
    }
    // the first and last printed words must look like the Mushaf words they stand for: a plain word that merely sits next to the
    // verse ("قال تعالى") is not part of it, whatever the tolerance of the search
    for (;;) {
      if (j - k <= minWords - 1 || wordSim(words[k].w, best.start) >= 0.5) break;
      const h = findPassage(joined(k + 1, j));
      if (!h) break;
      k++;
      best = h;
    }
    for (;;) {
      if (j - k <= minWords - 1 || wordSim(words[j - 1].w, best.end - 1) >= 0.5) break;
      const h = findPassage(joined(k, j - 1));
      if (!h) break;
      j--;
      best = h;
    }
    const ev = evidence(joined(k, j), best);
    // after trimming, the passage must still be as long as asked (a plain word next to a verse does not count towards it)
    if (j - k >= minWords && ev.sum >= MIN_EVIDENCE && ev.n >= MIN_EXACT_WORDS) spans.push({ start: words[k].start, end: words[j - 1].end });
    i = j;
  }
  return spans;
}

/**
 * AI readers print the ornate verse brackets as asterisks ("* وَمَا يَذَّكَّرُ ... *"). In this app a pair of asterisks inside an AI-read
 * paragraph is the pair of verse brackets: they become ﴿ ﴾ (parentheses printed right next to them are dropped), after which the
 * normal verification flow applies. An unpaired asterisk is left alone.
 */
function starsToOrnate(par) {
  const text = par.runs.map((r) => r.text).join('');
  const at = [];
  for (let i = 0; i < text.length; i++) if (text[i] === '*') at.push(i);
  const pairs = [];
  for (let k = 0; k + 1 < at.length; k += 2) pairs.push([at[k], at[k + 1]]);
  for (const [a, b] of pairs.reverse()) {
    if (b - a < 4 || b - a > 500) continue;
    let inner = text.slice(a + 1, b).trim();
    if (inner.startsWith('(')) inner = inner.slice(1).trim();
    if (inner.endsWith(')')) inner = inner.slice(0, -1).trim();
    let end = b + 1;
    if (text[end] === ')') end++;
    replaceRange(par.runs, a, end, ORNATE_OPEN + inner + ORNATE_CLOSE);
  }
}

/** Ranges of the ornate-bracketed passages already in the text. */
function ornateRanges(text) {
  const out = [];
  BRACKETED.lastIndex = 0;
  let m;
  while ((m = BRACKETED.exec(text))) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Parenthesised groups ( ... ) as [start, end) of the parentheses themselves; no nesting. */
function parenGroups(text) {
  const out = [];
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') open = i;
    else if (text[i] === ')' && open >= 0) { out.push([open, i + 1]); open = -1; }
  }
  return out;
}

/**
 * Put ornate brackets around passages that are not bracketed yet (so the normal verification flow applies):
 * - plain passages found by findPlainQuranSpans (OCR / AI output has usually lost the brackets), also next to other bracketed ones;
 * - ( ... ) groups that match the Mushaf (a reader that cannot tell the ornate brackets apart prints them as parentheses).
 * Parentheses printed around a passage are taken into it, so no stray ")" is left behind.
 */
function bracketPlainQuranSpans(par) {
  const text = par.runs.map((r) => r.text).join('');
  const taken = ornateRanges(text);
  const free = (x, y) => !taken.some(([p, q]) => x < q && y > p);
  const jobs = [];
  for (const sp of findPlainQuranSpans(text, { minWords: par.ai ? 7 : 5 })) {
    if (!free(sp.start, sp.end)) continue;
    let start = sp.start;
    let end = sp.end;
    let opened = false;
    while (start > 0 && (text[start - 1] === '(' || text[start - 1] === '*')) { opened = opened || text[start - 1] === '('; start--; }
    if (text[start] === '(') opened = true;
    if (opened) {
      let e = end;
      while (e < text.length && text[e] === ' ') e++;
      if (text[e] === ')') end = e + 1;
    }
    let inner = text.slice(sp.start, sp.end);
    if (inner.startsWith('(')) inner = inner.slice(1);
    if (inner.endsWith(')')) inner = inner.slice(0, -1);
    jobs.push({ start, end, inner });
    taken.push([start, end]);
  }
  for (const [x, y] of parenGroups(text)) {
    if (!free(x, y)) continue;
    const inner = text.slice(x + 1, y - 1).trim();
    const nWords = inner.split(' ').filter(Boolean).length;
    // a citation right after the group names the verse: even a short, badly read quotation can then be repaired from it
    const cite = parseCitation(text.slice(y, y + 60));
    if (cite && cite.surah && nWords >= 2 && nWords <= 40) {
      jobs.push({ start: x, end: y, inner });
      taken.push([x, y]);
      continue;
    }
    if (nWords < 4) continue;
    const hit = findPassage(inner);
    if (!hit || hit.sim < 0.8 || hit.end - hit.start < 4) continue;
    jobs.push({ start: x, end: y, inner });
    taken.push([x, y]);
  }
  jobs.sort((p, q) => q.start - p.start);
  for (const j of jobs) replaceRange(par.runs, j.start, j.end, ORNATE_OPEN + j.inner + ORNATE_CLOSE);
}

export function guardParagraph(par, { mode = 'correct', minSim = 0.78 } = {}) {
  const findings = [];
  if (par.ai && mode !== 'off') starsToOrnate(par);
  if (par.ocr && mode !== 'off') bracketPlainQuranSpans(par);
  const text = par.runs.map((r) => r.text).join('');
  const spans = [];
  let m;
  BRACKETED.lastIndex = 0;
  while ((m = BRACKETED.exec(text))) spans.push({ start: m.index + 1, end: m.index + 1 + m[1].length, bracketEnd: m.index + m[0].length });

  // whole-paragraph Quran text without brackets (e.g. Mushaf-style pages)
  if (!spans.length && text.replace(/\s+/g, ' ').trim().split(' ').length >= 4) {
    const hit = findPassage(text);
    if (hit && hit.sim >= 0.9 && hit.end - hit.start >= 4) spans.push({ start: 0, end: text.length, bracketEnd: text.length, plain: true });
  }
  for (const sp of spans.reverse()) {
    const inner = text.slice(sp.start, sp.end);
    const cite = sp.plain ? null : parseCitation(text.slice(sp.bracketEnd, sp.bracketEnd + 60));
    const hint = cite && cite.surah ? { surah: cite.surah, from: cite.from, to: cite.to } : null;
    const hit = findPassage(inner, hint);
    // A quotation anchored by its citation may be badly damaged yet still safe to repair (small search window).
    const floor = hit?.anchored ? 0.5 : minSim;
    if (!hit || hit.sim < floor) {
      findings.push({ status: 'unmatched', text: inner.trim().slice(0, 160), reason: hit ? `best match ${(hit.sim * 100).toFixed(0)}%` : 'no match', ...(cite ? { cited: cite.cited } : {}) });
      continue;
    }
    const ref = passageRef(hit.start, hit.end);
    if (!cite && !sp.plain && mode === 'correct' && par.ai && (hit.exact || hit.sim >= 0.9)) fixMissingCitation(par, text, sp.bracketEnd, ref);
    const canon = canonicalText(hit.start, hit.end);
    const innerTrim = inner.trim();
    let status = 'verified';
    let changed = false;
    if (!hit.exact) {
      status = 'corrected';
      changed = true;
    } else if (marksRatio(innerTrim) >= 0.3 && canonicalForm(innerTrim) !== canonicalForm(canon)) {
      // a verse printed with diacritics gets the Mushaf's (a plain one stays plain)
      status = 'diacritics-fixed';
      changed = true;
    }
    const finding = { status, ref: ref.label, similarity: Number(hit.sim.toFixed(3)), text: innerTrim.slice(0, 160) };
    if (hit.anchored && hit.sim < minSim) finding.lowConfidence = 'repaired using the citation only; please review';
    if (changed && mode === 'correct') {
      const lead = inner.length - inner.trimStart().length;
      const trail = inner.length - inner.trimEnd().length;
      const plainSource = marksRatio(innerTrim) < 0.1;
      const written = plainSource ? plainForm(canon) : canon;
      replaceRange(par.runs, sp.start + lead, sp.end - trail, written);
      finding.fixedTo = written.slice(0, 160);
    } else if (changed) finding.status = 'needs-review';
    if (cite && !citationMatches(cite, ref)) {
      finding.citationWarning = `Citation "${cite.cited}" does not match the verse found (${ref.label})`;
    }
    findings.push(finding);
  }
  if (par.ai && mode !== 'off') styleVerses(par);
  const leftovers = par.runs.some((r) => r.text.includes(UNMAPPED));
  return { findings: findings.reverse(), hasUnmapped: leftovers };
}

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
    if (DROP.has(c) || /[\s\u200B-\u200F"'.,:;؛،؟!]/.test(c)) continue;
    out += c;
  }
  return out;
}

// Letters that differ only by their dots share one skeleton letter (rasm). A line reader misreads dots far more often than shapes
// (ن/ت/ي/ب, ج/ح/خ, ع/غ, ر/ز, ف/ق, س/ش), so AI-read text is also compared by its skeleton.
const RASM = { 'ب': 'ٮ', 'ت': 'ٮ', 'ث': 'ٮ', 'ن': 'ٮ', 'ي': 'ٮ', 'ج': 'ح', 'خ': 'ح', 'ذ': 'د', 'ز': 'ر', 'ش': 'س', 'ض': 'ص', 'ظ': 'ط', 'غ': 'ع', 'ق': 'ف' };
export const rasmKey = (key) => Array.from(key, (c) => RASM[c] ?? c).join('');

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
    for (const w of text.split(/\s+/).filter(Boolean)) {
      const key = matchKey(w);
      words.push({ s, a, w, key, rkey: rasmKey(key) });
    }
  }
  const index = new Map();
  const rindex = new Map();
  words.forEach((w, i) => {
    if (!w.key) return;
    if (!index.has(w.key)) index.set(w.key, []);
    index.get(w.key).push(i);
    if (!rindex.has(w.rkey)) rindex.set(w.rkey, []);
    rindex.get(w.rkey).push(i);
  });
  const nameKeys = surahNames.map((n) => nameKey(n));
  // first word index of every verse (and a sentinel) for citation-anchored matching
  const verseStart = new Map();
  words.forEach((w, i) => {
    const k = `${w.s}:${w.a}`;
    if (!verseStart.has(k)) verseStart.set(k, i);
  });
  DB = { words, index, rindex, surahNames, nameKeys, verseStart };
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
  const c = (a.includes(UNMAPPED) ? wildDistance(a, b) : distance(a, b)) / Math.max(n, m);
  if (distCache.size > 400000) distCache.clear();
  distCache.set(k, c);
  return c;
}

// plain Levenshtein distance on two reused rows (called very often: no allocation)
let rowA = new Int32Array(64);
let rowB = new Int32Array(64);
function distance(a, b) {
  const m = b.length;
  if (rowA.length <= m) { rowA = new Int32Array(m + 1); rowB = new Int32Array(m + 1); }
  let prev = rowA;
  let cur = rowB;
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[m];
}

/** Distance where the unmapped-glyph marker in `a` is a wildcard standing for 1-4 missing letters. */
function wildDistance(a, b) {
  const n = a.length;
  const m = b.length;
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
  return rows[n][m];
}

/** Cost (0..1) of a printed word against a Mushaf word; with `rasm`, a word that differs only by its dots costs far less. */
function pairCost(q, r, rasm) {
  const c = wordCost(q.key, r.key);
  return rasm && c > 0 ? Math.min(c, wordCost(q.rkey, r.rkey) + 0.4 * c) : c;
}

/**
 * Semi-global alignment of quote words Q against Quran words R (free start/end in R).
 * With `rasm` (AI-read text) a printed word may also stand for two Mushaf words run together ("هُوَالْعَزِيزُ") or two printed
 * words for one Mushaf word.
 */
function align(Q, R, rasm = false) {
  const m = Q.length;
  const n = R.length;
  const D = Array.from({ length: m + 1 }, () => new Float32Array(n + 1));
  const B = Array.from({ length: m + 1 }, () => new Uint8Array(n + 1));
  for (let i = 1; i <= m; i++) {
    D[i][0] = i;
    B[i][0] = 2;
  }
  const joined = (a, b) => ({ key: a.key + b.key, rkey: a.rkey + b.rkey });
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const sub = D[i - 1][j - 1] + pairCost(Q[i - 1], R[j - 1], rasm);
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
      if (!rasm) continue;
      if (j >= 2) {
        const c = pairCost(Q[i - 1], joined(R[j - 2], R[j - 1]), true);
        if (c < 0.34 && D[i - 1][j - 2] + c + 0.2 < D[i][j]) { D[i][j] = D[i - 1][j - 2] + c + 0.2; B[i][j] = 4; }
      }
      if (i >= 2) {
        const c = pairCost(joined(Q[i - 2], Q[i - 1]), R[j - 1], true);
        if (c < 0.34 && D[i - 2][j - 1] + c + 0.2 < D[i][j]) { D[i][j] = D[i - 2][j - 1] + c + 0.2; B[i][j] = 5; }
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
    else if (b === 3) j--;
    else if (b === 4) { i--; j -= 2; } else { i -= 2; j--; }
  }
  return { cost: D[m][jEnd], jStart: j, jEnd };
}

const quoteWords = (text) => text.split(/\s+/).map((w) => { const key = matchKey(w); return { key, rkey: rasmKey(key) }; }).filter((q) => q.key);

/** Align `text` against the Quran words [lo, hi). */
function alignAt(Q, lo, hi, rasm) {
  const { cost, jStart, jEnd } = align(Q, load().words.slice(lo, hi), rasm);
  return { start: lo + jStart, end: lo + jEnd, sim: 1 - cost / Math.max(Q.length, jEnd - jStart), cost };
}

/** Alignments of Q inside [lo, hi), only at the (up to 4) places where most of its words occur. */
function alignWhere(Q, lo, hi, rasm) {
  const { index, rindex } = load();
  const at = new Map();
  Q.forEach((q, i) => {
    for (const [pos, w] of [[index.get(q.key), 1], [rasm ? rindex.get(q.rkey) : null, 0.5]]) {
      for (const p of pos || []) if (p >= lo && p < hi) at.set(p - i, (at.get(p - i) || 0) + w);
    }
  });
  const out = [];
  for (const [d] of [...at.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4)) {
    const h = alignAt(Q, Math.max(lo, d - 4), Math.min(hi, d + Q.length + 4), rasm);
    if (h.end > h.start) out.push(h);
  }
  return out;
}

/** Word index right after the verse(s) of a reference (where a following quotation most likely continues). */
function refEnd(r) {
  const { words, verseStart } = load();
  return r && r.surah ? verseStart.get(`${r.surah}:${r.to + 1}`) ?? verseStart.get(`${r.surah + 1}:1`) ?? words.length : null;
}

/** Word ranges around verses already found nearby ({surah, from, to}), `pad` verses on each side. */
export function contextWindows(refs, pad = 12) {
  const { words, verseStart } = load();
  const out = [];
  for (const r of refs || []) {
    if (!r || !r.surah) continue;
    let lo;
    for (let a = Math.max(1, r.from - pad); lo === undefined && a <= r.from; a++) lo = verseStart.get(`${r.surah}:${a}`);
    if (lo === undefined) continue;
    let hi;
    for (let a = r.to + pad + 1; hi === undefined && a > r.to; a--) hi = verseStart.get(`${r.surah}:${a}`);
    hi = hi ?? verseStart.get(`${r.surah + 1}:1`) ?? words.length;
    out.push([lo, hi]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const w of out) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([...w]);
  }
  return merged;
}

/**
 * Best match of `text` inside the given windows only (verses quoted nearby). Used for short quotations ("﴿وَٱلۡإِنجِيلَ﴾",
 * "﴿فَيَكُونُ﴾") that cannot be told apart in the whole Quran but can next to the verses the page is explaining.
 */
export function findNearby(text, windows, near = null) {
  const Q = quoteWords(text);
  if (!Q.length) return null;
  const all = [];
  for (const [lo, hi] of windows || []) {
    // every place in the window is a candidate; the alignment picks the best one
    const { words } = load();
    const l0 = Q[0].key.length;
    for (let p = lo; p < hi; p++) {
      const l1 = words[p].key.length;
      if (Math.abs(l0 - l1) > 0.5 * Math.max(l0, l1) || pairCost(Q[0], words[p], true) > 0.5) continue; // length alone rules most out
      const h = alignAt(Q, p, Math.min(hi, p + Q.length + 2), true);
      if (h.end > h.start) all.push(h);
    }
  }
  return pickNear(all, near);
}

/**
 * The best of several candidate places; between (nearly) equal ones the one closest to `near` (the verse quoted just before):
 * "﴿إِنَّ مَثَلَ عِيسَىٰ ...﴾، إلى قوله: ﴿كُن فَيَكُونُ﴾" is the end of that same verse, not an earlier "كُن فَيَكُونُ".
 */
function pickNear(cands, near) {
  if (!cands.length) return null;
  const top = Math.max(...cands.map((h) => h.sim));
  const tied = cands.filter((h) => h.sim >= top - 0.02);
  const dist = (h) => (near === null ? 0 : Math.abs(h.start - near));
  const best = tied.reduce((x, y) => (dist(y) < dist(x) ? y : x));
  const others = cands.filter((h) => Math.abs(h.start - best.start) > 2);
  return { ...best, exact: best.cost === 0, local: true, runnerUp: others.length ? Math.max(...others.map((h) => h.sim)) : 0 };
}

/**
 * Find the best Quran passage for a piece of text.
 * opts.rasm: compare AI-read text by letter skeleton too; opts.context: windows of verses quoted nearby, preferred when about as good.
 * @returns {{start:number,end:number,sim:number,exact:boolean,runnerUp:number}|null} word range in the Quran stream
 */
const passageCache = new Map();
export function findPassage(text, hint = null, opts = {}) {
  // the guard asks for the same stretch again and again while it trims a quotation's edges
  const key = `${text}|${hint ? `${hint.surah}:${hint.from}-${hint.to}` : ''}|${opts.rasm ? 1 : 0}|${(opts.context || []).join(';')}|${opts.near ?? ''}`;
  if (passageCache.has(key)) return passageCache.get(key);
  const out = findPassageUncached(text, hint, opts);
  if (passageCache.size > 20000) passageCache.clear();
  passageCache.set(key, out);
  return out;
}

function findPassageUncached(text, hint, { rasm = false, context = null, near = null }) {
  const { words, index, rindex, verseStart } = load();
  const Q = quoteWords(text);
  if (Q.length < 2) return null;
  const votes = new Map();
  Q.forEach((q, i) => {
    const pos = index.get(q.key);
    if (pos && pos.length <= 600) for (const p of pos) votes.set(p - i, (votes.get(p - i) || 0) + 1 / pos.length);
    if (!rasm) return;
    const rpos = rindex.get(q.rkey);
    if (rpos && rpos.length <= 600) for (const p of rpos) votes.set(p - i, (votes.get(p - i) || 0) + 0.5 / rpos.length);
  });
  if (!votes.size && !context?.length) return null;
  const top = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, rasm ? 6 : 4);
  let best = null;
  let runnerUp = 0;
  for (const [d] of top) {
    const h = alignAt(Q, Math.max(0, d - 4), Math.min(words.length, d + Q.length + 4), rasm);
    if (!best || h.sim > best.sim) {
      if (best && Math.abs(best.start - h.start) > 2) runnerUp = Math.max(runnerUp, best.sim);
      best = h;
    } else if (Math.abs(best.start - h.start) > 2) runnerUp = Math.max(runnerUp, h.sim);
  }
  // the verses the page is explaining win over an equally good match elsewhere (repeated phrases such as "كُن فَيَكُونُ")
  // a few words are tried at every place of the windows; a longer quotation only where its words occur
  let local = null;
  if (context?.length && Q.length <= 3) local = findNearby(text, context, near);
  else if (context?.length) local = pickNear(context.flatMap(([lo, hi]) => alignWhere(Q, lo, hi, rasm)), near);
  if (local && (!best || local.sim >= best.sim - 0.06)) {
    if (best && Math.abs(best.start - local.start) > 2) runnerUp = Math.max(runnerUp, best.sim);
    best = { ...local, local: true };
  }
  if (best) best.runnerUp = runnerUp;
  // A citation such as [البقرة: 255] anchors the search: it resolves repeated verses and rescues
  // quotations too damaged to be found on their own.
  if (hint) {
    const from = verseStart.get(`${hint.surah}:${hint.from}`);
    const nextKey = verseStart.get(`${hint.surah}:${hint.to + 1}`) ?? verseStart.get(`${hint.surah + 1}:1`) ?? words.length;
    // a match next to the verses quoted nearby already lies in the cited surah: the (whole-surah) hint adds nothing
    if (from !== undefined && !(best?.local && words[best.start].s === hint.surah)) {
      // a cited verse is aligned whole; a whole surah (the name only) where the printed words occur in it
      const wide = nextKey - from > Q.length + 60;
      const h = wide ? alignWhere(Q, from, nextKey, rasm).reduce((x, y) => (!x || y.sim > x.sim ? y : x), null) : alignAt(Q, from, nextKey, rasm);
      if (h && h.end > h.start && h.sim >= 0.45 && (!best || h.sim >= best.sim - 0.08 || best.sim < 0.78)) {
        const viaCitation = !best || best.start !== h.start;
        best = { ...h, viaCitation, anchored: true, runnerUp: best && best.start !== h.start ? best.sim : (best?.runnerUp || 0) };
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

/** A surah name as a reader prints it: exact, or missing its first word ("عمران" for "آل عمران"), or one letter off. */
function fuzzySurah(printed) {
  const { nameKeys } = load();
  const key = nameKey(printed.trim());
  if (key.length < 2) return null;
  const exact = nameKeys.indexOf(key);
  if (exact >= 0) return exact + 1;
  if (key.length < 4) return null;
  const close = nameKeys.map((k, i) => ({ i, d: k.endsWith(key) ? 0 : wordCost(key, k) * Math.max(key.length, k.length) })).filter((x) => x.d <= 1);
  return close.length === 1 ? close[0].i + 1 : null;
}

const DIGITS = /[0-9٠-٩۰-۹]+/g;
/**
 * A citation as the line reader prints it after a verse. Its tiny digits are often misread ("[آل عمران: ؛]", "[آل عمران: امْ"),
 * the closing bracket can be lost, and a citation broken over two lines can lose its first word ("[ عِمران: ٧٥").
 * @returns {{start:number,end:number,surah:number,range:boolean,nums:number[],raw:string}|null} offsets in `text`
 */
function looseCitation(text, at) {
  const rest = text.slice(at, at + 70);
  const lead = /^\s*/.exec(rest)[0].length;
  const m = /^\[\s*(?:سورة\s+)?([ء-يٱً-ْٰ ]{2,24}?)\s*[:：]\s*(?:([^[\]،,]{0,10}?)\s*\]|([^[\]\s،,]{1,6}(?:\s*[-–]\s*[^[\]\s،,]{1,4})?))/.exec(rest.slice(lead));
  if (!m) return null;
  const surah = fuzzySurah(m[1]);
  if (!surah) return null;
  const numText = m[2] ?? m[3] ?? '';
  const nums = (numText.match(DIGITS) || []).map((d) => Number(toWesternDigits(d)));
  return { start: at + lead, end: at + lead + m[0].length, surah, range: /[-–]/.test(numText), nums, raw: m[0] };
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

// ---- AI-read paragraphs -------------------------------------------------------------------------
// The line reader cannot print the ornate brackets: it writes ﴿ ﴾ as "(" ")", sometimes as "*", "؟", "»", "]" or as a short junk word
// ("كِمْ", "كِمِّا", "ء"), and the verse separator ✱ as "*". A verse is found by its words in the stretches between such delimiters
// (never across a comma or a full stop), grown word by word while the next printed word is the next word of the Mushaf, and the
// delimiters around it become the ornate brackets. Text the book explains in its own words stays prose: without brackets around it a
// stretch must match almost exactly.
// a dash between spaces sets off the author's words inside a quotation ("﴿ذَلِكَ نَتْلُوهُ عَلَيْكَ - يا مُحَمَّدُ - مِنَ الآيَاتِ﴾"): they stay prose
const CHUNK_BREAK = /[()（）«»﴿﴾*[\]،,:؛.!]|(?:^|\s)؟|\s[-–]\s/;
const ASIDE = /^\s[-–]\s[^-–()﴿﴾[\]]{2,60}?\s[-–]\s$/;
const ASIDE_IN = /\s[-–]\s[^-–()﴿﴾[\]]{2,60}?\s[-–]\s/g;
const VOCATIVE = /(?<=^|\s)ي\p{M}*ا\p{M}*\s+[\p{L}\p{M}]+/gu; // "يا مُحَمَّدُ" said to the reader inside a quotation, often without dashes
const HARD_OPEN = /[(（﴿]/;
const HARD_CLOSE = /[)）»﴾]/;
// a misread bracket or the verse separator ("(*)" too); a question mark only when it stands alone ("رَحِيمٌ ؟ قُلْ"), not after a
// word ("وَبَيِّنَةٌ؟"). « » are the quotation marks of a hadith, never of a verse.
const OPENS = /(?:[(（﴿*][)）(（﴿*]*|(?:^|\s)؟)\s*$/;
const CLOSES = /^[\s\p{M}ء]*(?:[)）»﴾*]|؟(?=\s|$))/u;
// what may stand inside one verse: separator, misread brackets, a colon the reader put between two words ("لَهُ:كُنْ")
const SOFT_BREAK = /^(?:(?:[\s()（）»﴿﴾*\p{M}ء]|(?:^|\s)؟(?=\s|$))*|:)$/u;
// what the reader makes of a closing bracket: "كِ" and "ء" are not words; "كِمْ", "كِمِّا" are taken only where a sentence ends
const plainLetters = (w) => stripMarks(w).replace(/ـ/g, '');
const isStrayLetter = (w) => /^(?:ك|ء+)$/.test(plainLetters(w));
const isJunkWord = (w) => isStrayLetter(w) || /^ك(?:م|ما|مي|مم|ي)$/.test(plainLetters(w));
const MARKS_RE = /\p{M}/gu;

/** Words run together by the reader ("هُوَالْعَزِيزُالْحَكِيمُ") are split before each inner "ال" for matching. */
function splitMerged(w) {
  if (w.replace(MARKS_RE, '').length < 8) return [w];
  const parts = w.split(/(?<=[\p{L}][\p{M}]*[\p{L}][\p{M}]*)(?=[اٱأ]\p{M}*ل)/u);
  return parts.every((p) => p.replace(MARKS_RE, '').length >= 2) ? parts : [w];
}

/** Letter similarity of a printed word and the Mushaf word at `index`, by letters or by skeleton. */
function wordSimR(printed, index) {
  const w = load().words[index];
  if (!w) return 0;
  const key = matchKey(printed);
  if (!key || !w.key) return 0;
  return 1 - pairCost({ key, rkey: rasmKey(key) }, w, true);
}

/** Rarity-weighted count of printed words that are (by letters or skeleton) words of the passage. */
function evidenceR(text, hit) {
  const { words, index, rindex } = load();
  const region = words.slice(hit.start, hit.end);
  const keys = new Set(region.map((w) => w.key));
  const rkeys = new Set(region.map((w) => w.rkey));
  let sum = 0;
  let n = 0;
  // two-letter keys ("من", "ما", and "ءامنا" without its alefs) prove nothing
  for (const key of text.split(/\s+/).map(matchKey).filter((k) => k.length >= 3)) {
    const rk = rasmKey(key);
    if (keys.has(key)) { n++; sum += Math.log(words.length / (index.get(key)?.length || 1)); } else if (rkeys.has(rk)) { n++; sum += 0.7 * Math.log(words.length / (rindex.get(rk)?.length || 1)); }
  }
  return { sum, n };
}

function markAiVerses(par, context) {
  const text = par.runs.map((r) => r.text).join('');
  const toks = [...text.matchAll(/[\p{L}\p{M}ـ]+/gu)].filter((m) => matchKey(m[0])).map((m) => ({ w: m[0], parts: splitMerged(m[0]), start: m.index, end: m.index + m[0].length }));
  if (!toks.length) return [];
  const taken = ornateRanges(text);
  const isFree = (t) => !taken.some(([p, q]) => t.start < q && t.end > p);
  const gap = (i) => text.slice(i < 0 ? 0 : toks[i].end, i + 1 < toks.length ? toks[i + 1].start : text.length); // after token i
  const join = (a, b) => toks.slice(a, b).flatMap((t) => t.parts).join(' ');
  const lastRef = (context || []).at(-1);
  const opts = (windows) => ({ rasm: true, context: windows, near: pieces.length ? pieces.at(-1).hit.end : refEnd(lastRef) });

  // stretches of words between delimiters
  const chunks = [];
  let a = 0;
  for (let i = 0; i < toks.length; i++) {
    if (isStrayLetter(toks[i].w)) { if (i > a && toks.slice(a, i).every(isFree)) chunks.push([a, i]); a = i + 1; continue; } // a misread bracket
    const end = i + 1 === toks.length || CHUNK_BREAK.test(gap(i)) || !isFree(toks[i]) || !isFree(toks[i + 1]);
    if (end) { if (toks.slice(a, i + 1).every(isFree)) chunks.push([a, i + 1]); a = i + 1; }
  }
  const citeAfter = (k) => {
    let at = toks[k - 1].end;
    if (k < toks.length && isJunkWord(toks[k].w) && SOFT_BREAK.test(gap(k - 1))) at = toks[k].end;
    return looseCitation(text, at + /^[\s)）»﴾*؟\]0-9٠-٩\p{M}ء]*/u.exec(text.slice(at))[0].length);
  };
  const opened = (k) => OPENS.test(gap(k - 1));
  // "»" closes a hadith when a "«" was opened before it
  const hadithClose = (k) => /^[\s\p{M}]*»/u.test(gap(k - 1)) && text.lastIndexOf('«', toks[k - 1].start) > text.lastIndexOf('»', toks[k - 1].start);
  // a quotation still open where the paragraph stops (the page ends) counts as closed
  const closed = (k) => (CLOSES.test(gap(k - 1)) && !hadithClose(k)) || (k < toks.length ? isJunkWord(toks[k].w) : !/[.،,؛:!؟»]/.test(gap(k - 1)));

  const pieces = [];
  const tryChunk = ([k0, k1], windows, shortOnly) => {
    const cite = citeAfter(k1);
    const enclosed = opened(k0) && (closed(k1) || !!cite);
    const half = opened(k0) || closed(k1) || !!cite;
    const hint = cite ? { surah: cite.surah, from: 1, to: 999 } : null;
    let x = k0;
    let y = k1;
    // no bracket on either side: the book's own words, unless a long stretch is the Mushaf almost word for word (a reader that
    // prints no brackets at all); most prose is rejected here by its first, whole-chunk match
    if (!half) {
      if (shortOnly || join(x, y).split(' ').length < 5) return false;
      const first = findPassage(join(x, y), null, opts(windows));
      if (!first || evidenceR(join(x, y), first).sum < MIN_EVIDENCE) return false;
    }
    if (!shortOnly && join(x, y).split(' ').length >= 2) {
      let hit = findPassage(join(x, y), hint, opts(windows));
      // drop words at either end that do not look like the Mushaf words they would stand for (prose before a verse, junk after it):
      // the first (last) word, and the first (last) three words together
      const edge = (from, dir, at) => {
        const ws = [];
        for (let k = from; k >= x && k < y && ws.length < 3; k += dir) ws.push(...(dir > 0 ? toks[k].parts : [...toks[k].parts].reverse()));
        const sims = ws.slice(0, 3).map((w, i) => wordSimR(w, at + dir * i));
        return sims[0] >= 0.5 && sims.reduce((s, v) => s + v, 0) / sims.length >= 0.5;
      };
      while (hit && y - x > 2 && !edge(x, 1, hit.start)) hit = findPassage(join(++x, y), hint, opts(windows));
      while (hit && y - x > 2 && !edge(y - 1, -1, hit.end - 1)) hit = findPassage(join(x, --y), hint, opts(windows));
      if (hit) {
        const n = join(x, y).split(' ').length;
        const ev = evidenceR(join(x, y), hit);
        // the reader prints a verse's brackets in some form almost always: words with no bracket on either side are the book's own
        // (an explanation often repeats the verse it explains); with a bracket on one side only, the verse must be one of those
        // the page is explaining, or have its citation right after it
        // and the verse starts (ends) right at the bracket that marks it: trimmed prose words there would mean the match lies elsewhere
        const atOpen = !opened(k0) || x - k0 <= (enclosed ? 1 : 0);
        const atClose = !(closed(k1) || cite) || k1 - y <= (enclosed ? 1 : 0);
        const strong = hit.sim >= 0.9 && ev.n >= MIN_EXACT_WORDS && ev.sum >= MIN_EVIDENCE;
        const ok = enclosed ? hit.sim >= 0.6 && (n >= 3 || hit.sim >= 0.75) && atOpen && atClose
          : half ? n >= 3 && atOpen && atClose
            && ((hit.local && ((hit.sim >= 0.9 && n >= 4) || (hit.sim >= 0.72 && ev.n >= 2 && ev.sum >= 10))) || (cite && hit.sim >= 0.85))
            : strong && (n >= 8 || (hit.local && n >= 5));
        if (ok) { pieces.push({ x, y, hit }); return true; }
      }
    }
    // a short quotation (one or two words) between brackets: only next to the verses the text is explaining
    if (enclosed && k1 - k0 <= 2 && windows.length) {
      for (const [p, q] of k1 - k0 === 2 ? [[k0, k1], [k0, k0 + 1]] : [[k0, k1]]) {
        const hit = findNearby(join(p, q), windows, opts(windows).near);
        const letters = matchKey(join(p, q)).length;
        if (hit && (letters >= 3 || (letters === 2 && hit.exact)) && hit.sim >= (q - p === 1 ? 0.8 : 0.75)) { pieces.push({ x: p, y: q, hit }); return true; }
      }
    }
    return false;
  };
  const windows0 = contextWindows(context);
  const rest = chunks.filter((c) => !tryChunk(c, windows0, false));
  // the verses found on this paragraph also show where its short quotations come from
  const windows1 = contextWindows([...(context || []), ...pieces.map((p) => passageRef(p.hit.start, p.hit.end))]);
  if (windows1.length) for (const c of rest) tryChunk(c, windows1, true);
  pieces.sort((p, q) => p.x - q.x);

  // grow each piece while the neighbouring printed words continue the Mushaf; across a bracket that seemed to close the verse
  // two words must continue it, and one unreadable word may be passed over when the next one fits well
  const fits = (k, at, dir) => { // Mushaf words token k stands for when it continues the verse at `at` (dir +1 right, -1 left)
    const parts = dir > 0 ? toks[k].parts : [...toks[k].parts].reverse();
    return parts.every((w, i) => wordSimR(w, at + dir * i) >= 0.6) ? parts.length : 0;
  };
  const owned = (k) => pieces.some((q) => k >= q.x && k < q.y);
  for (const p of pieces) {
    for (;;) {
      const j = p.y;
      if (j >= toks.length || !SOFT_BREAK.test(gap(j - 1)) || !isFree(toks[j]) || owned(j)) break;
      const hard = HARD_CLOSE.test(gap(j - 1)) || HARD_OPEN.test(gap(j - 1));
      const n1 = fits(j, p.hit.end, 1);
      const n2 = n1 && j + 1 < toks.length && SOFT_BREAK.test(gap(j)) && !owned(j + 1) ? fits(j + 1, p.hit.end + n1, 1) : 0;
      if (n1 && (!hard || n2)) { p.y++; p.hit = { ...p.hit, end: p.hit.end + n1 }; continue; }
      // one word the reader garbled (or added), when the next one is clearly the next Mushaf word
      const s = j + 1 < toks.length && SOFT_BREAK.test(gap(j)) && !owned(j + 1) && wordSimR(toks[j + 1].parts[0], p.hit.end) >= 0.75 ? 0
        : j + 1 < toks.length && SOFT_BREAK.test(gap(j)) && !owned(j + 1) && wordSimR(toks[j + 1].parts[0], p.hit.end + 1) >= 0.75 ? 1 : -1;
      if (s >= 0 && !hard) { p.y += 2; p.hit = { ...p.hit, end: p.hit.end + s + toks[j + 1].parts.length }; continue; }
      break;
    }
    for (;;) {
      const j = p.x - 1;
      if (j < 0 || !SOFT_BREAK.test(gap(j)) || !isFree(toks[j]) || owned(j) || p.hit.start === 0) break;
      const hard = HARD_CLOSE.test(gap(j)) || HARD_OPEN.test(gap(j));
      const n1 = fits(j, p.hit.start - 1, -1);
      const n2 = n1 && j > 0 && SOFT_BREAK.test(gap(j - 1)) && !owned(j - 1) ? fits(j - 1, p.hit.start - 1 - n1, -1) : 0;
      if (n1 && (!hard || n2)) { p.x--; p.hit = { ...p.hit, start: p.hit.start - n1 }; continue; }
      const s = j > 0 && SOFT_BREAK.test(gap(j - 1)) && !owned(j - 1) && wordSimR(toks[j - 1].parts.at(-1), p.hit.start - 1) >= 0.75 ? 0
        : j > 0 && SOFT_BREAK.test(gap(j - 1)) && !owned(j - 1) && wordSimR(toks[j - 1].parts.at(-1), p.hit.start - 2) >= 0.75 ? 1 : -1;
      // passing over a word to the left must end at an opening bracket: "(فَتَقَبَّلْ طِبْرَمَ) مِنِّي"
      if (s >= 0 && j > 0 && opened(j - 1)) { p.x -= 2; p.hit = { ...p.hit, start: p.hit.start - s - toks[j - 1].parts.length }; continue; }
      break;
    }
  }
  // pieces of one verse split by a separator, a misread bracket or one garbled word are joined
  const merged = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && p.x < last.y) continue; // swallowed by growing
    const between = last ? text.slice(toks[last.y - 1].end, toks[p.x].start) : '';
    const step = last ? p.hit.start - last.hit.end : 0;
    const soft = last && p.x - last.y <= 1 && SOFT_BREAK.test(between.replace(/[\p{L}\p{M}ـ]+/gu, ' '));
    // "﴿إِنَّ مَثَلَ عِيسَىٰ عِندَ ٱللَّهِ - فاسْتَمِعْ - كَمَثَلِ ءَادَمَ﴾": the author's words inside one quotation
    const aside = last && ASIDE.test(between) && step >= -1 && step <= 1;
    if (last && (aside || (soft && step >= (p.x > last.y ? 0 : -1) && step <= (p.x > last.y ? 1 : 3)))) {
      last.y = p.y;
      last.hit = { ...last.hit, end: Math.max(last.hit.end, p.hit.end) };
    } else merged.push({ ...p });
  }

  // the delimiters and junk words around each verse are its brackets
  const jobs = [];
  for (const p of merged) {
    let s = toks[p.x].start;
    let e = toks[p.y - 1].end;
    const before = text.slice(p.x ? toks[p.x - 1].end : 0, s);
    const open = /(?:[(（﴿*]|(?:^|\s)؟)[\s()（）﴿*؟]*$/.exec(before);
    if (open) s -= open[0].trimStart().length;
    const junk = p.y < toks.length && SOFT_BREAK.test(gap(p.y - 1))
      && (isStrayLetter(toks[p.y].w) || (isJunkWord(toks[p.y].w) && /^[\s)）»﴾*؟\]\p{M}ء]*(?:[،,.:؛[]|$)/u.test(text.slice(toks[p.y].end))));
    if (junk) e = toks[p.y].end;
    const close = /^(?:[\s)）»﴾*؟\p{M}ء]*[)）»﴾*]|\s+؟(?=\s|$)|\s*\](?=\s*\[))(?:[\p{M}ء]+(?=[\s،,.:؛]|$))?/u.exec(text.slice(e));
    if (close) e += close[0].length;
    // "ٱلۡأُمِّيِّـۧنَ)ِ", "عَلَيْكُمْ ِ َءِ،", "اللَّهَ)١ [آل عمران": marks and digits the reader made of the bracket
    const tail = /^(?:\s*[\p{M}ء]+)+(?=\s*[،,.:؛]|\s*$)|^[\p{M}ء]+(?=\s)|^[0-9٠-٩]{1,2}(?=\s*\[)/u.exec(text.slice(e));
    if (tail) e += tail[0].length;
    jobs.push({ s, e, inner: text.slice(toks[p.x].start, toks[p.y - 1].end) });
  }
  for (const j of jobs.reverse()) replaceRange(par.runs, j.s, j.e, ORNATE_OPEN + j.inner + ORNATE_CLOSE);
  return merged.map((p) => passageRef(p.hit.start, p.hit.end));
}

/** The Mushaf text of [start, end); with `separators`, "*" between verses as the book prints it. */
function canonicalWithSeparators(start, end, separators) {
  const { words } = load();
  const out = [];
  for (let i = start; i < end; i++) {
    if (separators && i > start && words[i].a !== words[i - 1].a) out.push('*');
    out.push(words[i].w);
  }
  return out.join(' ');
}

/**
 * Citation numbers of an AI-read page, once the verse before them is known for certain. The reader misreads the small digits
 * (٢١-٢٦ → ١١-١٢, ٣٢ → ٢٣, ٣١ → "امْ"); a printed number that fits the verse is kept. A range ends at the last verse quoted and starts
 * at the first verse quoted since the previous citation.
 */
function citationNumbers(cite, ref, firstSince) {
  const fits = cite.nums.length && cite.nums[0] <= ref.from && (cite.nums[1] ?? cite.nums[0]) >= ref.to && (cite.nums[1] ?? cite.nums[0]) - cite.nums[0] < 40;
  if (fits && (!cite.range || cite.nums.length === 2)) return null;
  const to = ref.to;
  if (cite.range) {
    const from = Math.min(ref.from, firstSince ?? ref.from);
    return from < to ? `${toIndic(from)}-${toIndic(to)}` : toIndic(to);
  }
  if (cite.nums.length === 1 && cite.nums[0] >= ref.from && cite.nums[0] <= ref.to) return null;
  // no digit left at all: the verses quoted; a wrong single number: the verse the quotation ends with, as the book cites
  if (!cite.nums.length) return ref.from === ref.to ? toIndic(to) : `${toIndic(ref.from)}-${toIndic(to)}`;
  return toIndic(to);
}

export function guardParagraph(par, { mode = 'correct', minSim = 0.78, context = [] } = {}) {
  const findings = [];
  const ai = par.ai && mode !== 'off';
  let windows = null;
  if (ai) {
    const found = markAiVerses(par, context);
    windows = contextWindows([...(context || []), ...found]);
  } else if (par.ocr && mode !== 'off') bracketPlainQuranSpans(par);
  const text = par.runs.map((r) => r.text).join('');
  const spans = [];
  let m;
  BRACKETED.lastIndex = 0;
  // the author's words inside a quotation ("- فَاسْتَمِعْ -", "يا مُحَمَّدُ" said to the reader) stay as printed, set off by dashes;
  // the verse parts around them are checked on their own
  const asidesOf = (inner) => {
    const out = [...inner.matchAll(ASIDE_IN)].map((x) => [x.index, x.index + x[0].length, true]);
    const opts = { rasm: true, context: windows };
    const split = (s) => s.split(/\s+/).flatMap(splitMerged).join(' ');
    for (const v of inner.matchAll(VOCATIVE)) {
      const a = v.index - (/\s*$/.exec(inner.slice(0, v.index))[0].length);
      const b = v.index + v[0].length + /^\s*/.exec(inner.slice(v.index + v[0].length))[0].length;
      if (a <= 0 || b >= inner.length || out.some(([p, q]) => a < q && b > p)) continue;
      const withIt = findPassage(split(inner), null, opts);
      const without = findPassage(split(`${inner.slice(0, a)} ${inner.slice(b)}`), null, opts);
      if (without && without.sim >= 0.85 && (!withIt || without.sim >= withIt.sim + 0.05)) out.push([a, b, false]);
    }
    return out.sort((x, y) => x[0] - y[0]);
  };
  while ((m = BRACKETED.exec(text))) {
    const start = m.index + 1;
    let from = start;
    for (const [a, b, dashed] of ai ? asidesOf(m[1]) : []) {
      spans.push({ start: from, end: start + a, bracketEnd: start + a, part: true });
      spans.push({ start: start + a, end: start + b, aside: true, dashed });
      from = start + b;
    }
    spans.push({ start: from, end: start + m[1].length, bracketEnd: m.index + m[0].length });
  }

  // whole-paragraph Quran text without brackets (e.g. Mushaf-style pages)
  if (!spans.length && text.replace(/\s+/g, ' ').trim().split(' ').length >= 4) {
    const hit = findPassage(text);
    if (hit && hit.sim >= 0.9 && hit.end - hit.start >= 4) spans.push({ start: 0, end: text.length, bracketEnd: text.length, plain: true });
  }
  // first every quotation is identified (in reading order: a citation range covers the verses quoted since the previous citation) ...
  const items = [];
  let firstSince = null;
  for (const sp of spans) {
    const inner = text.slice(sp.start, sp.end);
    if (sp.aside) { items.push({ sp, inner }); continue; }
    const cite = sp.plain || sp.part ? null : parseCitation(text.slice(sp.bracketEnd, sp.bracketEnd + 60));
    const loose = ai && !sp.plain && !sp.part ? looseCitation(text, sp.bracketEnd) : null;
    // the digits an AI reader prints are not trusted to anchor the search, only the surah name
    const hint = ai ? (loose ? { surah: loose.surah, from: 1, to: 999 } : null) : cite && cite.surah ? { surah: cite.surah, from: cite.from, to: cite.to } : null;
    const near = items.findLast((x) => x.hit)?.hit.end ?? refEnd((context || []).at(-1));
    const words = ai ? inner.split(/\s+/).flatMap(splitMerged).join(' ') : inner;
    const hit = findPassage(words, hint, ai ? { rasm: true, context: windows, near } : undefined) || (ai ? findNearby(words, windows, near) : null);
    const item = { sp, inner, cite, loose, hit };
    if (hit) {
      const ref = passageRef(hit.start, hit.end);
      item.ref = ref;
      if (firstSince === null || ref.surah !== items.findLast((x) => x.ref)?.ref.surah) firstSince = ref.from;
      else firstSince = Math.min(firstSince, ref.from);
      item.firstSince = firstSince;
    }
    if (loose || cite) firstSince = null;
    items.push(item);
  }
  // ... then repaired from the end of the paragraph backwards, so the offsets before each edit stay valid
  for (const { sp, inner, cite, loose, hit, ref, firstSince: since } of items.reverse()) {
    if (sp.aside) {
      if (!sp.dashed && mode === 'correct') replaceRange(par.runs, sp.start, sp.end, ` - ${inner.trim()} - `);
      continue;
    }
    // A quotation anchored by its citation may be badly damaged yet still safe to repair (small search window).
    // a short quotation is only rewritten when it is close to the Mushaf words: two garbled words fit too many places
    const short = (hit ? hit.end - hit.start : 0) <= 2;
    const floor = hit?.anchored && !ai ? 0.5 : ai ? (short ? 0.75 : hit?.local || hit?.anchored ? 0.6 : 0.7) : minSim;
    if (!hit || hit.sim < floor) {
      findings.push({ status: 'unmatched', text: inner.trim().slice(0, 160), reason: hit ? `best match ${(hit.sim * 100).toFixed(0)}%` : 'no match', ...(cite ? { cited: cite.cited } : {}) });
      continue;
    }
    const canon = canonicalWithSeparators(hit.start, hit.end, ai && /\*/.test(inner));
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
    // the citation after the verse: a known verse settles its numbers (edited before the verse, which comes earlier in the text)
    const sure = hit.exact || hit.sim >= 0.8;
    const unambiguous = hit.local || hit.anchored || (hit.runnerUp || 0) < hit.sim - 0.1;
    if (ai && loose && mode === 'correct') {
      const nums = loose.surah === ref.surah && sure && unambiguous ? citationNumbers(loose, ref, since) : null;
      if (nums) {
        const fixed = `[${ref.name}: ${nums}]`;
        replaceRange(par.runs, loose.start, loose.end, fixed);
        finding.citationFixed = `${loose.raw.trim()} → ${fixed}`;
      } else if (loose.surah !== ref.surah || (!sure && loose.nums.length && !(loose.nums[0] <= ref.to && (loose.nums[1] ?? loose.nums[0]) >= ref.from))) {
        finding.citationWarning = `Citation "${loose.raw.trim()}" does not match the verse found (${ref.label})`;
      }
    } else if (!cite && !sp.plain && mode === 'correct' && par.ai && (hit.exact || hit.sim >= 0.9)) fixMissingCitation(par, text, sp.bracketEnd, ref);
    if (changed && mode === 'correct') {
      const lead = inner.length - inner.trimStart().length;
      const trail = inner.length - inner.trimEnd().length;
      const plainSource = marksRatio(innerTrim) < 0.1;
      const written = plainSource ? plainForm(canon) : canon;
      replaceRange(par.runs, sp.start + lead, sp.end - trail, written);
      finding.fixedTo = written.slice(0, 160);
    } else if (changed) finding.status = 'needs-review';
    if (!ai && cite && !citationMatches(cite, ref)) {
      finding.citationWarning = `Citation "${cite.cited}" does not match the verse found (${ref.label})`;
    }
    findings.push(finding);
  }
  if (ai) styleVerses(par);
  const leftovers = par.runs.some((r) => r.text.includes(UNMAPPED));
  const refs = items.filter((x) => x.ref && x.hit.sim >= 0.7).map((x) => x.ref);
  return { findings: findings.reverse(), hasUnmapped: leftovers, refs };
}

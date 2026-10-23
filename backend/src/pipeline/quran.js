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

/**
 * Check one paragraph. Mutates paragraph.runs when a repair is made.
 * @returns {Array} findings
 */
export function guardParagraph(par, { mode = 'correct', minSim = 0.78 } = {}) {
  const findings = [];
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
    const canon = canonicalText(hit.start, hit.end);
    const innerTrim = inner.trim();
    let status = 'verified';
    let changed = false;
    if (!hit.exact) {
      status = 'corrected';
      changed = true;
    } else if (marksRatio(innerTrim) >= 0.3 && canonicalForm(innerTrim) !== canonicalForm(canon)) {
      status = 'diacritics-fixed';
      changed = true;
    }
    const finding = { status, ref: ref.label, similarity: Number(hit.sim.toFixed(3)), text: innerTrim.slice(0, 160) };
    if (hit.anchored && hit.sim < minSim) finding.lowConfidence = 'repaired using the citation only; please review';
    if (changed && mode === 'correct') {
      const lead = inner.length - inner.trimStart().length;
      const trail = inner.length - inner.trimEnd().length;
      replaceRange(par.runs, sp.start + lead, sp.end - trail, canon);
      finding.fixedTo = canon.slice(0, 160);
    } else if (changed) finding.status = 'needs-review';
    if (cite && !citationMatches(cite, ref)) {
      finding.citationWarning = `Citation "${cite.cited}" does not match the verse found (${ref.label})`;
    }
    findings.push(finding);
  }
  const leftovers = par.runs.some((r) => r.text.includes(UNMAPPED));
  return { findings: findings.reverse(), hasUnmapped: leftovers };
}

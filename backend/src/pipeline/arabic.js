// Arabic text utilities: script detection, shaping-form normalisation,
// reversed-text detection and garbled-text detection.

export const ARABIC_LETTER = /[ؠ-يٮ-ۓەۮ-ۯۺ-ۿݐ-ݿࢠ-ࣉ\uFB50-\uFDFF\uFE70-\uFEFF]/;
export const ARABIC_ANY = /[\u0600-ۿݐ-ݿࢠ-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
export const HEBREW = /[֐-׿יִ-ﭏ]/;
export const MARK_CHAR = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u08D3-\u08FF]/;
const MARKS_ONLY = /^[\s\u200B-\u200F\u061C]*[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u08D3-\u08FF]+[\s]*$/;
const LATIN = /[A-Za-zÀ-ɏ]/;
const DIGIT = /[0-9٠-٩۰-۹]/;

export const isMarksOnly = (s) => MARKS_ONLY.test(s);
export const isRtlChar = (c) => ARABIC_ANY.test(c) || HEBREW.test(c);

/** 'rtl' | 'ltr' | 'num' | 'neutral' for a single string (strongest evidence wins). */
export function strongKind(s) {
  let rtl = 0;
  let ltr = 0;
  let num = 0;
  for (const c of s) {
    if (ARABIC_LETTER.test(c) || HEBREW.test(c)) rtl++;
    else if (LATIN.test(c)) ltr++;
    else if (DIGIT.test(c)) num++;
  }
  if (rtl && rtl >= ltr) return 'rtl';
  if (ltr) return 'ltr';
  if (num) return 'num';
  return 'neutral';
}

// presentation forms are turned back into letters; the ﷺ ligature (U+FDFA) stays as the book prints it
const SHAPED = /[ﭐ-﷏ﷰ-ﷹﷻ-﷿ﹰ-﻿ﬀ-ﬆ]/g;

/**
 * Convert Arabic presentation forms (\uFEE2 \uFEE0 \uFECC \uFEDF ا) and Latin ligatures back to the real
 * letters, and tidy placeholder spaces that PDF generators put before floating marks.
 */
export function normalizeShaping(s) {
  if (!s) return s;
  let out = s.replace(SHAPED, (c) => c.normalize('NFKC'));
  out = out.replace(/ (?=[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED])/g, '');
  out = out.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C]/g, '');
  // glyphs the PDF could not map to Unicode: keep a visible marker instead of dropping them
  out = out.replace(/[\u0000\uFFFF]/g, UNMAPPED);
  return out;
}

export const UNMAPPED = '\uFFFD';

const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«', '‹': '›', '›': '‹' };
/** PDFs store the *displayed* (mirrored) bracket glyph; restore the logical character. */
export function mirrorBrackets(s) {
  let out = '';
  for (const c of s) out += MIRROR[c] ?? c;
  return out;
}

/** Split a string into grapheme-ish clusters: base char + following Arabic marks. */
export function clusters(s) {
  const out = [];
  for (const c of s) {
    if (MARK_CHAR.test(c) && out.length) out[out.length - 1] += c;
    else out.push(c);
  }
  return out;
}

/** Reverse a string cluster-wise so diacritics stay attached to their letter. */
export function reverseClusters(s) {
  return clusters(s).reverse().join('');
}

export function stripMarks(s) {
  return s.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06EDـ\u08D3-\u08FF]/g, '');
}

// ---- reversed-text detection -------------------------------------------------
const COMMON = [
  'في', 'من', 'على', 'إلى', 'الى', 'أن', 'ان', 'ما', 'هذا', 'هذه', 'التي', 'الذي', 'الله', 'عن', 'كان', 'لا',
  'قال', 'بن', 'مع', 'ذلك', 'كل', 'بعد', 'وقد', 'أو', 'ثم', 'عليه', 'الذين', 'أبي', 'رسول', 'والله', 'كما',
  'قد', 'لم', 'إن', 'إذا', 'حتى', 'أي', 'بين', 'عند', 'فيه', 'وهو', 'وما', 'يكون', 'ولا', 'له', 'به', 'لها',
  'الحمد', 'العلم', 'الدين', 'الناس', 'الأمة', 'والسلام', 'والصلاة', 'محمد', 'العالمين', 'الرحمن', 'الرحيم',
];
const FWD = new Set(COMMON.map(stripMarks));
const REV = new Set(COMMON.filter((w) => w.length >= 2).map((w) => [...stripMarks(w)].reverse().join('')));
// Words whose reversal equals another valid word would bias the test.
for (const w of [...REV]) if (FWD.has(w)) REV.delete(w);

export function arabicTokens(text) {
  return stripMarks(text)
    .split(/[^ؠ-يٮ-ۓەۺ-ۿݐ-ݿ]+/)
    .filter((t) => t.length > 0);
}

/** Evidence that Arabic text has been extracted letter-reversed. */
export function reversalEvidence(text) {
  const toks = arabicTokens(text);
  let fwd = 0;
  let rev = 0;
  let alStart = 0;
  let alEnd = 0;
  for (const t of toks) {
    if (FWD.has(t)) fwd++;
    if (REV.has(t)) rev++;
    if (t.length >= 4) {
      if (t.startsWith('ال')) alStart++;
      if (t.endsWith('لا') && !t.startsWith('ال')) alEnd++;
    }
  }
  // Fold the "ال" prefix statistic into the vote (strong signal for Arabic prose).
  const fwdScore = fwd + alStart;
  const revScore = rev + alEnd;
  return { words: toks.length, fwd: fwdScore, rev: revScore, reversed: revScore >= 4 && revScore > fwdScore * 2.5 };
}

// ---- garbled-text detection --------------------------------------------------
// Approximate relative frequency of Arabic letters in running text.
const FREQ = {
  ا: 13.5, ل: 12.2, ي: 8.9, م: 6.5, و: 6.3, ن: 5.6, ه: 5.2, ر: 4.8, ت: 4.6, ب: 4.0, ع: 3.6, ك: 3.2, ف: 2.9,
  د: 2.8, ق: 2.6, س: 2.5, ح: 2.2, ج: 1.5, ش: 1.3, ص: 1.3, ط: 1.1, خ: 1.0, ز: 0.9, ض: 0.9, ث: 0.8, ذ: 0.8,
  غ: 0.7, ظ: 0.4,
};
const FOLD = { أ: 'ا', إ: 'ا', آ: 'ا', ٱ: 'ا', ى: 'ي', ة: 'ه', ؤ: 'و', ئ: 'ي', ء: '', ـ: '' };

/** Cosine similarity of the text's Arabic letter distribution vs. typical Arabic (0..1). */
export function arabicLetterProfileScore(text) {
  const counts = {};
  let total = 0;
  for (const ch of stripMarks(text)) {
    const c = FOLD[ch] ?? ch;
    if (FREQ[c]) {
      counts[c] = (counts[c] || 0) + 1;
      total++;
    }
  }
  if (total < 150) return null; // too small a sample to judge
  let dot = 0;
  let a = 0;
  let b = 0;
  for (const k of Object.keys(FREQ)) {
    const x = (counts[k] || 0) / total;
    const y = FREQ[k];
    dot += x * y;
    a += x * x;
    b += y * y;
  }
  return dot / (Math.sqrt(a) * Math.sqrt(b));
}

export function countArabicLetters(text) {
  let n = 0;
  for (const c of text) if (ARABIC_LETTER.test(c)) n++;
  return n;
}

/**
 * Judge whether extracted text looks like real text.
 * Returns { ok, score (0..1), issues[] }.
 */
export function textQuality(text) {
  const issues = [];
  const chars = [...text.replace(/\s+/g, '')];
  if (chars.length === 0) return { ok: false, score: 0, issues: ['empty'] };

  let bad = 0;
  for (const c of chars) {
    const cp = c.codePointAt(0);
    if (cp === 0xfffd || (cp >= 0xe000 && cp <= 0xf8ff) || (cp < 0x20) || (cp >= 0x80 && cp < 0xa0)) bad++;
  }
  const badRatio = bad / chars.length;
  let score = 1 - Math.min(1, badRatio * 4);
  if (badRatio > 0.05) issues.push(`unmapped-glyphs:${(badRatio * 100).toFixed(0)}%`);

  const arabicCount = countArabicLetters(text);
  if (arabicCount >= 150 && arabicCount / chars.length > 0.3) {
    const prof = arabicLetterProfileScore(text);
    if (prof !== null) {
      if (prof < (arabicCount < 500 ? 0.85 : 0.9)) {
        issues.push(`arabic-letter-profile:${prof.toFixed(2)}`);
        score = Math.min(score, prof - 0.1);
      }
    }
  } else if (chars.length >= 60) {
    // Latin-ish text: mostly letters/digits/punctuation
    const sane = chars.filter((c) => /[\p{L}\p{N}\p{P}\p{S}]/u.test(c)).length / chars.length;
    if (sane < 0.9) {
      issues.push('non-text-symbols');
      score = Math.min(score, sane);
    }
  }
  return { ok: score >= 0.85 && badRatio < 0.05, score: Math.max(0, Math.min(1, score)), issues };
}

export function dominantDirection(text) {
  let rtl = 0;
  let ltr = 0;
  for (const c of text) {
    if (ARABIC_LETTER.test(c) || HEBREW.test(c)) rtl++;
    else if (LATIN.test(c)) ltr++;
  }
  if (!rtl && !ltr) return null;
  return rtl >= ltr ? 'rtl' : 'ltr';
}

// Arabic-Indic digit helpers (used by Quran reference parsing)
export function toWesternDigits(s) {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
}

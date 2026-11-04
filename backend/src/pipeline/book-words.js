// A word the line reader was unsure of, set by the words of the book itself. The reader misreads a letter now and then in a word it
// cannot make out (a ت set over a م, "خاتمة" read "خاقة", its other guesses "خافة" and "خاتة"), and the same word is often printed
// elsewhere in the book and read there without doubt ("الخاتمة"). A doubtful word that the book never has is replaced by the book's
// word that its reading or one of the reader's other guesses names, or that a guess misses by one letter, when there is just one such
// word (or just one that ends as the reading does).
import { stripMarks } from './arabic.js';
import { isQuranWord } from './quran.js';

const FOLD = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ی': 'ي', 'ة': 'ه', 'ک': 'ك' };
/** The Arabic letters of a word, without its marks, tatweel and punctuation. */
const letters = (w) => Array.from(stripMarks(w)).filter((c) => /[ء-يٱ-ۓ]/.test(c) && c !== 'ـ').join('');
const keyOf = (plain) => Array.from(plain).map((c) => FOLD[c] ?? c).join('');
// the article and the letters joined before it: "الخاتمة" and "خاتمة" are one word
const ARTICLE = /^([وفبك]?ال|لل)/;
const splitArticle = (plain) => {
  const m = plain.match(ARTICLE);
  return m && plain.length - m[0].length >= 3 ? [m[0], plain.slice(m[0].length)] : ['', plain];
};

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const parasOf = (models) => models.flatMap((m) => (m?.blocks || []).flatMap((b) => (b.type === 'table' ? b.cells.flatMap((c) => c.paras) : b.type === 'p' ? [b] : [])));

/**
 * @param {object[]} models the page models of the book; doubtful words are runs of their own with `lowConf` and `alts`
 * @returns {number} how many words were set
 */
export function fixDoubtfulWords(models) {
  const paras = parasOf(models);
  // the book's words read without doubt: the key of their stem → the spellings it is printed in, with how often
  const book = new Map();
  for (const p of paras) {
    for (const r of p.runs || []) {
      if (r.lowConf) continue;
      for (const w of r.text.split(/\s+/)) {
        const [, stem] = splitArticle(letters(w));
        if (stem.length < 2) continue;
        const k = keyOf(stem);
        if (!book.has(k)) book.set(k, new Map());
        book.get(k).set(stem, (book.get(k).get(stem) || 0) + 1);
      }
    }
  }
  let fixed = 0;
  for (const p of paras) {
    for (const r of p.runs || []) {
      const m = r.lowConf && r.text.match(/^(\s*)(\S+)(\s*)$/); // one word
      if (!m) continue;
      const [, stem] = splitArticle(letters(m[2]));
      if (stem.length < 3 || book.has(keyOf(stem))) continue; // a word the book has
      // the book's words it can be: one the reading or a guess of the reader names (with that reading's article: "لَلَشيخِ" is
      // "للشيخ"), or one a guess misses by a letter, ending alike ("خاتة" for "خاتمة"). The reading itself is not stretched by a
      // letter: a word the book prints nowhere else is most often read right ("التوراة" is no "الوراة", "مذهبه" no "مذهب")
      const found = new Map();
      [m[2], ...(r.alts || [])].forEach((reading, i) => {
        const [pre, s] = splitArticle(letters(reading));
        const k = keyOf(s);
        if (book.has(k)) { if (!found.has(k)) found.set(k, pre); return; }
        if (!i || k.length < 3) return;
        for (const c of book.keys()) {
          if (c.length >= 4 && Math.abs(c.length - k.length) <= 1 && c.slice(-1) === k.slice(-1) && distance(c, k) === 1 && !found.has(c)) found.set(c, pre);
        }
      });
      // two words of the book: the one that ends as the reading does (an ending, ة or ى, is hardly ever misread)
      const end = keyOf(stem).slice(-1);
      const ends = [...found.keys()].filter((c) => c.endsWith(end));
      if (found.size !== 1 && ends.length !== 1) continue;
      const k = found.size === 1 ? [...found.keys()][0] : ends[0];
      const pre = found.get(k);
      const spelling = [...book.get(k)].sort((a, b) => b[1] - a[1])[0][0];
      const lead = m[2].match(/^[^\p{L}\p{M}]*/u)[0];
      const trail = m[2].match(/[^\p{L}\p{M}]*$/u)[0];
      r.alts = [m[2], ...(r.alts || []).filter((a) => a !== m[2])];
      r.text = m[1] + lead + pre + spelling + trail + m[3];
      fixed++;
    }
  }
  return fixed;
}

// Letters that differ only by their dots. The reader takes one for another where the print joins or loses dots (Ruq'ah draws the two
// dots of ق as one stroke, read ف; "حمرة" for "حمزة", "الفرآن" for "القرآن").
const DOTS = ['فق', 'بتثني', 'جحخ', 'سش', 'صض', 'طظ', 'عغ', 'رز', 'دذ'];
const dotGroup = new Map(DOTS.flatMap((g, i) => [...g].map((c) => [c, i])));
const STEM_EDGE = DOTS[1]; // ب ت ن ي at a word's start or end make other words of it (يكون / تكون, انتهت / انتهي)

/** A word of the Quran, with or without a joined و ف ب ل ك or the article: a real word, whatever the book prints. */
function realWord(plain) {
  const forms = new Set([plain]);
  if (/^[وفبلك]/.test(plain) && plain.length > 3) forms.add(plain.slice(1));
  for (const f of [...forms]) forms.add(f.startsWith('ال') ? f.slice(2) : `ال${f}`);
  return [...forms].some((f) => f.length >= 2 && isQuranWord(f));
}

/**
 * A word the reader got one dot wrong in, set by the book's own words: a word printed once in the whole book, not a word of the
 * Quran, that a single letter's dots make into a word the book prints three times or more (and into no other), is that word.
 * Only text the AI reader read is looked at, outside the Quran's verses.
 * @param {object[]} models the page models of the book
 * @returns {number} how many words were set
 */
export function fixDotSlips(models) {
  const paras = parasOf(models).filter((p) => p.ai);
  const core = (w) => w.replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu, '');
  const count = new Map();
  const spellings = new Map();
  for (const p of paras) {
    for (const r of p.runs || []) {
      if (r.verse) continue;
      for (const w of r.text.split(/\s+/)) {
        const k = keyOf(letters(w));
        if (k.length < 3) continue;
        count.set(k, (count.get(k) || 0) + 1);
        if (!spellings.has(k)) spellings.set(k, new Map());
        const sp = spellings.get(k);
        sp.set(core(w), (sp.get(core(w)) || 0) + 1);
      }
    }
  }
  const fix = new Map();
  for (const [k, n] of count) {
    if (n > 1 || realWord(k)) continue;
    const found = new Set();
    [...k].forEach((c, i) => {
      const g = dotGroup.get(c);
      if (g === undefined) return;
      for (const d of DOTS[g]) {
        if (d === c || ((i === 0 || i === k.length - 1) && STEM_EDGE.includes(c) && STEM_EDGE.includes(d))) continue;
        const y = k.slice(0, i) + d + k.slice(i + 1);
        if ((count.get(y) || 0) >= 3) found.add(y);
      }
    });
    if (found.size === 1) {
      const y = [...found][0];
      fix.set(k, [...spellings.get(y)].sort((a, b) => b[1] - a[1])[0][0]);
    }
  }
  let fixed = 0;
  if (!fix.size) return 0;
  for (const p of paras) {
    for (const r of p.runs || []) {
      if (r.verse) continue;
      r.text = r.text.split(/(\s+)/).map((w) => {
        const to = fix.get(keyOf(letters(w)));
        if (!to || /\s/.test(w)) return w;
        fixed++;
        const c = core(w);
        const at = w.indexOf(c);
        return w.slice(0, at) + to + w.slice(at + c.length);
      }).join('');
    }
  }
  return fixed;
}

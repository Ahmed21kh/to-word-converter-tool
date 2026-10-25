// The line reader does not know the ﷺ ligature. After "رسول الله" or "النبي" it writes a short junk word for it ("وَلَكِّي", "وَلَكِمْ",
// "وَلِيُّ", "وََلَّمْ", "وَلِلَّهِ", "عَليِّ", "وَاللهُ", "وَالِهِ", "وَكِيلٌ", "بِكُمْ."); that word is put back as ﷺ.
import { stripMarks } from './arabic.js';
import { replaceRange, isQuranWord } from './quran.js';

const SALLA = 'ﷺ';
const plain = (w) => stripMarks(w).replace(/ـ/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي');
// what the ligature is read as (letters only); none of these follows "رسول الله" as a word of its own
const JUNK = /^(?:ول(?:كي|كم|ي|له|ه|م|كمي)|والله|واله|وكيل|وكنه)$/;
// read as a real word: taken only where it cannot be one ("عليّ" not followed by "بن", "بكم" right before a full stop or comma)
const MAYBE = { 'علي': (after) => !/^\s+(?:ا?بن|ابن)\b/.test(after), 'بكم': (after) => /^\s*[.،,:؛]/.test(after) };
// the ligature run into the next word: "وَلِمِنْ نَجْرانَ" is "ﷺ مِنْ نَجْرانَ", "وَلَمْ يُجِبْهُما" is "ﷺ لَمْ يُجِبْهُما"
const MERGED = { 'ولمن': `${SALLA} مِنْ`, 'ولم': `${SALLA} لَمْ` };
const PROPHET = /^(?:ال|لل|وال|بال|فال)نبي$/;
const MESSENGER = /^(?:ال|لل|وال|بال|فال)رسول$/; // "بالرَّسُولِ ﷺ": counted only in a book that writes ﷺ every time
// words that really follow "رسول الله" in running text (letters only, alef folded); anything else short there is the ligature
const NEXT_WORDS = new Set(('في من الي الا علي عن ان قال فقال وقال قد لم لما لا ما ثم حين حتي بعد قبل يوم صلي هو هي هذا ذلك كان '
  + 'يقول اي او اذ اذا مع عند به له لها لهم بها بهم فيه منه عليه اليه بن ابن وهو وكان وقد ولا وما فلم فلما فقد انه كما').split(' '));

const tokensOf = (text) => [...text.matchAll(/[\p{L}\p{M}ـ]+/gu)].map((m) => ({ w: plain(m[0]), raw: m[0], start: m.index, end: m.index + m[0].length }));

/** Is token i right after a mention of the Prophet ("رسول الله", "النبي"; with `messenger`, "الرسول"), with only a space between? */
function afterMention(text, toks, i, messenger) {
  const prev = toks[i - 1].w;
  const mention = PROPHET.test(prev) || (messenger && MESSENGER.test(prev))
    || ((prev === 'الله' || prev === 'اللة') && i >= 2 && /^(?:[وفب]?ل?)رسول$/.test(toks[i - 2].w));
  // only a plain space between: "رسول الله، ولم ..." is ordinary prose
  return mention && /^\s+$/.test(text.slice(toks[i - 1].end, toks[i].start));
}

/**
 * Put ﷺ back after "رسول الله" / "النبي" where the reader wrote a junk word for it. Mutates par.runs.
 * strict: the book writes ﷺ after every mention (see writesSalla), so a short word there that is no word at all is the ligature
 * ("يَكْيِه،", "يُمْدِ", "وَ]"). Pass { counts } (word -> occurrences in the book) to know the book's own words.
 */
export function fixHonorifics(par, { strict = false, counts = null } = {}) {
  const text = par.runs.map((r) => r.text).join('');
  const toks = tokensOf(text);
  const edits = [];
  for (let i = 1; i < toks.length; i++) {
    const { w } = toks[i];
    if (w === 'ﷺ' || !afterMention(text, toks, i, strict)) continue;
    const after = text.slice(toks[i].end);
    // "عَلَى" (the preposition, with ى) is a real next word; "عَليِّ" (with ي) there is the ligature
    const maybe = MAYBE[w] && !(w === 'علي' && stripMarks(toks[i].raw).endsWith('ى')) && MAYBE[w](after);
    // a junk word right before punctuation is the whole ligature ("وََلَّمْ:"); before a word it carries that word's start
    const merged = MERGED[w] && !/^\s*[.،,:؛]/.test(after) ? MERGED[w] : null;
    if (JUNK.test(w) || merged || maybe) { edits.push({ ...toks[i], to: merged || SALLA }); continue; }
    if (!strict || NEXT_WORDS.has(w)) continue;
    // the reader also drops the ligature altogether, and then the next word is real ("النبي فسمع منه", "رسول الله وفد نصارى"):
    // a short word is taken for the ligature only when it is no word at all (not in the Quran, also without a ف/و/ب/ل in front, and
    // nowhere else in the book), or a lone "و"
    const known = (x) => x.length > 1 && (isQuranWord(x) || (/^[فوبل]/.test(x) && x.length > 2 && isQuranWord(x.slice(1))) || (counts?.get(x) || 0) >= 2);
    if (w.length === 1 || (w.length <= 4 && !known(w))) edits.push({ ...toks[i], to: SALLA });
  }
  for (const t of edits.reverse()) replaceRange(par.runs, t.start, t.end, t.to);
  return edits.length;
}

/**
 * Does the book write ﷺ after the Prophet's name? Counted on the AI-read paragraphs (after the plain repairs): at least 3 times,
 * and after at least 40% of the mentions. Then a short junk word after a mention can safely be taken for the ligature.
 */
export function writesSalla(pars) {
  let mentions = 0;
  let salla = 0;
  for (const par of pars) {
    const text = par.runs.map((r) => r.text).join('');
    const toks = tokensOf(text);
    for (let i = 1; i < toks.length; i++) {
      if (!afterMention(text, toks, i, false)) continue;
      mentions++;
      if (toks[i].raw.includes(SALLA)) salla++;
    }
  }
  return salla >= 3 && salla >= mentions * 0.4;
}

/**
 * A heading in square brackets whose opening bracket the reader lost ("سَبَبُ إِسْلامِ كُوزِ بنِ عَلْقَمةَ]") or doubled
 * ("[[إباؤُهُم المُلاعَنةَ]]"). Only short paragraphs that are nothing but the heading. Mutates par.runs.
 */
export function fixHeadingBrackets(par) {
  const text = par.runs.map((r) => r.text).join('');
  const t = text.trim();
  if (!t || t.split(/\s+/).length > 10) return false;
  const lead = text.length - text.trimStart().length;
  if (/^\[\[[^[\]]+\]\]$/.test(t)) {
    replaceRange(par.runs, lead, lead + 1, '');
    replaceRange(par.runs, lead + t.length - 2, lead + t.length - 1, '');
    return true;
  }
  if (/^[^[\]]+\]$/.test(t)) { replaceRange(par.runs, lead, lead, '['); return true; }
  if (/^\[[^[\]]+$/.test(t)) { replaceRange(par.runs, lead + t.length, lead + t.length, ']'); return true; }
  return false;
}

/**
 * In the words of one text line: the indexes of the words right after a mention of the Prophet ("رسول الله", "النبي", "الرسول"),
 * where the book prints ﷺ. Words ending in punctuation ("الله،") end the sentence there.
 */
export function sallaSlots(words) {
  const out = [];
  for (let i = 1; i < words.length; i++) {
    const prevRaw = words[i - 1];
    if (/[.،,:؛!؟)\]»]$/.test(prevRaw) || words[i].includes(SALLA)) continue;
    const prev = plain(prevRaw);
    // "﴿إِلَى ٱللَّهِ وَٱلرَّسُولِ﴾" is a verse, and "كِمِ" / "ء" after a word are what the reader makes of a closing ornate bracket
    const inVerse = MESSENGER.test(prev) && i >= 2 && /^(?:ا|ل)?لله$/.test(plain(words[i - 2]));
    if (inVerse || /^(?:ك|كم|كما|كمي|ء+)$/.test(sallaLetters(words[i]))) continue;
    const mention = PROPHET.test(prev) || MESSENGER.test(prev)
      || ((prev === 'الله' || prev === 'اللة') && i >= 2 && /^(?:[وفب]?ل?)رسول$/.test(plain(words[i - 2])));
    if (mention) out.push(i);
  }
  return out;
}

/** The letters of a word as compared between two readings (no marks, no punctuation, alef forms folded). */
export const sallaLetters = (w) => plain(String(w).replace(/[^\p{L}\p{M}ـ]/gu, ''));

/** How often each word (letters only) occurs in these paragraphs: a book's own vocabulary. */
export function wordCounts(pars) {
  const counts = new Map();
  for (const par of pars) for (const t of tokensOf(par.runs.map((r) => r.text).join(''))) counts.set(t.w, (counts.get(t.w) || 0) + 1);
  return counts;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPassage, canonicalText, passageRef, guardParagraph } from '../src/pipeline/quran.js';
import { UNMAPPED } from '../src/pipeline/arabic.js';
import { fixHonorifics } from '../src/pipeline/honorifics.js';

const quran = JSON.parse(readFileSync(new URL('../data/quran-uthmani.json', import.meta.url), 'utf8'));
const verse = (s, a) => quran.find((v) => v[0] === s && v[1] === a)[2];
const OPEN = '\uFD3F';
const CLOSE = '\uFD3E';
const par = (text) => ({ runs: [{ text, fs: 20, bold: false, italic: false }] });
const textOf = (p) => p.runs.map((r) => r.text).join('');

test('dataset is complete (6236 verses, 114 surahs)', () => {
  assert.equal(quran.length, 6236);
  assert.equal(new Set(quran.map((v) => v[0])).size, 114);
});

test('an intact verse is found and verified without changes', () => {
  const p = par(`قال تعالى: ${OPEN}${verse(112, 1)} ${verse(112, 2)}${CLOSE}`);
  const before = textOf(p);
  const { findings } = guardParagraph(p);
  assert.equal(findings[0].status, 'verified');
  assert.equal(textOf(p), before);
});

test('missing letters (unmapped glyphs) are repaired from the canonical text', () => {
  const words = verse(2, 255).split(' ');
  words[0] = `ٱ${UNMAPPED}`; // the Allah ligature could not be decoded
  words[5] = [...words[5]].reverse().join(''); // a scrambled word
  const p = par(`${OPEN}${words.join(' ')}${CLOSE} [البقرة: 255]`);
  const { findings } = guardParagraph(p);
  assert.equal(findings[0].status, 'corrected');
  assert.equal(findings[0].ref, 'البقرة: 255');
  assert.ok(textOf(p).includes(verse(2, 255)));
  assert.ok(!textOf(p).includes(UNMAPPED));
});

test('verse-only report mode does not modify the text', () => {
  const damaged = verse(112, 1).replace('ه\u064Fو\u064E', 'ه\u0652و');
  const p = par(`${OPEN}${damaged}${CLOSE}`);
  const before = textOf(p);
  const { findings } = guardParagraph(p, { mode: 'verify' });
  assert.notEqual(findings[0].status, 'verified');
  assert.equal(textOf(p), before);
});

test('a wrong citation is reported, not silently "fixed"', () => {
  const p = par(`${OPEN}${verse(112, 1)}${CLOSE} [البقرة: 3]`);
  const { findings } = guardParagraph(p);
  assert.match(findings[0].citationWarning || '', /does not match/);
});

test('repeated verses are resolved by the citation', () => {
  const refrain = verse(55, 47); // "فبأي آلاء ربكما تكذبان" appears 31 times in Ar-Rahman
  const p = par(`${OPEN}${refrain}${CLOSE} [الرحمن: 47]`);
  const { findings } = guardParagraph(p);
  assert.equal(findings[0].ref, 'الرحمن: 47');
  assert.equal(findings[0].citationWarning, undefined);
});

test('النساء and الناس are different surahs', () => {
  const p = par(`${OPEN}${verse(114, 5)}${CLOSE} [الناس: 5]`);
  const { findings } = guardParagraph(p);
  assert.equal(findings[0].citationWarning, undefined);
  assert.equal(findings[0].ref, 'الناس: 5');
});

test('passage lookup spans several verses', () => {
  const text = [1, 2, 3, 4].map((a) => verse(112, a)).join(' ');
  const hit = findPassage(text);
  assert.equal(hit.exact, true);
  assert.equal(passageRef(hit.start, hit.end).label, 'الإخلاص: 1-4');
  assert.equal(canonicalText(hit.start, hit.end), text);
});

test('ordinary prose is left alone', () => {
  const p = par('وقد اهتم علماء الأمة بتدوينه ونشره في الآفاق، فكتبوا المجلدات وجمعوا الروايات.');
  const before = textOf(p);
  const { findings } = guardParagraph(p);
  assert.equal(findings.length, 0);
  assert.equal(textOf(p), before);
});

test('a verse printed between ( ) by an AI reader is verified and re-bracketed; no stray parenthesis is left', () => {
  const run = (text) => ({ type: 'p', ocr: true, runs: [{ text }] });
  const out = (p) => p.runs.map((r) => r.text).join('');
  // garbled letters and no diacritics, but the words are those of 112:1-4
  const a = run('قال تعالى: (قل هو الله احد الله الصمد لم يلد ولم يولد ولم يكن له كفوا احد) وبعدها كلام عادي.');
  const { findings } = guardParagraph(a);
  assert.ok(findings.length >= 1 && findings[0].ref.includes('الإخلاص'));
  const text = out(a);
  assert.ok(text.includes(String.fromCharCode(0xfd3f)) && text.includes(String.fromCharCode(0xfd3e)));
  assert.ok(!text.includes('(') && !text.includes(')'), 'the parentheses became the ornate brackets');
  assert.ok(text.endsWith('وبعدها كلام عادي.'));

  // an explanation in parentheses that is not Quran stays untouched
  const b = run('وقال: (هذا شرح عادي لكلمة من الكلمات التي وردت قبل قليل) انتهى.');
  guardParagraph(b);
  assert.equal(out(b), 'وقال: (هذا شرح عادي لكلمة من الكلمات التي وردت قبل قليل) انتهى.');
});

// what the line reader made of a page of a tafsir book (Ar-Rawd al-Unuf): ﴿ ﴾ printed as ( ), "*" and junk words, dotted letters
// confused, citation digits misread
const aiPar = (text) => ({ type: 'p', ocr: true, ai: true, runs: [{ text }] });
const words = (s, a, from, to) => verse(s, a).split(' ').slice(from, to).join(' ');

test('AI text: a verse between misread brackets is repaired and its misread citation number is set from the verse found', () => {
  const p = aiPar('*(إِنَّ الَّذِينَ كَفَرُواْ بِثَائِنِتِ أَلاَّهِ لَهُمْ عَذَابٌ شَدِيدٌ وَأَلاَّهُ عَزِيزٌ ذُو اُننِقَامٍ )ء، أيْ: إنَّ الله مُنْتَقِمٌ. ( هُوَ الَّذِى يُصَوِّرُكُمْ فِي الْأَرْحَامِ كَيْفَ يَشَكَّاهُ ) [آل عمران: ١]، أيْ: قَدْ كانَ عِيسى.');
  const { findings } = guardParagraph(p, { context: [{ surah: 3, from: 3, to: 3 }] });
  const text = textOf(p);
  assert.ok(text.startsWith(`${OPEN}${words(3, 4, 6)}${CLOSE}، أيْ:`), text);
  assert.ok(text.includes(`${OPEN}${words(3, 6, 0, 7)}${CLOSE} [آل عمران: ٦]`), text);
  assert.ok(findings.some((f) => /آل عمران: ٦/.test(f.citationFixed || '')));
});

test('AI text: a range citation spans the verses quoted since the previous citation', () => {
  const p = aiPar('فقالَ: (إِنَّ الَّذِينَ يَكْفُرُونَ بِثَايَنتِ اللَّهِ وَيَقْتُلُونَ الْنَّبِيِّنَ بِغَيْرِ حَقِّ وَيَقْتُلُوتَ الَّذِيتَ يَأْمُسُرُوتَ بِالْقِسْطِ مِتَكَ النَّاسِ كِمْ، إِلِيَ قَوْلِهِ: *(قُلِ اللَّهُمَّ مَنِلِكَ الْمُكِكِ) [آل عمران: ١١-١٢]، أيْ: رَبَّ العِبادِ.');
  guardParagraph(p, { context: [{ surah: 3, from: 19, to: 20 }] });
  assert.ok(textOf(p).includes(`${OPEN}${words(3, 26, 0, 4)}${CLOSE} [آل عمران: ٢١-٢٦]`), textOf(p));
  assert.ok(textOf(p).includes(`${words(3, 21, 13, 15)}${CLOSE}، إِلِيَ قَوْلِهِ`), textOf(p));
});

test('AI text: the words the author puts inside a quotation stay as printed', () => {
  const p = aiPar('حَتّى انْتَهى إلى قَوْلِهِ: (ذَلِكَ نَتْلُوهُ عَلَيْكَ يا مُحَمَّدُ مِنَ أَلْآَينَتِ وَالذِّكْرِ الْحَكِيمِ)ِ القاطِعِ الفاصِلِ.');
  guardParagraph(p, { context: [{ surah: 3, from: 55, to: 57 }] });
  assert.ok(textOf(p).includes(`${OPEN}${words(3, 58, 0, 3)} - يا مُحَمَّدُ - ${words(3, 58, 3)}${CLOSE} القاطِعِ`), textOf(p));
  const q = aiPar('(إِنَّ مَثَلَ عِيسَى عِندَ اللَّهِ - فاسْتَمِعْ - كَمَثَلِ ءَادَمٌ خَلَقَكُمْ مِن تُرَابٍ ثُمَّ قَالَ لَهُ:كُن فَيَكُونُ * أَلْحَقُّ مِن زَبْيِكَ )، أَيْ: مَا جَاءَكَ.');
  guardParagraph(q, { context: [{ surah: 3, from: 58, to: 58 }] });
  assert.ok(textOf(q).startsWith(`${OPEN}${words(3, 59, 0, 5)} - فاسْتَمِعْ - ${words(3, 59, 5)} * ${words(3, 60, 0, 3)}${CLOSE}، أَيْ`), textOf(q));
});

test('AI text: short quotations are read next to the verses being explained; a repeated phrase takes the nearest place', () => {
  const p = aiPar('ولَهُمْ على ما قالُوا شُبْهةٌ، (أَبْتِغَآءَ الْفِتْنَةِ)، أي: اللَّبْسِ، (وَأَبْتِغَأَ تَأْوِيلِهِمْ) ذلك على ما رَكِبُوا.');
  guardParagraph(p, { context: [{ surah: 3, from: 7, to: 7 }] });
  assert.ok(textOf(p).includes(`${OPEN}${words(3, 7, 22, 24)}${CLOSE}`) && textOf(p).includes(`${OPEN}${words(3, 7, 24, 26)}${CLOSE}`), textOf(p));
  const q = aiPar('فأنْزَلَ اللهُ سبحانهُ: (إِنَّ مَثَلَ عِيسَى عِندَ اللَّهِ كَمَثَلِ ءَادَمَ)، إلى قولِه: (كُن فَيَكُونُ) [آل عمران: ٩ ه].');
  guardParagraph(q, { context: [{ surah: 3, from: 61, to: 64 }] });
  assert.ok(textOf(q).includes(`${OPEN}${words(3, 59, -2)}${CLOSE} [آل عمران: ٥٩]`), textOf(q));
});

test('AI text: the book\'s own words stay prose, even when they repeat a verse; a hadith in « » is not a verse', () => {
  const prose = [
    'أيْ: قَدْ جاءَكَ الحَقُّ مِنْ رَبِّكَ فلا تَمْتَرِيَنَّ فيهِ، وإنْ قالُوا: خُلِقَ عِيسى.',
    'وَقَدْ خَلَقَ السَّمواتِ والأرْضَ في سِتّةِ أيّامٍ، وهِيَ سِتّةُ آلافِ سَنةٍ.',
    'فَدَعاهُ فقالَ: «اخْرُجْ مَعَهُمْ، فاقْضِ بَيْنَهُمْ بِالحَقِّ فيما اخْتَلَفُوا فيهِ». قالَ عُمَرُ.',
    '[ما نَزَلَ مِن القُرْآنِ فيما أحْدَثَ اليَهُودُ والنَّصارى]',
    'أَفَلَمْ تَكُنْ لَهُمْ في ذلك عِبْرَةٌ وَبَيِّنَةٌ؟! أَنْ لَوْ كانَ إلَهًا.',
  ];
  for (const t of prose) {
    const p = aiPar(t);
    guardParagraph(p, { context: [{ surah: 3, from: 59, to: 61 }] });
    assert.equal(textOf(p), t);
  }
});

test('the ﷺ ligature the reader wrote as a junk word is put back; ordinary words after "رسول الله" stay', () => {
  const p = aiPar('فَلَمّا أتى رَسُولَ الله وَلَكِّي الحَبَرُ، ثُمَّ قالَ رَسُولُ اللهِ وَلِيُّ: «اثْتُونِي»، وقَوْلَهُمْ لِلنّبِيِّ وََلَّمْ: مَنْ أبُوهُ؟');
  assert.equal(fixHonorifics(p), 3);
  assert.equal(textOf(p), 'فَلَمّا أتى رَسُولَ الله ﷺ الحَبَرُ، ثُمَّ قالَ رَسُولُ اللهِ ﷺ: «اثْتُونِي»، وقَوْلَهُمْ لِلنّبِيِّ ﷺ: مَنْ أبُوهُ؟');
  const q = aiPar('أتى رَسُولَ الله، ولَمْ يَقُلْ شَيْئًا.');
  assert.equal(fixHonorifics(q), 0);
});

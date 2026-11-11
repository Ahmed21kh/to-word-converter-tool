// Hamzat al-wasl: a vowelled book that prints ٱ gets it back where the line reader wrote a plain alif or a hamza; a book that
// does not print it is left as it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixWasla } from '../src/pipeline/wasla.js';

/** A book of pages, each page a list of paragraphs (text, or runs), read by the AI. */
const book = (pages) => pages.map((paras) => ({
  blocks: paras.map((p) => ({ type: 'p', ai: true, runs: typeof p === 'string' ? [{ text: p }] : p })),
}));
const textOf = (models) => models.map((m) => m.blocks.map((b) => b.runs.map((r) => r.text).join('')));

test('a book that prints ٱ: articles and wasla alifs are written ٱ, a hamza only where the word is surely the article', () => {
  // as the reader wrote page 42 of "المقدمة الحضرمية": the mark over the alif taken for a hamza here and there
  const page = [
    'لَا يَصِحُّ رَفْعُ الْحَدَثِ وَلَا إِزَالَةُ الْنَّجَسِ إِلاَّ بِمَا يُسَمَّى مَاءً ، يَسْتَغْنِي أَلْمَاءُ عَنْهُ .. لَمْ تَصِحَّ أَلطَّهَارَةُ بِهِ .',
    'وَالْتَّغَيُّرُ الْتَّقْدِيرِيُّ كَالْتَّغَيُّرِ الْحِسِّيِّ . قُدِّرَ بِأَوْسَطِ أَلْصِّفَاتِ وَلاَ يَمْنَعُ اسْمَ الْمَاءِ ، وَإِذَا ادَّعَى',
  ];
  const models = book([page, page, [
    'أَلْحَقَ بِهِ الْحَقُّ ، وَهُوَ أَيْضاً كَافَّةً لِوَالِدٍ ، ايْضاً أَيْضاً',
    'فِي أَلِاسْتِنْجَاءِ بِأَسْمِ اللَّهِ أَلْفَاظٌ عَنْ أَلْعُضْوِ وَمَاءٍ',
    [{ text: 'قَالَ ' }, { text: 'ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ', verse: true }],
  ]]);
  const r = fixWasla(models);
  assert.equal(r.wasla, true);
  const [first, , last] = textOf(models);
  assert.equal(first[0], 'لَا يَصِحُّ رَفْعُ ٱلْحَدَثِ وَلَا إِزَالَةُ ٱلنَّجَسِ إِلاَّ بِمَا يُسَمَّى مَاءً ، يَسْتَغْنِي ٱلْمَاءُ عَنْهُ .. لَمْ تَصِحَّ ٱلطَّهَارَةُ بِهِ .');
  assert.equal(first[1], 'وَٱلتَّغَيُّرُ ٱلتَّقْدِيرِيُّ كَٱلتَّغَيُّرِ ٱلْحِسِّيِّ . قُدِّرَ بِأَوْسَطِ ٱلصِّفَاتِ وَلاَ يَمْنَعُ ٱسْمَ ٱلْمَاءِ ، وَإِذَا ٱدَّعَى');
  // a hamza of the word itself stays: "أَلْحَقَ" (the book has "الْحَقُّ", another word), "أَيْضاً" (read once without its hamza);
  // a root letter before an alif is no joined و or ك
  assert.equal(last[0], 'أَلْحَقَ بِهِ ٱلْحَقُّ ، وَهُوَ أَيْضاً كَافَّةً لِوَالِدٍ ، ايْضاً أَيْضاً');
  // a lam with a kasra before an alif is the article's, "ٱسْم" opens with a wasla; "أَلْفَاظٌ" is a word of its own, and
  // "أَلْعُضْوِ" is not found elsewhere in the book: both keep the hamza the reader wrote
  assert.equal(last[1], 'فِي ٱلِاسْتِنْجَاءِ بِٱسْمِ ٱللَّهِ أَلْفَاظٌ عَنْ أَلْعُضْوِ وَمَاءٍ');
  assert.equal(last[2], 'قَالَ ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ', 'a verse is the Mushaf text');
});

test('a book that does not print ٱ keeps its plain alifs; a sukun on the lam before a doubled sun letter goes in every book', () => {
  const page = ['لَا يَصِحُّ رَفْعُ الْحَدَثِ وَلَا إِزَالَةُ الْنَّجَسِ . أَلْحَمْدُ لِلَّهِ', 'وَالتَّغَيُّرُ كَالتَّغَيُّرِ الْحِسِّيِّ'];
  const models = book([page, page, page]);
  assert.equal(fixWasla(models).wasla, false);
  assert.deepEqual(textOf(models)[0], ['لَا يَصِحُّ رَفْعُ الْحَدَثِ وَلَا إِزَالَةُ النَّجَسِ . أَلْحَمْدُ لِلَّهِ', 'وَالتَّغَيُّرُ كَالتَّغَيُّرِ الْحِسِّيِّ']);
});

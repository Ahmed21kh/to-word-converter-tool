// Book-level repairs of what the line reader writes: the dagger alef, a few printed vowels, the page number under the text and
// the chapter titles the table of contents names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixDaggerAlef, dropShortVowels } from '../src/pipeline/arabic.js';
import { fixMaqsuraHamza, fixItemNumbers, fixSplitWords } from '../src/pipeline/book-words.js';
import { paragraphsToBlocks, cleanArabicLine } from '../src/pipeline/vision-ocr.js';
import { footNumberBox } from '../src/pipeline/text-lines.js';
import { settlePageNumbers, contentsEntries, fixHeadingsFromContents } from '../src/pipeline/running-head.js';

const para = (text, extra = {}) => ({ type: 'p', dir: 'rtl', fs: 14, ai: true, align: 'start', runs: [{ text, fs: 14, bold: false }], ...extra });
const heading = (text) => para(text, { align: 'center', runs: [{ text, fs: 18, bold: true }] });
const textOf = (b) => b.runs.map((r) => r.text).join('');

test('the dagger alef of هٰذا read as a tooth or a letter is written back', () => {
  for (const w of ['هنذا', 'هلذا', 'هـذا', 'هاذا']) assert.equal(fixDaggerAlef(w), 'هٰذا', w);
  assert.equal(fixDaggerAlef('ولهنذا،'), 'ولهٰذا،');
  assert.equal(fixDaggerAlef('«هلذه»'), '«هٰذه»');
  assert.equal(fixDaggerAlef('هنؤلاء'), 'هٰؤلاء');
  assert.equal(fixDaggerAlef('هَـلذَا'), 'هَٰذَا', 'its vowels kept');
  for (const w of ['هذا', 'هٰذا', 'هندسة', 'هلال', 'هتذكر']) assert.equal(fixDaggerAlef(w), w, w);
});

test('a general reader loses only its short vowels on a plain line: shadda, tanwin, dagger alef and hamza stay', () => {
  assert.equal(dropShortVowels('كُتِبَ عَلَىٰ فِعْلاً يُحَسِّنُ'), 'كتب علىٰ فعلاً يحسّن');
});

test('ىٰ read as ئ is written back when the book or the Quran knows the ى word', () => {
  const models = [{ n: 1, blocks: [para('يتهادئ بين بردي التحقيق ولله تعالىٰ الحمد'), para('شاطئ البحر وعلىٰ المبادئ'), para('حتىٰ ارتقىٰ')] }];
  assert.equal(fixMaqsuraHamza(models), 1);
  assert.equal(textOf(models[0].blocks[0]), 'يتهادىٰ بين بردي التحقيق ولله تعالىٰ الحمد');
  assert.equal(textOf(models[0].blocks[1]), 'شاطئ البحر وعلىٰ المبادئ', 'a real ئ word stays');
});

test('a numbered item read with a digit too many is set by the items around it', () => {
  const models = [
    { n: 17, blocks: [para('ا- الشيخ الإمام'), para('درس في تريم'), para('٢– الشيخ الإمام الفقيه'), para('٣٢– العلامة الجليل')] },
    { n: 18, blocks: [para('ابن ظهيرة'), para('٤ـ الشيخ'), para('٥ـ الإمام'), para('٦٥ـ القاضي')] },
    { n: 19, blocks: [para('١ـ أول'), para('١٢ـ ثان'), para('٤ـ رابع')] },
  ];
  assert.equal(fixItemNumbers(models), 3);
  assert.equal(textOf(models[0].blocks[0]), '١- الشيخ الإمام', 'the ١ of the first item read as an alif');
  assert.equal(textOf(models[0].blocks[3]), '٣– العلامة الجليل', 'between ٢ and ٤');
  assert.equal(textOf(models[1].blocks[3]), '٦ـ القاضي', 'the last item before a new list');
  assert.equal(textOf(models[2].blocks[1]), '١٢ـ ثان', 'not when the item after it does not follow');
});

test('a word split at a letter that does not join the next is one word when the book prints it so; بز in a line of names is بن', () => {
  const names = Array.from({ length: 10 }, () => 'محمد بن علي').join(' ');
  const models = [{ n: 1, blocks: [
    { type: 'p', ai: true, runs: [{ text: 'شيو', lowConf: true }, { text: ' خه' }] },
    para('وأبرز شيوخه : الشيخ'),
    para(`${names} عبد الله بْز عبد الرحمن`),
    para('دار المنهاج وهو الدار'),
  ] }];
  models[0].blocks.slice(1).forEach((b) => { b.ai = true; });
  assert.equal(fixSplitWords(models), 2);
  assert.equal(textOf(models[0].blocks[0]), 'شيوخه');
  assert.ok(textOf(models[0].blocks[2]).endsWith('عبد الله بْن عبد الرحمن'));
  assert.equal(textOf(models[0].blocks[3]), 'دار المنهاج وهو الدار', 'two words of the book stay two');
});

test('the mark of a note of the page, just after a word, is raised; another bracketed number is not', () => {
  const blocks = paragraphsToBlocks([
    { text: '', runs: [{ text: 'استمر فيها العلم ' }, { text: 'والفقه', lowConf: true }, { text: ' (١). سنة (٨٦٦) و(٢)' }] },
    { text: '(١) وكان', footnote: true, runs: [{ text: '(١) وكان' }] },
  ]);
  assert.deepEqual(blocks[0].runs.map((r) => [r.text, !!r.sup]), [['استمر فيها العلم ', false], ['والفقه', false], ['(١)', true], ['. سنة (٨٦٦) و(٢)', false]]);
});

test('a note mark the reader read as a line over a title goes back to the title, raised; ornaments are spaced as printed', () => {
  const blocks = paragraphsToBlocks([
    { text: '(١)', heading: true, runs: [{ text: '(١)' }] },
    { text: 'كتاب الفرائض', heading: true, runs: [{ text: 'كتاب الفرائض' }] },
    { text: '(١) إلى هنا', footnote: true, runs: [{ text: '(١) إلى هنا' }] },
  ]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].runs.map((r) => [r.text, !!r.sup]), [['كتاب الفرائض', false], ['(١)', true]]);
  assert.equal(cleanArabicLine('المقدمة الحضرمية 》 فعنون'), 'المقدمة الحضرمية » فعنون');
});

test('the last page of the contents names a chapter that begins down a page; a heading the contents name more shortly keeps its words', () => {
  const toc1 = { n: 30, blocks: [para('الموضوع الصحيفة ترجمة المؤلف ..... ٣ كتاب البيع ..... ٤ فصل في الربا ..... ٥ باب السلم ..... ٦ باب الرهن ..... ٧ باب الحجر ..... ٨')] };
  const toc2 = { n: 31, blocks: [para('الموضوع الصحيفة'), para('كتاب الفرائض ..... ٩')] };
  const pages = [
    { n: 4, footer: { text: '٣' }, blocks: [heading('ترجمة الإمام العلامة'), para('هو الفقيه الإمام')] },
    { n: 10, footer: { text: '٩' }, blocks: [heading('بَابُ ٱلْجِعَالَةِ'), para('إِنَّمَا تَصِحُّ'), heading('* * *'), heading('كَائِبُ ٱلمَلَاضِنِ'), heading('* * *')] },
  ];
  fixHeadingsFromContents([...pages, toc1, toc2]);
  assert.equal(textOf(pages[0].blocks[0]), 'ترجمة الإمام العلامة');
  assert.equal(textOf(pages[1].blocks[3]), 'كتاب الفرائض');
});

/** A white page with ink rectangles. */
function page(w, h, rects) {
  const g = new Uint8Array(w * h).fill(255);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) g.fill(0, y * w + x0, y * w + x1);
  return g;
}

test('the page number is the narrow group of ink centred under the text, specks of the scan on its row aside', () => {
  const w = 1000;
  const h = 1600;
  const lines = Array.from({ length: 10 }, (_, i) => ({ x0: 100, x1: 900, y0: 100 + i * 60, y1: 130 + i * 60 }));
  const num = { x0: 480, x1: 520, y0: 1450, y1: 1480 };
  // the number, and a speck far to its right on the same row (which widens the line's box)
  const gray = page(w, h, [[480, 1450, 495, 1480], [505, 1450, 520, 1480], [900, 1470, 902, 1472]]);
  const box = footNumberBox(gray, w, h, [...lines, { ...num, x1: 903 }]);
  assert.deepEqual(box, { x0: 480, x1: 520, y0: 1450, y1: 1480 });
  // a word beside it: a line of text, not a number
  const words = page(w, h, [[480, 1450, 520, 1480], [700, 1450, 760, 1480]]);
  assert.equal(footNumberBox(words, w, h, [...lines, { ...num, x1: 760 }]), null);
  // a short last line high on the page is no number
  assert.equal(footNumberBox(gray, w, h, [...lines.slice(0, 5), { x0: 480, x1: 520, y0: 500, y1: 530 }]), null);
});

test('every page after the cover has the number of its printed page, a misread digit outvoted, a blank page unnumbered', () => {
  const models = Array.from({ length: 9 }, (_, i) => ({ n: i + 1, blocks: [para('نص الصفحة')] }));
  models[3].pageNo = { n: 3, indic: true, sure: 0.4 };
  models[4].pageNo = { n: 4, indic: true, sure: 0.4 };
  models[5].pageNo = { n: 2, indic: true, sure: 0.4 }; // ٢٠٠ read as ٢ elsewhere: far off, outvoted
  models[7].pageNo = { n: 7, indic: true, sure: 0.4 };
  models[6].blocks = []; // a blank page between
  const r = settlePageNumbers(models);
  assert.equal(r.offset, -1);
  // the cover (page 0 of the sequence) has none; the pages before the first number read have theirs; the back cover none
  assert.deepEqual(models.map((m) => m.footer?.text || null), [null, '١', '٢', '٣', '٤', '٥', null, '٧', null]);
  assert.ok(models.every((m) => !m.pageNo));
});

test('the table of contents names the فصلٌ ornament and the calligraphic titles on their pages', () => {
  const toc = { n: 9, footer: { text: '٨' }, blocks: [
    para('باب الطهارة . . . . . . . ٤'), para('فصل في الماء المكروه . . . . ٥'), para('فصل في الماء المستعمل . . . ٥'),
    para('كتاب الصلاة . . . . . . . ٦'), para('فصل في مواقيت الصلاة . . . ٦'), para('باب صفة الصلاة . . . ٧'),
  ] };
  const p4 = { n: 5, footer: { text: '٤' }, blocks: [heading('بَابُ بِلَطَّهَمَةِ'), para('لاَ يَصِحُّ رَفْعُ ٱلْحَدَثِ')] };
  const p5 = { n: 6, footer: { text: '٥' }, blocks: [
    heading('فَصَّنْكِ'), heading('[فِي ٱلْمَاءِ ٱلْمَكْرُوهِ]'), para('يُكْرَهُ شَدِيدُ ٱلسُّخُونَةِ'),
    heading('[فِي ٱلْمَاءِ ٱلْمُسْتَعْمَلِ]'), para('لاَ تَصِحُّ ٱلطَّهَارَةُ'),
  ] };
  const p6 = { n: 7, footer: { text: '٦' }, blocks: [para('تَجِبُ ٱلصَّلاَةُ عَلَىٰ كُلِّ مُسْلِمٍ'), heading('فصل'), heading('[فِي مَوَاقِيتِ ٱلصَّلاَةِ]')] };
  const p7 = { n: 8, footer: { text: '٧' }, blocks: [heading('بَابُ صِفَةِ ٱلصَّلاَةِ'), para('فُرُوضُهَا')] };
  assert.equal(contentsEntries([toc]).length, 6);
  const r = fixHeadingsFromContents([p4, p5, p6, p7, toc]);
  assert.equal(textOf(p4.blocks[0]), 'باب الطهارة', 'a misread calligraphic title');
  assert.equal(textOf(p5.blocks[0]), 'فَصْلٌ', 'the ornament the reader misread');
  assert.equal(textOf(p5.blocks[3]), 'فَصْلٌ', 'the ornament the reader left out is put back');
  assert.equal(textOf(p5.blocks[4]), '[فِي ٱلْمَاءِ ٱلْمُسْتَعْمَلِ]');
  assert.equal(textOf(p6.blocks[0]), 'كتاب الصلاة', 'a title the reader left out is put at the top');
  assert.equal(textOf(p6.blocks[2]), 'فصل', 'an ornament read right is left as it is');
  assert.equal(textOf(p7.blocks[0]), 'بَابُ صِفَةِ ٱلصَّلاَةِ', 'a title read right keeps its vowels');
  assert.deepEqual(r, { entries: 6, fasl: 2, titles: 2 });
});

test('contents read as one stream with misread digits still name the titles, matched in the order of the book', () => {
  // the reader joined the lines, misread ٥ as "ه" and lost the number of كتاب الزكاة; the title page of باب الجنائز was kept as a picture
  const toc = { n: 20, footer: { text: '١٩' }, blocks: [
    para('مُحْتَوى ٱلكِتَابِ الموضوع الصحيفة بين يدي الكتاب ٣ باب الجنائز ... ه فصل في الكفن ..... ٦ كتاب الزكاة . . فصل في زكاة الغنم ... ٨ فصل في زكاة الفطر ٩'),
  ] };
  const pic = { type: 'image', margin: true };
  const pages = [
    { n: 4, footer: { text: '٣' }, blocks: [{ ...pic }, heading('بين يدِكِ ٱلكِسابِ'), para('حمداً لمن قصر الخشية على عباده العلماء')] },
    { n: 6, footer: { text: '٥' }, blocks: [pic, para('تُسَنُّ زِيَارَةُ ٱلْمَرِيضِ')] },
    { n: 7, footer: { text: '٦' }, blocks: [para('وَيُكَفَّنُ'), heading('فَصَّنْكِ'), heading('[فِي ٱلْكَفَنِ]'), para('أَقَلُّهُ ثَوْبٌ')] },
    { n: 8, footer: { text: '٧' }, blocks: [para('كَانَ بِٱلْبَكَاءِ'), para('تَجِبُ ٱلزَّكَاةُ فِي ٱلنَّعَمِ')] },
    { n: 9, footer: { text: '٨' }, blocks: [heading('[فِي زَكَاةِ ٱلْغَنَمِ]'), para('أَوَّلُ نِصَابِهَا أَرْبَعُونَ')] },
    { n: 10, footer: { text: '٩' }, blocks: [heading('فصل'), heading('[فِي زَكَاةِ ٱلْفِطْرِ]')] },
  ];
  const entries = contentsEntries([toc]);
  assert.deepEqual(entries.map((e) => e.title), ['بين يدي الكتاب', 'باب الجنائز', 'فصل في الكفن', 'كتاب الزكاة', 'فصل في زكاة الغنم', 'فصل في زكاة الفطر']);
  const r = fixHeadingsFromContents([...pages, toc]);
  const [p4, p6, p7, p8, p9, p10] = pages;
  assert.equal(textOf(p4.blocks[0]), 'بين يدي الكتاب', 'the cut-off top of the calligraphy over it is gone');
  assert.equal(textOf(p6.blocks[0]), 'باب الجنائز', 'the picture of the title is written as text');
  assert.equal(textOf(p7.blocks[1]), 'فَصْلٌ');
  assert.equal(textOf(p8.blocks[0]), 'كتاب الزكاة', 'matched by its place in the book, its number lost');
  assert.equal(textOf(p9.blocks[0]), 'فَصْلٌ', 'put over a heading at the top of its page');
  assert.equal(textOf(p10.blocks[0]), 'فصل');
  assert.deepEqual(r, { entries: 6, fasl: 2, titles: 3 });
});

test('the page number is a centred footer of its page; a page without one has an empty footer', async () => {
  const { buildDocx } = await import('../src/pipeline/docx-builder.js');
  const { default: JSZip } = await import('jszip');
  const margins = { top: 36, bottom: 30, left: 42, right: 42 };
  const pages = [
    { n: 1, width: 420, height: 650, margins, blocks: [para('الغلاف')] },
    { n: 2, width: 420, height: 650, margins, blocks: [para('نص الصفحة')], footer: { text: '١١' } },
  ];
  const buffer = await buildDocx(pages, { arabicFont: 'Traditional Arabic', latinFont: 'Times New Roman', pageDir: 'rtl' });
  const zip = await JSZip.loadAsync(buffer);
  const footers = await Promise.all(Object.keys(zip.files).filter((f) => /^word\/footer\d+\.xml$/.test(f)).map((f) => zip.file(f).async('string')));
  assert.equal(footers.length, 2);
  const numbered = footers.find((x) => x.includes('١١'));
  assert.ok(numbered, 'the number is in a footer');
  assert.ok(numbered.includes('w:val="center"'), 'centred');
  assert.ok(footers.some((x) => !x.includes('<w:t')), 'the unnumbered page has an empty footer');
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok(!xml.includes('١١'), 'the number is not in the text');
});

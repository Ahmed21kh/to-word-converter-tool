// printMatch: running heads (page number + running title) and the book's card lines, set over the whole book.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { headParts, parsePageNumber, pageNumberOffset, pageOffsets, matchTitle, settleRunningHeads, settleCards, trimGuesses } from '../src/pipeline/running-head.js';

test('page numbers come from the page sequence: misread digits are outvoted', () => {
  assert.deepEqual(parsePageNumber('أمر السيد ١١'), { n: 11, indic: true });
  assert.equal(parsePageNumber('الروض الأنف'), null);
  // pages 7..12 print 6..11; two readings are wrong
  const readings = [{ index: 7, n: 2 }, { index: 8, n: 7 }, { index: 9, n: 8 }, { index: 10, n: 9 }, { index: 12, n: 199 }];
  assert.equal(pageNumberOffset(readings), -1);
  assert.equal(pageNumberOffset([{ index: 7, n: 2 }, { index: 9, n: 8 }]), null, 'two readings that disagree tell nothing');
});

test('a misread running title takes the text as the book prints it, from words the reader was sure of only', () => {
  const card = (parts) => ({ runs: parts.map(([text, lowConf]) => ({ text, lowConf })) });
  const halfTitle = card([['الإِبْوَضَّا لِانْفُكْ ', true], ['وَالمَشْرَعُ الرِّوَى', false]]); // calligraphy, misread alike
  const copyright = card([['الروض الأنف والمشرع الروى في تفسير ما اشتمل عليه', false]]);
  assert.equal(matchTitle('البَوْضُ الأَفْ', [halfTitle, copyright]), 'الروض الأنف');
  assert.equal(matchTitle('أمر السيد والعاقب وذكر المباحلة .', ['أمْرُ السَّيِّدِ والعاقِبِ وذِكْرُ المُباهَلةِ']), 'أمْرُ السَّيِّدِ والعاقِبِ وذِكْرُ المُباهَلةِ');
  assert.equal(matchTitle('كمن الأنبر فضلا', [copyright]), null);
});

const page = (n, blocks, heads) => ({ n, blocks, heads, method: 'ai', flow: true, width: 595, height: 842, margins: {} });
const heading = (text) => ({ type: 'p', align: 'center', runs: [{ text, bold: true }] });

test('settling: numbers from the sequence, titles from the book, unread titles left out', () => {
  const models = [
    page(6, [heading('أمْرُ السَّيِّدِ والعاقِبِ وذِكْرُ المُباهَلةِ')], [{ num: null, hasNumber: true, numSide: 'left', title: null, atTop: true }]),
    page(7, [], [{ num: { n: 2, indic: true }, hasNumber: true, numSide: 'right', title: 'البَعْضُ الأَفْ', atTop: true }]),
    page(8, [], [{ num: { n: 7, indic: true }, hasNumber: true, numSide: 'left', title: 'أمر السيد والعاقب وذكر المباحلة .', atTop: true }]),
    page(9, [], [{ num: null, hasNumber: true, numSide: 'right', title: 'البَوْضُ الأَفْ', atTop: true }]),
    page(10, [], [{ num: { n: 9, indic: true }, hasNumber: true, numSide: 'left', title: 'ألا االملة منكالا لاهم', atTop: true }]),
  ];
  const r = settleRunningHeads(models, { bookTitle: 'الروض الانف ٥' });
  assert.equal(r.offset, -1);
  const head = (m) => m.blocks[0].runs.map((x) => (x.tab ? '|' : '') + x.text).join('');
  assert.equal(head(models[0]), '|٥', 'a number alone, at its own (left) end');
  assert.equal(head(models[1]), '٦|الروض الانف', 'the reader misreads calligraphy differently on each page: both take the book title');
  assert.equal(head(models[3]), '٨|الروض الانف');
  assert.equal(head(models[2]), 'أمر السيد والعاقب وذكر المباهلة|٧', 'as the heading prints it, without its vowels');
  assert.equal(head(models[4]), '|٩', 'junk read once and matching nothing is left out');
  assert.equal(models[2].blocks[0].runningHead, 'top');
  assert.ok(models.every((m) => !m.heads));
});

test('card lines: an unsure line takes the sure text of another front page; a guess is left out; a guessed end is cut', () => {
  const para = (parts) => ({ runs: parts.map(([text, lowConf]) => ({ text, fs: 15, lowConf })) });
  const cover = [
    para([['أَبِي الْقَاسِمِ عَبْدُ ', false], ['الْكَهْلِ ', true], ['بْن ', false], ['حَيْدِ ', true], ['اللهِ الشُّبَكِيِّ', false]]),
    para([['أنا سعيدة لكيت أتقك', true]]),
    para([['الجزء الخامس', false]]),
  ];
  const copyright = [para([['تصنيف الإمام الكبير : أبي القاسم عبد الرحمن بن عبد الله السهيلي', false]])];
  const card = (paras) => ({ type: 'table', card: true, cells: [{ paras }] });
  const models = [page(1, [card(cover)]), page(3, [card(copyright)])];
  assert.deepEqual(settleCards(models), { fixed: 1, dropped: 1 });
  const lines = models[0].blocks[0].cells[0].paras.map((p) => p.runs.map((r) => r.text).join(''));
  assert.deepEqual(lines, ['أبي القاسم عبد الرحمن بن عبد الله السهيلي', 'الجزء الخامس']);

  const web = para([['www.quran.gov.ae : الموقع على الإنترنت ', false], ['مسى سن مسدق وهدة', true]]);
  assert.ok(trimGuesses(web));
  assert.equal(web.runs.map((r) => r.text).join(''), 'www.quran.gov.ae : الموقع على الإنترنت');
  const date = para([['الطبعة الأولى : ٢٢ ', false], ['٥ ه – ٢٢٢١', true], [' م', false]]);
  assert.equal(trimGuesses(date), false, 'a number is never cut off');
});

test('a running head is split into its page number and its title; the rule and the ornament under it are not part of them', () => {
  const W = 1240;
  const H = 110;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(140, 30, 120, 26); // the title (left)
  ctx.fillRect(320, 52, 700, 2); // the rule between
  ctx.fillRect(1090, 28, 14, 28); // the page number (right)
  ctx.fillRect(130, 88, 980, 2); // the ornamental rule under the head
  ctx.fillRect(560, 80, 120, 18); // its ornament
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4];
  const parts = headParts(gray, W, H);
  assert.equal(parts.numSide, 'right');
  assert.ok(parts.num.x0 >= 1085 && parts.num.x1 <= 1110, JSON.stringify(parts.num));
  assert.ok(parts.title.x0 >= 135 && parts.title.x1 <= 265, JSON.stringify(parts.title));
  assert.ok(parts.title.y1 < 88, 'the ornament below is not part of the head');
});

test('a word the reader misreads alike on every page takes the book\'s own spelling; a preposition is never exchanged', async () => {
  const { fixWords } = await import('../src/pipeline/running-head.js');
  const card = ['إتحاف الانام و إسعاف الافهام بشرح', 'توضيح المقام في وقف حمزة وهشام', 'الشيخ محمد بن أحمد - الشهير بالمتولي'];
  assert.equal(fixWords('إتحاف الأنام شرح توضيح اللقام فى وقف حمزة ومشام للمتولى', card), 'إتحاف الأنام شرح توضيح المقام فى وقف حمزة وهشام للمتولى');
});

test('a scanned page under a text layer: what the reader makes of the overlay is left out, the book\'s text is kept', async () => {
  const { overlayTest } = await import('../src/pipeline/process-page.js');
  const isOverlay = overlayTest('www.quranonlinelibrary.com المكتبة العالمية الفريدة لكتب التجويد والقراءات علی الشبكة العنكبوتية');
  assert.ok(isOverlay('المكتبة العالمية الفريدة لكتب التجويد والقراءات على الشبكة العنكبوتية'));
  assert.ok(isOverlay('..'), 'nothing but punctuation');
  assert.ok(!isOverlay('قال الإمام الشاطبي رحمه الله في باب وقف حمزة وهشام'));
});

test('a running title printed but not read takes the title of the pages around it, unless they differ (a chapter starts)', () => {
  const head = (n, title, hasTitle = true) => page(n, [], [{ num: { n: n - 1, indic: true }, hasNumber: true, numSide: n % 2 ? 'right' : 'left', title, hasTitle, atTop: true }]);
  const t = 'إتحاف الأنام شرح توضيح المقام';
  const models = [head(6, t), head(7, t), head(8, null), head(9, t), head(10, t), head(11, 'أمر السيد والعاقب'), head(12, null), head(13, 'أمر السيد والعاقب'), head(14, null, false), head(15, 'غزوة بدر')];
  settleRunningHeads(models, {});
  const titleOf = (m) => m.blocks[0].runs.map((r) => r.text).filter((x) => !/[٠-٩]/.test(x)).join('');
  assert.equal(titleOf(models[2]), t, 'between two pages with the same title');
  assert.equal(titleOf(models[6]), '', 'pages 10 and 14 differ: left as read');
  assert.equal(titleOf(models[8]), '', 'nothing was printed there');
});

test('a file name only nearly the same as the running title corrects its words but does not take its place', () => {
  const book = 'إتحاف الأنام وإسعاف الأفهام بشرح توضيح المقام في وقف حمزة وهشام';
  assert.equal(matchTitle('إتحاف الأنام شرح توضيح اللقام فى وقف حمزة وهشام للمتولى', [book]), 'إتحاف الأنام شرح توضيح المقام في وقف حمزة وهشام للمتولى');
});

test('a number not read takes the sequence; a head read as the first line of text is taken out of the text', () => {
  const t = 'إتحاف الأنام شرح توضيح المقام فى وقف حمزة وهشام للمتولى';
  const head = (n, hasNumber = true) => ({ num: hasNumber ? { n: n - 1, indic: true } : null, hasNumber, numSide: hasNumber ? (n % 2 ? 'right' : 'left') : null, title: t, hasTitle: true, atTop: true });
  const para = (text) => ({ type: 'p', runs: [{ text, fs: 15 }] });
  const models = [
    page(10, [para('نص')], [head(10)]),
    page(11, [para('نص')], [head(11)]),
    page(12, [para('نص')], [head(12, false)]),
    page(13, [para('نص')], [head(13)]),
    page(14, [para('مَكَ إنحافَ الأَيَامِ شرعَ لِوَضْحِ الكَّامِ فِي وَلَفِ حَمْزَةٌ وهشامٍ لِلمَتْوَلِى ١٣'), para('٢٠ – حكم الهمز')], []),
    page(15, [para('نص')], [head(15)]),
  ];
  settleRunningHeads(models, {});
  const lines = (m) => m.blocks.map((b) => b.runs.map((r) => r.text).join('|'));
  assert.deepEqual(lines(models[2])[0], `${t}|١١`, 'number at the end the pages around leave free');
  assert.deepEqual(lines(models[4]), [`${t}|١٣`, '٢٠ – حكم الهمز']);
  assert.equal(models[4].blocks[0].runningHead, 'top');
});

test('a book in two parts numbers its second part from another offset; a single misread digit does not start a part', () => {
  // pages 40..45 print 39..44 (one is misread 77), then a second part: pages 47..50 print 47..50
  const at = pageOffsets([{ index: 40, n: 39 }, { index: 41, n: 40 }, { index: 42, n: 77 }, { index: 43, n: 42 }, { index: 44, n: 43 },
    { index: 47, n: 47 }, { index: 48, n: 48 }, { index: 50, n: 50 }]);
  assert.deepEqual([40, 42, 45, 48, 49, 50].map((i) => i + at(i)), [39, 41, 44, 48, 49, 50]);
  // page 46, as far from the end of part one (44) as from the start of the sure run of part two (48): page 45 next to it tells
  const two = pageOffsets([{ index: 42, n: 41 }, { index: 43, n: 42 }, { index: 44, n: 43 }, { index: 45, n: 45 }, { index: 46, n: 7 },
    { index: 48, n: 48 }, { index: 49, n: 49 }, { index: 50, n: 50 }]);
  assert.equal(46 + two(46), 46);
  assert.equal(44 + two(44), 43);
});

test('a running title misread on one page takes the spelling the other pages agree on', () => {
  const t = 'إتحاف الأنام شرح توضيح المقام فى وقف حمزة وهشام للمتولى';
  const head = (n, title) => page(n, [], [{ num: { n: n - 1, indic: true }, hasNumber: true, numSide: n % 2 ? 'right' : 'left', title, hasTitle: true, atTop: true }]);
  const models = [head(4, t), head(5, 'عُنحاف الأنام شرح توضيح المقام فى وقف حمزة وهشام للمتولى'), head(6, t), head(7, 'إتخاف الأنام شرح توضيحي المقام فى وقف حمزة وهشام للمتولى'), head(8, t)];
  settleRunningHeads(models, { bookTitle: 'إتحاف الأنام وإسعاف الأفهام بشرح توضيح المقام في وقف حمزة وهشام' });
  const titles = new Set(models.map((m) => m.blocks[0].runs.map((r) => r.text).find((x) => !/[٠-٩]/.test(x))));
  assert.equal(titles.size, 1, [...titles].join(' / '));
});

test('a cover with light letters on a dark ground comes out as dark letters on white, and so does dark on light', async () => {
  const { inkFromGround } = await import('../src/pipeline/scan-clean.js');
  const W = 400;
  const H = 200;
  const gray = new Uint8Array(W * H).fill(235); // light paper
  for (let y = 0; y < 100; y++) for (let x = 0; x < W; x++) gray[y * W + x] = 60; // the dark half of the cover
  for (let y = 40; y < 50; y++) for (let x = 100; x < 300; x++) gray[y * W + x] = 210; // gold letters on it
  for (let y = 140; y < 150; y++) for (let x = 100; x < 300; x++) gray[y * W + x] = 40; // black letters on the paper
  const out = inkFromGround(gray, W, H);
  assert.ok(out[45 * W + 200] < 80 && out[145 * W + 200] < 80, 'letters dark');
  assert.ok(out[20 * W + 200] > 200 && out[180 * W + 200] > 200, 'grounds white');
});

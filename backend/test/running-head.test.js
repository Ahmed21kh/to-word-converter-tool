// printMatch: running heads (page number + running title) and the book's card lines, set over the whole book.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { headParts, parsePageNumber, pageNumberOffset, matchTitle, settleRunningHeads, settleCards, trimGuesses } from '../src/pipeline/running-head.js';

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

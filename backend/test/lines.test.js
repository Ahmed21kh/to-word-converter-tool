// Line reading helpers: token confidence, Arabic-only cleaning, line grouping, Word comments for alternative readings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wordConfidence } from '../src/pipeline/token-confidence.js';
import { cleanArabicLine, groupLines } from '../src/pipeline/vision-ocr.js';
import { segmentLines } from '../src/pipeline/text-lines.js';
import { buildDocx } from '../src/pipeline/docx-builder.js';

const tok = (token, p, alts = []) => {
  const bytes = [...Buffer.from(token)];
  return { token, logprob: Math.log(p), bytes, top_logprobs: [{ token, logprob: Math.log(p), bytes }, ...alts.map(([t, q]) => ({ token: t, logprob: Math.log(q), bytes: [...Buffer.from(t)] }))] };
};

test('confidence ignores diacritic variants and offers other letters as alternatives', () => {
  // the diacritic is split between fatha (0.5) and damma (0.45): the LETTERS are certain. The ق could have been ف.
  const r = wordConfidence([tok('ك', 0.99), tok('َ', 0.5, [['ُ', 0.45]]), tok('ق', 0.4, [['ف', 0.5]]), tok(' ', 0.99), tok('م', 0.95)]);
  assert.equal(r.text, 'كَق م');
  assert.equal(r.words.length, 2);
  assert.ok(r.words[0].conf <= 0.41 && r.words[0].conf > 0.3, 'the doubtful ق drives the word confidence');
  assert.deepEqual(r.words[0].alts.map((a) => a.text), ['كَف']);
  assert.ok(r.words[1].conf > 0.9);
});

test('the diacritic alone is never reported as doubtful', () => {
  const r = wordConfidence([tok('ب', 0.99), tok('َ', 0.4, [['ُ', 0.3], ['ِ', 0.25]])]);
  assert.ok(r.words[0].conf > 0.9);
  assert.deepEqual(r.words[0].alts, []);
});

test('cleanArabicLine drops other scripts and ornate brackets read from a letter', () => {
  const o = String.fromCharCode(0xfd3f);
  assert.equal(cleanArabicLine('قال abc 你好 زيد'), 'قال زيد');
  assert.equal(cleanArabicLine('قال [زيد] (١٢)'), 'قال [زيد] (١٢)');
  assert.equal(cleanArabicLine(`${o}قال زيد`), 'قال زيد');
  assert.equal(cleanArabicLine('abc', { arabicOnly: false }), 'abc');
});

const line = (x0, x1, y, words) => ({ x0, x1, y0: y, y1: y + 50, words: words.map((t) => ({ text: t, conf: 1, alts: [] })) });

test('groupLines finds paragraph ends, indents, centred titles and bracket headings from the geometry', () => {
  const lines = [
    line(300, 500, 0, ['عنوان', 'الفصل']), // centred and narrow
    line(100, 700, 60, ['سطر', 'كامل', 'أول']),
    line(100, 700, 120, ['سطر', 'كامل', 'ثان']),
    line(300, 700, 180, ['آخر', 'سطر']), // stops short: paragraph ends
    line(350, 700, 240, ['[عنوان', 'بين', 'أقواس]']), // a short title
    line(100, 700, 300, ['فقرة', 'جديدة']),
  ];
  const g = groupLines(lines);
  assert.equal(g.length, 4);
  assert.equal(g[0].heading, true, 'centred narrow line is a heading');
  assert.equal(g[1].heading, false);
  assert.equal(g[1].text, 'سطر كامل أول سطر كامل ثان آخر سطر');
  assert.equal(g[2].heading, true, 'bracketed title');
  assert.equal(g[3].text, 'فقرة جديدة');
});

test('groupLines highlights doubtful words and keeps the spaces in the plain text', () => {
  const l = line(100, 700, 0, ['أ', 'ب', 'ج']);
  l.words[1] = { text: 'ب', conf: 0.2, alts: ['ت'] };
  const [p] = groupLines([l]);
  assert.deepEqual(p.runs.map((r) => [r.text, !!r.lowConf]), [['أ ', false], ['ب', true], [' ج', false]]);
  assert.deepEqual(p.runs[1].alts, ['ت']);
});

test('segmentLines cuts touching lines apart and reports the ink extent', () => {
  const w = 400, h = 300;
  const px = Buffer.alloc(w * h, 255);
  const bar = (y0, y1, x0, x1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[y * w + x] = 0; };
  bar(20, 70, 50, 350);
  bar(70, 120, 50, 350); // touches the first one: one tall run that must be split in two
  bar(180, 230, 120, 250);
  const lines = segmentLines(px, w, h);
  assert.equal(lines.length, 3);
  assert.ok(Math.abs(lines[0].y1 - 70) <= 8);
  assert.equal(lines[2].x0, 120);
  assert.equal(lines[2].x1, 250);
});

test('alternative readings become a Word comment on the doubtful word', async () => {
  const page = {
    n: 1, width: 595, height: 842, margins: { top: 54, bottom: 54, left: 54, right: 54 }, method: 'ai', flow: true,
    blocks: [{ type: 'p', dir: 'rtl', align: 'start', fs: 14, lineCount: 1, runs: [{ text: 'قال ', fs: 14 }, { text: 'كوز', fs: 14, lowConf: true, alts: ['كرز', 'غوز'] }] }],
  };
  const opts = { arabicFont: 'Arial', latinFont: 'Arial', detectHeadings: false, pageDir: 'rtl' };
  const { default: JSZip } = await import('jszip');
  // by default the Word file is clean: no highlight, no comments
  const clean = await JSZip.loadAsync(await buildDocx([page], opts));
  assert.equal(clean.file('word/comments.xml'), null);
  assert.ok(!(await clean.file('word/document.xml').async('string')).includes('w:highlight'));
  // when asked, the doubtful word is highlighted and its other readings are a comment
  const zip = await JSZip.loadAsync(await buildDocx([page], { ...opts, highlightUncertain: true }));
  const comments = await zip.file('word/comments.xml').async('string');
  assert.ok(comments.includes('كرز / غوز'));
  const doc = await zip.file('word/document.xml').async('string');
  assert.ok(doc.includes('commentRangeStart') && doc.includes('commentReference'));
  assert.ok(doc.includes('w:highlight'));
});

test('a model that loops on one word is detected and the repeats are collapsed', async () => {
  const { hasLoop, collapseLoops } = await import('../src/pipeline/vision-ocr.js');
  assert.equal(hasLoop('مَنْ مَنْ مَنْ مَنْ مَنْ'), true);
  assert.equal(hasLoop('لا لا لا'), false, 'three in a row can be real text');
  assert.equal(hasLoop('قال قالَ قَالَ قَال'), true, 'diacritics do not hide a loop');
  const w = ['من', 'من', 'من', 'من', 'الله'].map((text) => ({ text }));
  assert.deepEqual(collapseLoops(w).map((x) => x.text), ['من', 'من', 'الله']);
});

test('verses are set heavier, a plain line loses marks the model made up, the font size follows the page', async () => {
  const { isMostlyPlain, paragraphsToBlocks } = await import('../src/pipeline/vision-ocr.js');
  const { stripMarks } = await import('../src/pipeline/arabic.js');
  assert.equal(isMostlyPlain('قال ابن اسحاق وقدم على رسول'), true);
  assert.equal(isMostlyPlain('قَالَ ابْنُ إِسْحَاقَ وَقَدِمَ عَلَى'), false);
  assert.equal(isMostlyPlain('قال ابنُ اسحاق وقدمَ على رسول'), true, 'two stray marks in a plain line');
  assert.equal(stripMarks('قَالَ'), 'قال');

  const { styleRange, guardParagraph } = await import('../src/pipeline/quran.js');
  const runs = [{ text: 'قبل ', fs: 14 }, { text: 'آية', fs: 14, lowConf: true, alts: ['x'] }, { text: ' بعد', fs: 14 }];
  styleRange(runs, 4, 7, { verse: true, lowConf: undefined, alts: undefined });
  assert.deepEqual(runs.map((r) => [r.text, !!r.verse, !!r.lowConf]), [['قبل ', false, false], ['آية', true, false], [' بعد', false, false]]);

  const par = { type: 'p', ai: true, ocr: true, runs: [{ text: 'وقال تعالى: قل هو الله احد الله الصمد لم يلد ولم يولد ولم يكن له كفوا احد وبعدها كلام.', fs: 14, lowConf: true }] };
  guardParagraph(par);
  const verse = par.runs.find((r) => r.verse);
  assert.ok(verse && verse.text.startsWith(String.fromCharCode(0xfd3f)), 'the verse run is separate');
  assert.ok(!verse.lowConf, 'a verse is never marked doubtful');

  const blocks = paragraphsToBlocks([{ text: 'نص', heading: false, runs: [{ text: 'نص' }, { text: 'آية', verse: true }] }, { text: 'عنوان', heading: true }], { bodyPt: 14 });
  assert.equal(blocks[0].runs[0].fs, 14);
  assert.equal(blocks[0].runs[1].bold, true, 'verse run is bold');
  assert.equal(blocks[1].runs[0].fs, 18, 'heading is four points larger');
});

test('a long centred line is poetry (centred, body size), a short one a heading; one body size for the whole document', async () => {
  const { groupLines, paragraphsToBlocks } = await import('../src/pipeline/vision-ocr.js');
  const { unifyAiFontSize } = await import('../src/pipeline/convert-pdf.js');
  const mk = (x0, x1, n) => ({ x0, x1, y0: 0, y1: 50, words: Array.from({ length: n }, () => ({ text: 'كلمة', conf: 1, alts: [] })) });
  const g = groupLines([mk(100, 700, 8), mk(100, 700, 8), mk(300, 500, 3), mk(300, 500, 10)]);
  assert.equal(g[1].heading, true);
  assert.equal(g[2].heading, false);
  assert.equal(g[2].center, true);
  const blocks = paragraphsToBlocks(g, { bodyPt: 14 });
  assert.equal(blocks[2].align, 'center');
  assert.equal(blocks[2].runs[0].bold, false);

  const page = (fs) => ({ method: 'ai', flow: true, blocks: paragraphsToBlocks(g, { bodyPt: fs }) });
  const models = [page(14), page(17), page(17)];
  unifyAiFontSize(models);
  for (const m of models) {
    assert.equal(m.blocks[0].fs, 17, 'body');
    assert.equal(m.blocks[1].fs, 21, 'heading');
    assert.equal(m.blocks[2].runs[0].fs, 17, 'poetry keeps the body size');
  }
});

test('footnote numbers run 1, 2, 3 and a missing citation number is completed from the identified verse', async () => {
  const { fixNoteNumbers } = await import('../src/pipeline/vision-ocr.js');
  const { guardParagraph } = await import('../src/pipeline/quran.js');
  const mk = (text, footnote, indent = 0) => ({ text, footnote, indent, runs: [{ text }] });
  const ps = fixNoteNumbers([mk('في (ا) المتن', false), mk('(٢) سقط من (ب).', true), mk('(ه) في (ف): كذا.', true), mk('تتمة سطر الهامش', true, 40), mk('(٣) آخر.', true)]);
  assert.equal(ps[0].text, 'في (١) المتن');
  assert.equal(ps[1].text, '(١) سقط من (ب).');
  assert.equal(ps[1].runs[0].text, '(١) سقط من (ب).');
  assert.equal(ps[2].text, '(٢) في (ف): كذا.');
  assert.equal(ps[3].text, 'تتمة سطر الهامش', 'a continuation line is not a note');
  assert.equal(ps[4].text, '(٣) آخر.');
  // a first note that lost its number (the tiny "(١)") but starts at the right edge is numbered; the rest follow
  const lost = fixNoteNumbers([mk('عن (أ)، (ب).', true), mk('(٢) في (ف): كذا.', true), mk('(٣) مسند.', true)]);
  assert.deepEqual(lost.map((p) => p.text), ['(١) عن (أ)، (ب).', '(٢) في (ف): كذا.', '(٣) مسند.']);

  const par = { type: 'p', ai: true, ocr: true, runs: [{ text: 'قال: قل هو الله احد الله الصمد لم يلد ولم يولد ولم يكن له كفوا احد [الإخلاص: ا] وبعد.' }] };
  guardParagraph(par);
  const text = par.runs.map((r) => r.text).join('');
  assert.ok(text.includes('[الإخلاص: ١-٤]'), text);
  // a printed number is never replaced
  const par2 = { type: 'p', ai: true, ocr: true, runs: [{ text: 'قل هو الله احد الله الصمد لم يلد ولم يولد ولم يكن له كفوا احد [الإخلاص: ٣]' }] };
  guardParagraph(par2);
  assert.ok(par2.runs.map((r) => r.text).join('').includes('[الإخلاص: ٣]'));
});

test('asterisks are verse brackets, a short misread quotation is repaired from its citation, a plain mention stays plain, digits follow the page', async () => {
  const { guardParagraph } = await import('../src/pipeline/quran.js');
  const { unifyDigits, cleanArabicLine } = await import('../src/pipeline/vision-ocr.js');
  const O = String.fromCharCode(0xfd3f);
  const C = String.fromCharCode(0xfd3e);
  const out = (p) => p.runs.map((r) => r.text).join('');

  // symbols the reader prints for the ornate brackets become asterisks, a pair of asterisks becomes the verse brackets
  assert.equal(cleanArabicLine('قال ♠ قل هو الله ♠ ثم'), 'قال * قل هو الله * ثم');
  const a = { type: 'p', ai: true, ocr: true, runs: [{ text: 'قال: * قل هو الله احد الله الصمد لم يلد ولم يولد ولم يكن له كفوا احد * وبعد.' }] };
  guardParagraph(a);
  assert.ok(out(a).includes(O) && out(a).includes(C) && !out(a).includes('*'));

  // a short, badly read quotation in ( ) followed by its citation is repaired from the cited verse
  const b = { type: 'p', ai: true, ocr: true, runs: [{ text: 'قوله: (كِتَبَ أُحْكِمَتْ مَايِنْتُهُ) [هود: ١] وبعد.' }] };
  guardParagraph(b);
  assert.ok(out(b).includes(O) && !out(b).includes('مَايِنْتُهُ'), out(b));
  assert.ok(!out(b).includes('('));

  // the book only mentions a verse in passing (no brackets): five matching words are not a verse in AI text
  const c = { type: 'p', ai: true, ocr: true, runs: [{ text: 'وقد خلق السموات والأرض في ستة أيام وهي ستة آلاف سنة.' }] };
  guardParagraph(c);
  assert.ok(!out(c).includes(O));

  // Arabic-Indic digits on the page: the Western ones the reader mixed in follow
  const ps = unifyDigits([{ text: '[آل عمران: 11] و(٣)', runs: [{ text: '[آل عمران: 11] و(٣)' }] }], true);
  assert.equal(ps[0].text, '[آل عمران: ١١] و(٣)');
  const w = unifyDigits([{ text: 'page 12', runs: [{ text: 'page 12' }] }], true);
  assert.equal(w[0].text, 'page 12', 'no Arabic-Indic digit on the page: left alone');
});

test('the Qari run plan follows the machine: slots by GPU memory, CPU without a usable GPU', async () => {
  const { runPlan } = await import('../src/services/llama-server.js');
  assert.deepEqual(runPlan(8192, {}), { gpu: true, parallel: 4 });
  assert.deepEqual(runPlan(5000, {}), { gpu: true, parallel: 2 });
  assert.deepEqual(runPlan(4096, {}), { gpu: true, parallel: 1 });
  assert.deepEqual(runPlan(2048, {}), { gpu: false, parallel: 1 });
  assert.deepEqual(runPlan(null, {}), { gpu: false, parallel: 1 });
  assert.deepEqual(runPlan(8192, { QARI_GPU: '0' }), { gpu: false, parallel: 1 });
  assert.deepEqual(runPlan(4096, { LLAMA_PARALLEL: '3' }), { gpu: true, parallel: 3 });
});

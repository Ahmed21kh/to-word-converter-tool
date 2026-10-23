import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPassage, canonicalText, passageRef, guardParagraph } from '../src/pipeline/quran.js';
import { UNMAPPED } from '../src/pipeline/arabic.js';

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

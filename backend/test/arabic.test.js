import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeShaping, reversalEvidence, reverseClusters, textQuality, mirrorBrackets, stripMarks, UNMAPPED,
} from '../src/pipeline/arabic.js';
import { segmentText } from '../src/pipeline/docx-builder.js';

test('presentation forms are converted back to real letters', () => {
  // visual-order shaped glyphs of "العلم" arrive as ا \uFEDF \uFECC \uFEE0 \uFEE2 (reading right to left)
  assert.equal(normalizeShaping('\uFEE2\uFEE0\uFECC\uFEDFا'), 'ملعلا');
  assert.equal(normalizeShaping('\uFEFB'), 'لا'); // lam-alef ligature
  assert.equal(normalizeShaping('\uFDF2'), 'الله'); // Allah ligature
});

test('floating diacritic placeholders lose their stray space', () => {
  assert.equal(normalizeShaping(' \u064E'), '\u064E');
});

test('unmapped glyphs stay visible instead of silently disappearing', () => {
  assert.equal(normalizeShaping('a\u0000b'), `a${UNMAPPED}b`);
});

test('letter-reversed Arabic is detected, correct Arabic is not', () => {
  const good = 'الحمد لله رب العالمين والصلاة والسلام على رسول الله محمد وعلى آله وصحبه في كل وقت وحين من الدين والعلم';
  const bad = good.split(' ').map((w) => [...w].reverse().join('')).join(' ');
  assert.equal(reversalEvidence(good).reversed, false);
  assert.equal(reversalEvidence(bad).reversed, true);
});

test('reversing keeps diacritics attached to their letters', () => {
  const s = 'ب\u064Eت\u0651\u064E'; // ب\u064Eت\u064E\u0651
  assert.equal(reverseClusters(reverseClusters(s)), s);
});

test('brackets are mirrored back to logical order', () => {
  assert.equal(mirrorBrackets(']ا[ (x)'), '[ا] )x(');
});

test('garbled text layers fail the quality check', () => {
  const garbage = 'xq#%'.repeat(80) + ''.repeat(60);
  assert.equal(textQuality(garbage).ok, false);
  assert.equal(textQuality('This is a perfectly normal English paragraph. '.repeat(5)).ok, true);
});

test('docx script segmentation separates Arabic from Latin without losing characters', () => {
  const text = 'قال Mr. Smith: ١٢٣ وبعد 2015م';
  const segs = segmentText(text, true);
  assert.equal(segs.map((s) => s.text).join(''), text);
  assert.ok(segs.some((s) => s.kind === 'lat'));
  assert.ok(segs.some((s) => s.kind === 'ar'));
});

test('stripMarks removes all tashkeel', () => {
  assert.equal(stripMarks('الل\u0651\u064Eه\u064F'), 'الله');
});

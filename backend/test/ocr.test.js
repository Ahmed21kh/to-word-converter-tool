import test from 'node:test';
import assert from 'node:assert/strict';
import { fixHonorifics } from '../src/pipeline/ocr.js';

const H = String.fromCharCode(0xfdfa);

test('junk right after "رسول الله" becomes the honorific sign', () => {
  assert.deepEqual(fixHonorifics(['قال', 'رسول', 'الله', 'فلل', 'وفد']), ['قال', 'رسول', 'الله', H, 'وفد']);
  assert.deepEqual(fixHonorifics(['وكلم', 'رسول', 'الله', 'كل:', 'منهم']), ['وكلم', 'رسول', 'الله', `${H}:`, 'منهم']);
  assert.deepEqual(fixHonorifics(['رسول', 'الله', '8', 'المدينه']), ['رسول', 'الله', H, 'المدينه']);
});

test('also after النبي', () => {
  assert.deepEqual(fixHonorifics(['من', 'أصحاب', 'النبي', 'كلك', 'يومئذ']), ['من', 'أصحاب', 'النبي', H, 'يومئذ']);
});

test('real words are never replaced', () => {
  assert.deepEqual(fixHonorifics(['رسول', 'الله', 'فقال', 'لهم']), ['رسول', 'الله', 'فقال', 'لهم']);
  assert.deepEqual(fixHonorifics(['قال', 'الله', 'كل']), ['قال', 'الله', 'كل'], 'needs "رسول" before الله');
  assert.deepEqual(fixHonorifics(['في', 'السنة', '8']), ['في', 'السنة', '8']);
});

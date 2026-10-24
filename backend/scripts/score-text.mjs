// Letter and diacritic accuracy of a transcription against a reference transcript.
//   node scripts/score-text.mjs truth.txt got.txt
// Letters: diacritics, hamza forms, alef maqsura and ta marbuta are folded, honorific phrases are equal to the glyph.
import { readFileSync } from 'node:fs';
import { stripMarks } from '../src/pipeline/arabic.js';

const HON = new RegExp('\uFDFA|صلى الله عليه وسلم', 'g');
const fold = (s) => stripMarks(s.replace(HON, 'ص')).replace(/[^ء-يٱ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
function lev(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const foldFull = (s) => s.replace(HON, 'ص').replace(/[^ء-ْٰٱ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ـ/g, '').replace(/[ٰ]/g, '');
export const fullAccuracy = (truth, got) => { const t = foldFull(truth), g = foldFull(got); return 1 - lev(t, g) / t.length; };
export const letterAccuracy = (truth, got) => { const t = fold(truth), g = fold(got); return 1 - lev(t, g) / t.length; };
if (process.argv[1] && process.argv[1].endsWith('score-text.mjs') && process.argv[2]) {
  const [t, g] = process.argv.slice(2).map((f) => readFileSync(f, 'utf8'));
  console.log(`letters ${(letterAccuracy(t, g) * 100).toFixed(1)}%   with diacritics ${(fullAccuracy(t, g) * 100).toFixed(1)}%`);
}

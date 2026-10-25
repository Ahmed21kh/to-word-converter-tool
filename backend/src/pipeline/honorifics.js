// The line reader does not know the ﷺ ligature. After "رسول الله" or "النبي" it writes a short junk word starting with و-ل
// ("وَلَكِّي", "وَلَكِمْ", "وَلِيُّ", "وََلَّمْ", "وَلِلَّهِ"); that word is put back as ﷺ.
import { stripMarks } from './arabic.js';
import { replaceRange } from './quran.js';

const SALLA = 'ﷺ';
const plain = (w) => stripMarks(w).replace(/ـ/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي');
// what the ligature is read as (letters only)
const JUNK = /^ول(?:كي|كم|ي|له|ه|م|كمي)$/;
const PROPHET = /^(?:ال|لل|وال|بال|فال)نبي$/;

/** Put ﷺ back after "رسول الله" / "النبي" where the reader wrote a junk word for it. Mutates par.runs. */
export function fixHonorifics(par) {
  const text = par.runs.map((r) => r.text).join('');
  const toks = [...text.matchAll(/[\p{L}\p{M}ـ]+/gu)].map((m) => ({ w: plain(m[0]), start: m.index, end: m.index + m[0].length }));
  const edits = [];
  for (let i = 1; i < toks.length; i++) {
    if (!JUNK.test(toks[i].w)) continue;
    const prev = toks[i - 1].w;
    const afterProphet = PROPHET.test(prev) || ((prev === 'الله' || prev === 'اللة') && i >= 2 && /^(?:[وفب]?ل?)رسول$/.test(toks[i - 2].w));
    // only a plain space between: "رسول الله، ولم ..." is ordinary prose
    if (afterProphet && /^\s+$/.test(text.slice(toks[i - 1].end, toks[i].start))) edits.push(toks[i]);
  }
  for (const t of edits.reverse()) replaceRange(par.runs, t.start, t.end, SALLA);
  return edits.length;
}

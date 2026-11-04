// "Matches the printed edition" (printMatch) keeps a book's running head as text: the page number at the outer end, the running
// title (the book's name, or the chapter's) at the other, a rule between them. Read as one line, the rule and the ornament under it
// came out as junk words and the title twice, so the head is cut into its number and its title first. The two are then read as one
// short line with the rule cut out: the line reader does not read a digit standing alone, but it reads it next to the title.
// Then, over the whole book, two things a single page cannot know:
//  - the page numbers follow the pages one by one: a few clear readings fix the number of every page, so a misread digit cannot
//    give a wrong number;
//  - a running title repeats the name of the book or of a chapter, which the book prints elsewhere in a plain font (a chapter's
//    heading in the text, the book's card): the title is set as printed there, and left out when it matches nothing.
import { eraseRules, labelComponents } from './scan-clean.js';
import { matchKey, rasmKey } from './quran.js';
import { stripMarks } from './arabic.js';
import { readLineImage, hasLoop } from './vision-ocr.js';
import { readPageDigits } from './page-digits.js';

const INK = 140;

/**
 * The parts of a head strip (8-bit grey, dark ink on light paper): the boxes of the page number and of the title (null when absent),
 * in strip pixels. The head is the top line of the strip (`atTop`; a footer's is the bottom one): an ornament or a rule under it is
 * not part of it. Found from the blots of ink, not from rows: the curls of an ornamental rule reach up close to the head.
 */
export function headParts(gray, w, h, { atTop = true } = {}) {
  // a strip is a line or two high: only the rules across it are taken away (a letter is taller than a strip's share of a page)
  const g = eraseRules(Uint8Array.from(gray), w, h, { longV: h + 1, longH: Math.round(w * 0.15) });
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = g[i] < INK ? 1 : 0;
  const { labels, comps: blots } = labelComponents(ink, w, h);
  const comps = blots.filter((c) => c.area >= 6);
  // the line grows from the largest blot of the head's part of the strip (the ornament sits lower down; the first blot may be a
  // hamza or a dot) and takes every blot beside it
  const solid = comps.filter((c) => c.h >= Math.max(8, h * 0.06) && c.area >= 30);
  const near = solid.filter((c) => (atTop ? c.y0 <= h * 0.6 : c.y1 >= h * 0.4));
  if (!near.length) return null;
  const seed = near.reduce((a, b) => (b.area > a.area ? b : a));
  let y0 = seed.y0;
  let y1 = seed.y1;
  for (let pass = 0; pass < 2; pass++) {
    for (const c of near) {
      const overlap = Math.min(y1, c.y1) - Math.max(y0, c.y0);
      if (overlap >= Math.min(c.h, y1 - y0) * 0.4) { y0 = Math.min(y0, c.y0); y1 = Math.max(y1, c.y1); }
    }
  }
  const pad = Math.round((y1 - y0) * 0.35); // dots and marks above and below the letters
  const inLine = comps.filter((c) => c.y0 >= y0 - pad && c.y1 <= y1 + pad);
  // groups of blots apart by more than a word space: the title's words stay together, the number stands apart. The pieces of a
  // dashed rule (flat and long) do not join them.
  const gapMin = Math.max(30, Math.round(w * 0.035));
  const groups = [];
  const flat = (c) => c.h <= Math.max(6, (y1 - y0) * 0.3) && c.w >= c.h * 4;
  for (const c of inLine.filter((k) => !flat(k)).sort((a, b) => a.x0 - b.x0)) {
    const last = groups[groups.length - 1];
    if (last && c.x0 - last.x1 <= gapMin) last.x1 = Math.max(last.x1, c.x1 + 1);
    else groups.push({ x0: c.x0, x1: c.x1 + 1 });
  }
  const big = groups.filter((gr) => solid.some((c) => c.x0 >= gr.x0 && c.x1 < gr.x1 && c.y0 >= y0 - pad && c.y1 <= y1 + pad));
  if (!big.length) return null;
  // what the reader is given: the letters and digits of the head and nothing else (no piece of a rule, no faint trace of one),
  // with their own grey edges
  const keep = new Set(inLine.filter((c) => !flat(c)).map((c) => c.id));
  const clean = new Uint8Array(w * h).fill(255);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const near = [0, -1, 1, -w, w].some((d) => keep.has(labels[y * w + x + d]));
      if (near) clean[y * w + x] = gray[y * w + x];
    }
  }
  const small = (gr) => gr.x1 - gr.x0 <= w * 0.09;
  const box = (gr) => ({ x0: gr.x0, x1: gr.x1, y0: Math.max(0, y0 - pad), y1: Math.min(h, y1 + pad + 1) });
  let num = null;
  let rest = big;
  if (big.length === 1) {
    if (small(big[0])) { num = big[0]; rest = []; }
  } else {
    const first = big[0];
    const lastG = big[big.length - 1];
    const gapL = big[1].x0 - first.x1;
    const gapR = lastG.x0 - big[big.length - 2].x1;
    // the number is the narrow group at an end, the one set further apart from the rest
    const pick = small(first) && (!small(lastG) || gapL >= gapR) ? first : small(lastG) ? lastG : null;
    if (pick) { num = pick; rest = big.filter((gr) => gr !== pick); }
  }
  const title = rest.length ? { x0: rest[0].x0, x1: rest[rest.length - 1].x1 } : null;
  return {
    num: num && box(num),
    numSide: num ? ((num.x0 + num.x1) / 2 < w / 2 ? 'left' : 'right') : null,
    title: title && box(title),
    line: { ...box(big[0]), x0: big[0].x0, x1: big[big.length - 1].x1 },
    clean,
  };
}

const DIGIT = { '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9, '۰': 0, '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5, '۶': 6, '۷': 7, '۸': 8, '۹': 9 };

/** The number in a reading of the page-number box ("٢٣" -> 23, also Western digits); null when it holds no digit. */
export function parsePageNumber(text) {
  let s = '';
  let indic = false;
  for (const ch of String(text || '')) {
    if (DIGIT[ch] !== undefined) { s += DIGIT[ch]; indic = true; } else if (/[0-9]/.test(ch)) s += ch;
  }
  if (!s || s.length > 4) return null;
  return { n: Number(s), indic };
}

const INDIC = '٠١٢٣٤٥٦٧٨٩';
const toIndic = (n) => String(n).split('').map((d) => INDIC[d]).join('');

/**
 * The offset between the printed page numbers and the page index: the one most readings agree on (two at least, or a single
 * reading when it is the only one). Null when the book's numbers cannot be told.
 */
export function pageNumberOffset(readings) {
  const votes = new Map();
  for (const { index, n } of readings) votes.set(n - index, (votes.get(n - index) || 0) + 1);
  let best = null;
  let count = 0;
  for (const [off, c] of votes) if (c > count) { best = off; count = c; }
  if (best === null) return null;
  return count >= 2 || readings.length === 1 ? best : null;
}

/**
 * The offset for each page: a book in two parts, or a plate left out of the count, numbers its pages on from another offset. A
 * reading counts when it gives the offset most readings agree on, or when the two before or after it (in page order) give the same
 * offset as it does, so misread digits are outvoted by their neighbours; a page takes the offset of the nearest such reading (the earlier one when two are as near). Without any, the
 * offset most readings agree on (pageNumberOffset) holds for every page.
 */
export function pageOffsets(readings) {
  const sorted = [...readings].sort((a, b) => a.index - b.index).map((r) => ({ index: r.index, off: r.n - r.index }));
  const fallback = pageNumberOffset(readings);
  // three readings in a row: a digit is often misread the same way on two pages running ("٣٠" as "٢٠"), hardly on three
  const run = (i) => [[-2, -1], [-1, 1], [1, 2]].some((d) => d.every((k) => sorted[i + k]?.off === sorted[i].off));
  const sure = sorted.filter((r, i) => r.off === fallback || run(i));
  const far = (r, index) => Math.abs(r.index - index);
  return (index) => {
    if (!sure.length) return fallback;
    const d = Math.min(...sure.map((r) => far(r, index)));
    const near = [...new Set(sure.filter((r) => far(r, index) === d).map((r) => r.off))];
    if (near.length === 1) return near[0];
    // as far from the end of one part as from the start of the next: the readings nearest to the page tell which part it is in
    const by = [...sorted].sort((a, b) => far(a, index) - far(b, index)).find((r) => near.includes(r.off));
    return by ? by.off : near[0];
  };
}

const keyOf = (text) => rasmKey(String(text).split(' ').map(matchKey).join(''));
function shapeSim(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(1, a.length, b.length);
}

const cleanTitle = (t) => String(t).replace(/[[\]()«»{}﴿﴾]/g, ' ').replace(/[0-9٠-٩۰-۹]/g, ' ').split(' ').filter(Boolean).join(' ');

/** Words of a source with how sure the reader was of each: a plain string is all sure, a paragraph's runs carry `lowConf`. */
function sourceWords(src) {
  if (typeof src === 'string') return cleanTitle(src).split(' ').filter(Boolean).map((text) => ({ text, sure: true }));
  return src.runs.flatMap((r) => cleanTitle(r.text).split(' ').filter(Boolean).map((text) => ({ text, sure: !r.lowConf })));
}

/**
 * The printed text a reading stands for, among `sources` (a chapter's heading, a line of the book's card, its file name: strings, or
 * paragraphs whose runs say which words the reader was unsure of): the run of words whose letter shapes (dots aside) are closest to
 * the reading. Only words the reader was sure of count: a cover's calligraphy is misread much like a running title's, and the two
 * misreadings look alike. Null when nothing comes close enough. The reading is then written with the matching words (alignWords),
 * or, `whole`, replaced by the run of words (a card's line: the words of its own the reader was unsure of are what is wrong).
 */
export function matchTitle(reading, sources, minSim = 0.6, { whole = false } = {}) {
  const words = cleanTitle(reading).split(' ').filter((w) => keyOf(w).length);
  const key = keyOf(words.join(' '));
  if (key.length < 3) return null;
  let best = null;
  let around = null;
  let score = 0;
  for (const src of sources) {
    const sw = sourceWords(src);
    for (let len = Math.max(1, words.length - 2); len <= Math.min(sw.length, words.length + 2); len++) {
      for (let i = 0; i + len <= sw.length; i++) {
        const win = sw.slice(i, i + len);
        if (win.filter((x) => x.sure).length < len * 0.75) continue;
        const sim = shapeSim(key, keyOf(win.map((x) => x.text).join(' ')));
        if (sim > score) { score = sim; best = win.map((x) => x.text); around = sw.map((x) => x.text); }
      }
    }
  }
  if (score < minSim) return null;
  // the words are matched along the whole source, in order: a window shorter than the reading may have cut off its first word
  return whole ? best.join(' ') : alignWords(words, around);
}

/**
 * The reading with each of its words written as the matching word of `printed`; a word read but not there stays, a word there but
 * not read is left out. A source only nearly the same as the head (the file name "إتحاف الأنام وإسعاف الأفهام بشرح ..." for the
 * head "إتحاف الأنام شرح ... للمتولى") would otherwise put its own words in the head's place. A word is not exchanged for the same
 * word with a letter more at an end ("شرح" / "بشرح"): that is another word.
 */
function alignWords(read, printed) {
  const rk = read.map(keyOf);
  const pk = printed.map(keyOf);
  const pair = (i, j) => {
    const [a, b] = [rk[i], pk[j]];
    if (a.length !== b.length && (a.endsWith(b) || b.endsWith(a) || a.startsWith(b) || b.startsWith(a))) return 0;
    const sim = shapeSim(a, b);
    return sim >= 0.5 ? sim : 0;
  };
  // best[i][j]: the most similarity the first i read words and the first j printed words can share, in order
  const best = Array.from({ length: read.length + 1 }, () => new Array(printed.length + 1).fill(0));
  for (let i = 1; i <= read.length; i++) {
    for (let j = 1; j <= printed.length; j++) {
      const p = pair(i - 1, j - 1);
      best[i][j] = Math.max(best[i - 1][j], best[i][j - 1], p ? best[i - 1][j - 1] + p : 0);
    }
  }
  const out = [];
  for (let i = read.length, j = printed.length; i > 0;) {
    const p = j > 0 ? pair(i - 1, j - 1) : 0;
    if (p && best[i][j] === best[i - 1][j - 1] + p) { out.unshift(printed[j - 1]); i--; j--; } else if (j > 0 && best[i][j] === best[i][j - 1]) j--; else { out.unshift(read[i - 1]); i--; }
  }
  return out.join(' ');
}

/**
 * A line of words with a guess at a logo or an ornament beside them ("الموقع على الإنترنت مُسَّى سِنٍّ مِسْدَقٌ ..."): an end of three
 * words or more, unsure for three in five and starting from an unsure word, is cut off when two words or more are left. A number is
 * never cut off (a date or a telephone number misread in a digit is still the line's own).
 */
export function trimGuesses(p) {
  const words = p.runs.flatMap((r) => r.text.split(' ').filter(Boolean).map((text) => ({ text, sure: !r.lowConf })));
  const tail = (arr) => {
    let cut = arr.length;
    for (let i = arr.length - 3; i >= 2; i--) {
      const end = arr.slice(i);
      if (end.some((x) => /[0-9٠-٩۰-۹]/.test(x.text))) break;
      if (!end[0].sure && end.filter((x) => !x.sure).length >= end.length * 0.6) cut = i;
    }
    return cut;
  };
  let kept = words.slice(0, tail(words));
  kept = kept.slice(kept.length - tail([...kept].reverse()));
  if (kept.length === words.length) return false;
  const runs = [];
  kept.forEach((x, i) => {
    const text = x.text + (i < kept.length - 1 ? ' ' : '');
    const last = runs[runs.length - 1];
    if (last && !last.lowConf === x.sure) last.text += text;
    else runs.push({ ...p.runs[0], text, lowConf: x.sure ? undefined : true, alts: undefined });
  });
  p.runs = runs;
  return true;
}

/**
 * A cover's lines in calligraphy are misread; the same words are usually printed again in a plain font on another front page (the
 * title page, the copyright page: the book, its author, its editor). A card line with words the reader was unsure of takes the text
 * of the closest run of sure words on another card page. A line still unsure for three words in four after that is a guess at
 * calligraphy or at a logo (measured on a cover: such lines are unsure throughout, the lines read right are sure throughout): it is
 * left out rather than printed as other words. The title page may be read as plain text rather than as a card, and the file name
 * often is the book's title: the plain lines of the pages next to the cards, and `extra` texts, are sources too.
 * @returns {{fixed:number, dropped:number}}
 */
export function settleCards(models, { extra = [] } = {}) {
  const cards = models.flatMap((m) => m.blocks.filter((b) => b.type === 'table' && b.card).map((b) => ({ m, cell: b.cells[0] })));
  const last = Math.max(0, ...cards.map((c) => c.m.n));
  const plain = models.filter((m) => m.n <= last + 2).flatMap((m) => m.blocks.filter((b) => b.type === 'p' && !b.margin && b.runs?.length));
  let fixed = 0;
  let dropped = 0;
  for (const card of cards) {
    const others = [...cards.filter((c) => c !== card).flatMap((c) => c.cell.paras), ...plain];
    for (const p of card.cell.paras) {
      const words = sourceWords(p);
      if (!words.length || words.every((x) => x.sure)) continue;
      // the file name first: typed by a person, it has no misread letter (the title page read in a plain font may have one)
      const read = words.map((x) => x.text).join(' ');
      const text = words.length >= 2 ? matchTitle(read, extra.filter(Boolean), 0.5, { whole: true }) || matchTitle(read, others, 0.6, { whole: true }) : null;
      if (text) {
        p.runs = [{ ...p.runs[0], text, lowConf: undefined, alts: undefined }];
        fixed++;
      } else if (words.filter((x) => !x.sure).length >= words.length * 0.75) p.drop = true;
      else trimGuesses(p);
    }
  }
  for (const card of cards) {
    const kept = card.cell.paras.filter((p) => !p.drop);
    dropped += card.cell.paras.length - kept.length;
    card.cell.paras = kept;
  }
  // a card left without any line keeps its page, empty
  for (const m of models) m.blocks = m.blocks.filter((b) => !(b.type === 'table' && b.card && !b.cells[0].paras.length));
  return { fixed, dropped };
}

/**
 * A word the reader gets wrong the same way on every page ("اللقام" for "المقام") outvotes nothing: a word of four letters or more
 * that the book's text (`sources`: its headings, its card, the pages read in a plain font) does not have takes the one closest to
 * it, when close enough (0.75 by letter shapes, dots aside: one letter in four) and written with the same first and last letter (a
 * preposition is not exchanged: "للمتولى" stays); among equally close words, the one the book uses most.
 */
export function fixWords(title, sources) {
  const vocab = new Map(); // key -> {text, count}
  for (const src of sources) {
    for (const x of sourceWords(src)) {
      if (!x.sure) continue;
      const k = keyOf(x.text);
      const v = vocab.get(k);
      if (v) v.count++; else vocab.set(k, { text: x.text, count: 1 });
    }
  }
  const ends = (w) => { const t = stripMarks(w).replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي'); return [t[0], t[t.length - 1]]; };
  return title.split(' ').map((word) => {
    const key = keyOf(word);
    if (key.length < 4 || vocab.has(key)) return word;
    const [first, last] = ends(word);
    let best = null;
    for (const [k, v] of vocab) {
      const [f, l] = ends(v.text);
      if (f !== first || l !== last) continue;
      const sim = shapeSim(key, k);
      if (sim >= 0.75 && (!best || sim > best.sim || (sim === best.sim && v.count > best.count))) best = { sim, count: v.count, text: v.text };
    }
    return best ? best.text : word;
  }).join(' ');
}

const isHeading = (b) => b.type === 'p' && !b.margin && b.align === 'center' && b.runs[0]?.bold;
const textOf = (b) => b.runs.map((r) => r.text).join('');

/** The head's number and title side by side, as on the page but without the rule between them (grey image). */
export function joinHead(gray, w, h, parts) {
  const pieces = [parts.num, parts.title].filter(Boolean).sort((a, b) => a.x0 - b.x0);
  const y0 = Math.min(...pieces.map((b) => b.y0));
  const y1 = Math.max(...pieces.map((b) => b.y1));
  const gap = Math.round((y1 - y0) * 0.8);
  const pad = 4;
  const boxes = pieces.map((b) => ({ x0: Math.max(0, b.x0 - pad), x1: Math.min(w, b.x1 + pad) }));
  const W = boxes.reduce((s, b) => s + b.x1 - b.x0, 0) + gap * (boxes.length - 1);
  const H = y1 - y0;
  const out = new Uint8Array(W * H).fill(255);
  let at = 0;
  for (const b of boxes) {
    for (let y = 0; y < H; y++) out.set(gray.subarray((y + y0) * w + b.x0, (y + y0) * w + b.x1), y * W + at);
    at += b.x1 - b.x0 + gap;
  }
  return { gray: out, width: W, height: H };
}

/** The grey pixels of box b (2 px around it) of an image w x h: [gray, width, height]. */
function cropBox(gray, w, h, b) {
  const x0 = Math.max(0, b.x0 - 2);
  const x1 = Math.min(w, b.x1 + 3);
  const y0 = Math.max(0, b.y0);
  const y1 = Math.min(h, b.y1);
  const cw = x1 - x0;
  const out = new Uint8Array(cw * (y1 - y0));
  for (let y = y0; y < y1; y++) out.set(gray.subarray(y * w + x0, y * w + x1), (y - y0) * cw);
  return [out, cw, y1 - y0];
}

/**
 * Read a head strip (printMatch). Null when it holds no head (only a rule or an ornament).
 * @returns {Promise<{num:{n,indic}|null, hasNumber:boolean, numSide:'left'|'right'|null, title:string|null, atTop:boolean}|null>}
 */
export async function readHead(gray, w, h, { atTop = true, arabicOnly = true } = {}) {
  const parts = headParts(gray, w, h, { atTop });
  if (!parts || (!parts.num && !parts.title)) return null;
  const line = joinHead(parts.clean, w, h, parts);
  let { text } = await readLineImage(line.gray, line.width, line.height, { arabicOnly });
  // caught in a loop ("٩٢ ٩٢ ٩٢ ..."): read again with a penalty on repeats; still looping, it has read nothing
  if (hasLoop(text)) ({ text } = await readLineImage(line.gray, line.width, line.height, { arabicOnly, penalty: 1.15 }));
  if (hasLoop(text)) text = '';
  // the number by the shapes of its digits: the line reader guesses at a number standing alone ("٥٦" read "٦", "٥٩" read "٩٥")
  const shaped = parts.num ? await readPageDigits(...cropBox(parts.clean, w, h, parts.num)) : null;
  const num = shaped ? { n: shaped.n, indic: shaped.indic, sure: shaped.sure } : parsePageNumber(text);
  // a letter left alone at an end is what the reader made of a dash of the rule ("م إتحاف الأنام ...")
  const words = cleanTitle(text).replace(/^[\s.,،:؛%\-–—]+|[\s.,،:؛%\-–—]+$/g, '').split(' ').filter(Boolean);
  while (words.length > 1 && stripMarks(words[0]).length <= 1) words.shift();
  while (words.length > 1 && stripMarks(words[words.length - 1]).length <= 1) words.pop();
  const title = words.join(' ') || null;
  let { numSide } = parts;
  // a number the reader joined to the title: right-to-left text names the right-hand end first
  if (!numSide && num) numSide = /^[\s(]*[0-9٠-٩۰-۹]/.test(text) ? 'right' : 'left';
  return { num, hasNumber: !!parts.num || !!num, numSide, title: parts.title ? title : null, hasTitle: !!parts.title, atTop };
}

/**
 * Book-level pass over the page models (printMatch): each page's `head` reading becomes a paragraph in its place, with the number
 * the page sequence gives and the title as the book prints it:
 *  1. the plain-font text it matches (a chapter heading, a line of the card, the file name), letters as printed there;
 *  2. else the title of another page whose reading looks the same (the reader misreads calligraphy differently on every page);
 *  3. else, a title read alike on two pages or more (sure to be printed there): the reading closest to all the others, whose
 *     slips the other readings outvote;
 *  4. else nothing: a title that is read differently each time and matches nothing is junk.
 * The cover's lines are set first (settleCards), so a running title can take the book's name from them.
 * @returns {{offset:number|null, titles:number, dropped:number, cards:number, cardLinesDropped:number}}
 */
export function settleRunningHeads(models, { bookTitle } = {}) {
  const heads = models.flatMap((m) => (m.heads || []).map((head) => ({ m, head })));
  const readings = heads.filter((x) => x.head.num).map((x) => ({ index: x.m.n, n: x.head.num.n }));
  const offset = pageNumberOffset(readings);
  const offsetAt = pageOffsets(readings);
  const indic = heads.some((x) => x.head.num?.indic) || !heads.some((x) => x.head.num);
  const sources = [];
  for (const m of models) {
    for (const b of m.blocks) {
      if (isHeading(b)) sources.push(textOf(b));
      if (b.type === 'table' && b.card) sources.push(...b.cells[0].paras);
    }
  }
  if (bookTitle) sources.push(bookTitle);
  // the words of the pages themselves, set in a plain font: what a word misread alike in every running title is checked against
  const bodyText = models.flatMap((m) => m.blocks.filter((b) => b.type === 'p' && !b.margin && !b.footnote).map(textOf));
  const cards = settleCards(models, { extra: [bookTitle] });
  const read = heads.filter((x) => x.head.title).map((x) => ({ x, raw: x.head.title, key: keyOf(x.head.title) }));
  for (const r of read) r.title = matchTitle(r.raw, sources);
  const similar = (a, b) => a !== b && shapeSim(a.key, b.key) >= 0.6;
  for (const r of read) if (!r.title) r.title = read.find((o) => o.title && similar(r, o) && matchTitle(o.raw, sources))?.title || null;
  for (const r of read) {
    if (r.title) continue;
    const same = read.filter((o) => o !== r && shapeSim(r.key, o.key) >= 0.75);
    if (!same.length) continue;
    // the reading closest to all the readings of the book, not of this page's group only: every page then prints the same title
    const score = (x) => read.reduce((s, o) => s + (shapeSim(x.key, o.key) >= 0.75 ? shapeSim(x.key, o.key) : 0), 0);
    r.title = fixWords([r, ...same].reduce((a, b) => (score(b) > score(a) ? b : a)).raw, [...sources, ...bodyText]);
  }
  let titles = 0;
  let dropped = 0;
  for (const r of read) {
    if (!r.title) { dropped++; continue; }
    titles++;
    // the heading in the text may be vowelled; the head is printed as it was read
    if (stripMarks(r.raw) === r.raw) r.title = stripMarks(r.title);
  }
  // a running title is printed alike on every page: titles that look the same take the spelling most pages have
  const counts = new Map();
  for (const r of read) if (r.title) counts.set(r.title, (counts.get(r.title) || 0) + 1);
  const tKey = new Map([...counts.keys()].map((t) => [t, keyOf(t)]));
  for (const r of read) {
    if (!r.title) continue;
    let best = r.title;
    for (const [t, c] of counts) if (c > counts.get(best) && shapeSim(tKey.get(r.title), tKey.get(t)) >= 0.8) best = t;
    r.title = best;
  }
  const titleOf = new Map(read.map((r) => [r.x, r.title]));
  // a title printed but not read: a running title stays the same from page to page, so when the pages two before and two after
  // it (the same side of the book) carry one title, so does this one. A chapter's first page has two different ones around it.
  const byPage = new Map(heads.filter((x) => x.head.atTop).map((x) => [x.m.n, x]));
  // the nearest page on one side (step -2 / +2: the same side of the book) whose head carries a title, two pages away at most
  const nearTitle = (n, step) => [n + step, n + 2 * step].map((k) => titleOf.get(byPage.get(k))).find(Boolean) || null;
  // a head whose title part was not seen at all takes it too when a page next to it has the same one
  for (const x of heads) {
    if (titleOf.get(x) || !x.head.atTop) continue;
    const before = nearTitle(x.m.n, -2);
    if (!before || before !== nearTitle(x.m.n, 2)) continue;
    if (!x.head.hasTitle && ![-1, 1].some((d) => titleOf.get(byPage.get(x.m.n + d)) === before)) continue;
    titleOf.set(x, before);
    titles++;
  }
  // a number printed but not read: the pages on both sides have theirs, so this one has one too, at the end they leave free
  const sideOf = (n) => byPage.get(n - 2)?.head.numSide || byPage.get(n + 2)?.head.numSide
    || { left: 'right', right: 'left' }[byPage.get(n - 1)?.head.numSide || byPage.get(n + 1)?.head.numSide] || null;
  for (const x of heads) {
    const { m, head } = x;
    const numbered = (ds) => ds.some((d) => byPage.get(m.n + d)?.head.hasNumber);
    if (head.hasNumber || !head.atTop || !numbered([-1, -2]) || !numbered([1, 2])) continue;
    head.hasNumber = true;
    head.numSide = head.numSide || sideOf(m.n);
  }
  // the number the sequence gives; a page whose own digits were read surely, one or two off it, keeps its own (a page the scan left
  // out, or two pages numbered alike, shifts the numbers from there on)
  const ownOf = new Map(heads.filter((x) => x.head.atTop && x.head.num?.sure >= 0.1).map((x) => [x.m.n, x.head.num.n]));
  const numberOf = (n) => {
    const off = offsetAt(n);
    if (off === null) return null;
    const own = ownOf.get(n);
    const k = own && own !== n + off && Math.abs(own - (n + off)) <= 2 ? own : n + off;
    return k > 0 ? (indic ? toIndic(k) : String(k)) : null;
  };
  for (const x of heads) {
    const { m, head } = x;
    const block = headBlock({ number: head.hasNumber ? numberOf(m.n) : null, title: titleOf.get(x) || null, numSide: head.numSide, fs: head.fs, atTop: head.atTop });
    if (block) { if (head.atTop) m.blocks.unshift(block); else m.blocks.push(block); }
  }
  // a head the page reader took for text (a rule it did not see): the page's first line reads as the title of the pages around it
  for (const m of models) {
    const own = byPage.get(m.n);
    // only between pages with heads: a title page before them prints the book's name too
    if (own || ![-1, -2, -3].some((k) => byPage.has(m.n + k)) || ![1, 2, 3].some((k) => byPage.has(m.n + k))) continue;
    const title = nearTitle(m.n, -2) || nearTitle(m.n, 2) || nearTitle(m.n, -1) || nearTitle(m.n, 1);
    const first = m.blocks.find((b) => !b.margin);
    if (!title || first?.type !== 'p') continue;
    const cut = leakedHead(first, title);
    if (!cut) continue;
    dropWords(m, first, cut);
    const near = byPage.get(m.n - 1) || byPage.get(m.n + 1) || byPage.get(m.n - 2) || byPage.get(m.n + 2);
    const numbered = byPage.get(m.n - 1)?.head.hasNumber || byPage.get(m.n + 1)?.head.hasNumber;
    const block = headBlock({ number: numbered ? numberOf(m.n) : null, title, numSide: sideOf(m.n), fs: near?.head.fs, atTop: true });
    m.blocks.unshift(block);
    titles++;
  }
  for (const m of models) delete m.heads;
  return { offset, titles, dropped, cards: cards.fixed, cardLinesDropped: cards.dropped };
}

const wordsOf = (b) => b.runs.flatMap((r) => r.text.split(' ').filter(Boolean));
const numberish = (w) => /^[0-9٠-٩۰-۹\-–—.,،:()]+$/.test(w);

/**
 * How many words at the start of paragraph `p` are a running head read as text: the title (letter shapes 0.6 alike) after two
 * stray words at most (the rule's dashes, a digit), with the number read beside it. 0 when the paragraph does not start so.
 */
export function leakedHead(p, title) {
  const words = wordsOf(p);
  const tKey = keyOf(cleanTitle(title));
  const n = title.split(' ').length;
  let best = null;
  for (let s = 0; s <= 2; s++) {
    for (let len = Math.max(2, n - 2); len <= n + 2 && s + len <= words.length; len++) {
      const sim = shapeSim(tKey, keyOf(cleanTitle(words.slice(s, s + len).join(' '))));
      if (sim >= 0.6 && (!best || sim > best.sim)) best = { sim, end: s + len };
    }
  }
  if (!best) return 0;
  let end = best.end;
  while (end < words.length && end < best.end + 2 && numberish(words[end])) end++;
  return end;
}

/** Leaves out the first `count` words of paragraph `p` (and the paragraph, when nothing is left of it). */
function dropWords(m, p, count) {
  let left = count;
  while (left > 0 && p.runs.length) {
    const r = p.runs[0];
    const words = r.text.split(' ').filter(Boolean);
    if (words.length <= left) { left -= words.length; p.runs.shift(); continue; }
    p.runs[0] = { ...r, text: words.slice(left).join(' ') + (/\s$/.test(r.text) ? ' ' : '') };
    left = 0;
  }
  if (!p.runs.some((r) => r.text.trim())) m.blocks.splice(m.blocks.indexOf(p), 1);
}

/** The head as one paragraph: number and title at the two ends of the line (a tab to the far end), a rule under a top head. */
export function headBlock({ number, title, numSide, fs = 12, atTop = true }) {
  if (!number && !title) return null;
  const run = (text) => ({ text, fs, bold: false, italic: false });
  // right-to-left: the first run sits at the right edge, the tab sends the second to the left one
  const right = numSide === 'right' ? number : title;
  const left = numSide === 'right' ? title : number;
  const runs = [];
  if (right) runs.push(run(right));
  if (left) runs.push({ ...run(left), tab: true });
  return {
    type: 'p', runs, dir: 'rtl', align: !right ? 'end' : 'start', fs, lineCount: 1, lineGap: null, margin: true, runningHead: atTop ? 'top' : 'bottom',
  };
}

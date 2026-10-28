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
import { readLineImage } from './vision-ocr.js';

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
  const comps = labelComponents(ink, w, h).comps.filter((c) => c.area >= 6);
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
  const flat = (c) => c.h <= Math.max(5, (y1 - y0) * 0.2) && c.w >= c.h * 4;
  for (const c of inLine.filter((k) => !flat(k)).sort((a, b) => a.x0 - b.x0)) {
    const last = groups[groups.length - 1];
    if (last && c.x0 - last.x1 <= gapMin) last.x1 = Math.max(last.x1, c.x1 + 1);
    else groups.push({ x0: c.x0, x1: c.x1 + 1 });
  }
  const big = groups.filter((gr) => solid.some((c) => c.x0 >= gr.x0 && c.x1 < gr.x1 && c.y0 >= y0 - pad && c.y1 <= y1 + pad));
  if (!big.length) return null;
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
 * misreadings look alike. Null when nothing comes close enough.
 */
export function matchTitle(reading, sources, minSim = 0.6) {
  const words = cleanTitle(reading).split(' ').filter(Boolean);
  const key = keyOf(words.join(' '));
  if (key.length < 3) return null;
  let best = null;
  let score = 0;
  for (const src of sources) {
    const sw = sourceWords(src);
    for (let len = Math.max(1, words.length - 2); len <= Math.min(sw.length, words.length + 2); len++) {
      for (let i = 0; i + len <= sw.length; i++) {
        const win = sw.slice(i, i + len);
        if (win.filter((x) => x.sure).length < len * 0.75) continue;
        const text = win.map((x) => x.text).join(' ');
        const sim = shapeSim(key, keyOf(text));
        if (sim > score) { score = sim; best = text; }
      }
    }
  }
  return score >= minSim ? best : null;
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
 * left out rather than printed as other words.
 * @returns {{fixed:number, dropped:number}}
 */
export function settleCards(models) {
  const cards = models.flatMap((m) => m.blocks.filter((b) => b.type === 'table' && b.card).map((b) => ({ m, cell: b.cells[0] })));
  let fixed = 0;
  let dropped = 0;
  for (const card of cards) {
    const others = cards.filter((c) => c !== card).flatMap((c) => c.cell.paras);
    for (const p of card.cell.paras) {
      const words = sourceWords(p);
      if (!words.length || words.every((x) => x.sure)) continue;
      const text = words.length >= 2 ? matchTitle(words.map((x) => x.text).join(' '), others) : null;
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

/**
 * Read a head strip (printMatch). Null when it holds no head (only a rule or an ornament).
 * @returns {Promise<{num:{n,indic}|null, hasNumber:boolean, numSide:'left'|'right'|null, title:string|null, atTop:boolean}|null>}
 */
export async function readHead(gray, w, h, { atTop = true, arabicOnly = true } = {}) {
  const parts = headParts(gray, w, h, { atTop });
  if (!parts || (!parts.num && !parts.title)) return null;
  const line = joinHead(gray, w, h, parts);
  const { text } = await readLineImage(line.gray, line.width, line.height, { arabicOnly });
  const num = parsePageNumber(text);
  const title = cleanTitle(text).replace(/^[\s.,،:؛\-–—]+|[\s.,،:؛\-–—]+$/g, '') || null;
  let { numSide } = parts;
  // a number the reader joined to the title: right-to-left text names the right-hand end first
  if (!numSide && num) numSide = /^[\s(]*[0-9٠-٩۰-۹]/.test(text) ? 'right' : 'left';
  return { num, hasNumber: !!parts.num || !!num, numSide, title: parts.title ? title : null, atTop };
}

/**
 * Book-level pass over the page models (printMatch): each page's `head` reading becomes a paragraph in its place, with the number
 * the page sequence gives and the title as the book prints it:
 *  1. the plain-font text it matches (a chapter heading, a line of the card, the file name), letters as printed there;
 *  2. else the title of another page whose reading looks the same (the reader misreads calligraphy differently on every page);
 *  3. else a reading that comes out the same on two pages or more (a plain title read well);
 *  4. else nothing: a title that is read differently each time and matches nothing is junk.
 * The cover's lines are set first (settleCards), so a running title can take the book's name from them.
 * @returns {{offset:number|null, titles:number, dropped:number, cards:number, cardLinesDropped:number}}
 */
export function settleRunningHeads(models, { bookTitle } = {}) {
  const heads = models.flatMap((m) => (m.heads || []).map((head) => ({ m, head })));
  const offset = pageNumberOffset(heads.filter((x) => x.head.num).map((x) => ({ index: x.m.n, n: x.head.num.n })));
  const indic = heads.some((x) => x.head.num?.indic) || !heads.some((x) => x.head.num);
  const sources = [];
  for (const m of models) {
    for (const b of m.blocks) {
      if (isHeading(b)) sources.push(textOf(b));
      if (b.type === 'table' && b.card) sources.push(...b.cells[0].paras);
    }
  }
  if (bookTitle) sources.push(bookTitle);
  const cards = settleCards(models);
  const read = heads.filter((x) => x.head.title).map((x) => ({ x, raw: x.head.title, key: keyOf(x.head.title) }));
  for (const r of read) r.title = matchTitle(r.raw, sources);
  const similar = (a, b) => a !== b && shapeSim(a.key, b.key) >= 0.6;
  for (const r of read) if (!r.title) r.title = read.find((o) => o.title && similar(r, o) && matchTitle(o.raw, sources))?.title || null;
  for (const r of read) {
    if (r.title) continue;
    const same = read.filter((o) => o !== r && shapeSim(r.key, o.key) >= 0.85);
    if (same.length) r.title = r.raw;
  }
  let titles = 0;
  let dropped = 0;
  for (const r of read) {
    if (!r.title) { dropped++; continue; }
    titles++;
    // the heading in the text may be vowelled; the head is printed as it was read
    if (stripMarks(r.raw) === r.raw) r.title = stripMarks(r.title);
  }
  const titleOf = new Map(read.map((r) => [r.x, r.title]));
  for (const x of heads) {
    const { m, head } = x;
    const n = offset !== null && head.hasNumber && m.n + offset > 0 ? m.n + offset : null;
    const block = headBlock({ number: n === null ? null : indic ? toIndic(n) : String(n), title: titleOf.get(x) || null, numSide: head.numSide, fs: head.fs, atTop: head.atTop });
    if (block) { if (head.atTop) m.blocks.unshift(block); else m.blocks.push(block); }
  }
  for (const m of models) delete m.heads;
  return { offset, titles, dropped, cards: cards.fixed, cardLinesDropped: cards.dropped };
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

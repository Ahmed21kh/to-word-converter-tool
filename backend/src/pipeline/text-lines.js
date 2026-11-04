// Split a page body (8-bit grey, dark ink on light paper) into its text lines, so that each line can be read on its own.
// A line is a run of rows that hold ink. The marks above or below a line can float free of it as thin runs of their own: those are
// joined to the nearer line. Tight leading makes the descenders of one line touch the ascenders of the next, so a run that is much
// taller than the typical line is cut again at the quietest rows near the expected line boundaries.
import { labelComponents } from './scan-clean.js';

const smooth = (a, r) => a.map((_, i) => {
  let s = 0, n = 0;
  for (let k = Math.max(0, i - r); k <= Math.min(a.length - 1, i + r); k++) { s += a[k]; n++; }
  return s / n;
});

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/**
 * @param {Uint8Array|Buffer} gray w*h
 * @returns {{y0:number,y1:number,x0:number,x1:number}[]} lines, top to bottom (y1 exclusive); x0..x1 is the horizontal extent of the ink
 */
export function segmentLines(gray, w, h, { inkBelow = 140 } = {}) {
  const rows = new Array(h).fill(0);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = 0; x < w; x++) if (gray[y * w + x] < inkBelow) c++;
    rows[y] = c;
  }
  const thr = Math.max(3, w * 0.004);
  const bridge = Math.max(2, Math.round(h * 0.004));
  const runs = [];
  let start = -1, gap = 0;
  for (let y = 0; y < h; y++) {
    if (rows[y] > thr) { if (start < 0) start = y; gap = 0; }
    else if (start >= 0 && ++gap > bridge) { runs.push({ a: start, b: y - gap + 1 }); start = -1; gap = 0; }
  }
  if (start >= 0) runs.push({ a: start, b: h });
  let real = runs.filter((r) => r.b - r.a > h * 0.012);
  if (!real.length) return [];

  // thin runs (the marks of a line that are separated from it by a blank row) belong to the nearer line. Where most lines touch,
  // the runs are several lines tall: the spacing of the lines is then the measure (a running head is no line's marks)
  const rhythm = periodicPitch(rows, h);
  const typical = Math.min(median(real.map((r) => r.b - r.a)), rhythm || Infinity);
  const merged = [];
  for (let i = 0; i < real.length; i++) {
    const r = { ...real[i] };
    if (r.b - r.a < typical * 0.5) {
      const prev = merged[merged.length - 1];
      const next = real[i + 1];
      const gPrev = prev ? r.a - prev.b : Infinity;
      const gNext = next ? next.a - r.b : Infinity;
      if (Math.min(gPrev, gNext) < typical * 0.6) {
        if (gPrev <= gNext) prev.b = r.b;
        else real[i + 1] = { a: r.a, b: next.b };
        continue;
      }
    }
    merged.push(r);
  }
  real = merged;
  if (process.env.SEG_DEBUG) console.error('runs', runs.map((r) => `${r.a}-${r.b}`).join(' '), '| merged', real.map((r) => `${r.a}-${r.b}`).join(' '), '| typical', typical);

  // typical line pitch: merged lines are taller than single ones, so look at the lower end of the run heights
  const heights = real.map((r) => r.b - r.a);
  const low = [...heights].sort((x, y) => x - y)[Math.floor((heights.length - 1) * 0.3)];
  const pitch = rhythm || median(heights.filter((v) => v <= low * 1.25)) || low;
  const profile = smooth(rows, Math.max(1, Math.round(pitch * 0.06)));
  const out = [];
  for (const { a, b } of real) {
    const parts = Math.round((b - a) / pitch);
    if (parts < 2) { out.push({ y0: a, y1: b }); continue; }
    // a title page (lines of many sizes, no regular spacing): a run that holds fewer lines than its height says (a title set large)
    // is cut between its lines only. A page of the book keeps its cuts: the short last line of a paragraph is a weak core there
    const cores = rhythm ? null : lineCores(profile, a, b, pitch, thr);
    if (cores && cores.length < parts) {
      let from = a;
      for (let k = 1; k < cores.length; k++) {
        let best = cores[k - 1];
        for (let y = cores[k - 1]; y <= cores[k]; y++) if (profile[y] < profile[best]) best = y;
        out.push({ y0: from, y1: best });
        from = best;
      }
      out.push({ y0: from, y1: b });
      continue;
    }
    let from = a;
    for (let p = 1; p < parts; p++) {
      const expect = a + ((b - a) * p) / parts;
      const win = Math.round(pitch * 0.3);
      let best = Math.round(expect), bestV = Infinity;
      for (let y = Math.max(from + 4, Math.round(expect) - win); y <= Math.min(b - 4, Math.round(expect) + win); y++) {
        // quietest row wins; on a flat stretch the one nearest to where the boundary should be
        if (profile[y] < bestV - 1e-9 || (Math.abs(profile[y] - bestV) <= 1e-9 && Math.abs(y - expect) < Math.abs(best - expect))) { bestV = profile[y]; best = y; }
      }
      out.push({ y0: from, y1: best });
      from = best;
    }
    out.push({ y0: from, y1: b });
  }
  // a page of the book: a slice under half a line's height that touches a line is part of it (the marks above a line, the tails
  // below one, cut off where the scan left a pale row). Read alone, the reader makes a whole line of words up from it
  if (rhythm) {
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      if (s.y1 - s.y0 >= pitch * 0.5) continue;
      const up = i > 0 && s.y0 - out[i - 1].y1 <= 2 ? out[i - 1] : null;
      const down = i + 1 < out.length && out[i + 1].y0 - s.y1 <= 2 ? out[i + 1] : null;
      if (!up && !down) continue; // a line of its own (a running head, a page number)
      // its ink runs on into the line on the side where its edge rows are inked
      const edge = (y) => profile[Math.min(Math.max(y, 0), h - 1)];
      const top = edge(s.y0) + edge(s.y0 + 1) + edge(s.y0 + 2);
      const bottom = edge(s.y1 - 1) + edge(s.y1 - 2) + edge(s.y1 - 3);
      const into = !up || (down && bottom > top) ? down : up;
      into.y0 = Math.min(into.y0, s.y0);
      into.y1 = Math.max(into.y1, s.y1);
      out.splice(i--, 1);
    }
  }
  const lines = out.map((l) => ({ ...l, ...inkExtent(gray, w, l.y0, l.y1, inkBelow) }));
  // no regular line spacing over four lines or more: a cover or title page, its lines set in many sizes (a page of one or two lines
  // has no spacing to measure)
  lines.titlePage = !rhythm && real.length >= 4;
  return lines;
}

/**
 * The cores of the lines in the run a..b (rows of the smoothed profile): the rows where a line's letters sit on their baseline, the
 * densest of the line. A peak is a line of its own when it is 30% of the run's densest row or more and a quiet valley (half of it or
 * less) parts it from every stronger line, or when blank rows part it from them (a short word under a title). The vowel marks over
 * a large title and the tails of its letters make weaker peaks, not parted by a valley that deep. Measured on a title page: marks
 * 0.24 of the title's core, a valley at 0.35 of the marks; three small lines set tight: 0.58 to 1, valleys under 0.05.
 */
function lineCores(profile, a, b, pitch, blank) {
  const k = Math.max(2, Math.round(pitch * 0.2));
  const peaks = [];
  for (let y = a; y < b; y++) {
    let top = true;
    for (let j = Math.max(a, y - k); j <= Math.min(b - 1, y + k) && top; j++) if (profile[j] > profile[y] || (profile[j] === profile[y] && j < y)) top = false;
    if (top && profile[y] > 0) peaks.push(y);
  }
  const most = Math.max(...peaks.map((y) => profile[y]));
  const cores = [];
  for (const p of [...peaks].sort((x, y) => profile[y] - profile[x])) {
    const parted = cores.every((q) => {
      let low = Infinity;
      for (let y = Math.min(p, q); y <= Math.max(p, q); y++) low = Math.min(low, profile[y]);
      return low <= blank || (profile[p] >= most * 0.3 && low <= profile[p] * 0.5);
    });
    if (parted) cores.push(p);
  }
  return cores.sort((x, y) => x - y);
}

/**
 * Line spacing from the regular repetition of the ink profile (autocorrelation): the smallest lag that repeats about as well as the
 * best one. Robust to short lines, headers and footnotes, unlike the heights of the runs. 0 when the page has no clear rhythm.
 */
function periodicPitch(rows, h) {
  const n = rows.length;
  const mean = rows.reduce((a, b) => a + b, 0) / n;
  const p = rows.map((v) => v - mean);
  const r0 = p.reduce((a, v) => a + v * v, 0);
  if (!r0) return 0;
  const lo = Math.max(8, Math.round(h * 0.012));
  const hi = Math.min(n - 2, Math.round(h * 0.1));
  const r = [];
  let best = 0;
  for (let lag = lo; lag <= hi; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += p[i] * p[i + lag];
    r[lag] = sum / r0;
    if (r[lag] > best) best = r[lag];
  }
  if (best < 0.12) return 0;
  const peak = (lag) => r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1];
  let pitch = 0;
  for (let lag = lo + 1; lag < hi; lag++) if (r[lag] >= best * 0.85 && peak(lag)) { pitch = lag; break; }
  // lines set close, their vowel marks touching, repeat best every second line: a clear peak near half that lag is the line spacing
  // (measured: 67 at 0.84 of the peak at 149; a page with distinct lines has no peak at all below its spacing)
  for (let lag = Math.max(lo + 1, Math.round(pitch * 0.4)); pitch && lag <= Math.round(pitch * 0.6); lag++) {
    if (r[lag] >= best * 0.6 && peak(lag)) return lag;
  }
  return pitch;
}

function inkExtent(gray, w, y0, y1, inkBelow) {
  const cols = new Uint16Array(w);
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) if (gray[y * w + x] < inkBelow) cols[x]++;
  // ignore specks: a column needs a couple of dark pixels
  let x0 = 0;
  let x1 = w;
  while (x0 < w && cols[x0] < 2) x0++;
  while (x1 > x0 && cols[x1 - 1] < 2) x1--;
  return { x0, x1 };
}

/**
 * Row of the thin horizontal rule that separates footnotes from the text: in the lower part of the page, outside every text line,
 * a dark run across at least `minFrac` of the width. Null when there is none.
 * The run is followed a row up or down as it goes (a page scanned askew: a rule half the width wide drops ten rows), its breaks
 * bridged. A rule printed close above the first note joins that note's line box: the top quarter of a line is searched too, where
 * no stroke of a letter runs across.
 */
export function findFootnoteRule(gray, w, h, lines, { minFrac = 0.15, inkBelow = 140 } = {}) {
  const need = w * minFrac;
  const ink = (x, y) => y >= 0 && y < h && gray[y * w + x] < inkBelow;
  // the end of the dark run that starts at (x, y), drifting at most 3 rows plus 1 in 25 columns from y
  const runEnd = (x, y) => {
    let cy = y;
    let end = x;
    for (let xx = x + 1, gap = 0; xx < w && gap <= 3; xx++) {
      const room = 3 + (xx - x) / 25;
      if (ink(xx, cy)) gap = 0;
      else if (ink(xx, cy - 1) && y - cy + 1 <= room) { cy--; gap = 0; } else if (ink(xx, cy + 1) && cy + 1 - y <= room) { cy++; gap = 0; } else { gap++; continue; }
      end = xx;
    }
    return end;
  };
  for (let y = Math.round(h * 0.4); y < h; y++) {
    const line = lines.find((l) => y >= l.y0 && y < l.y1);
    if (line && y >= line.y0 + (line.y1 - line.y0) * 0.25) continue;
    for (let x = 0; x < w - need; x++) {
      if (!ink(x, y)) continue;
      const end = runEnd(x, y);
      if (end - x + 1 >= need) return y;
      x = end;
    }
  }
  return null;
}

/**
 * Does the strip y0..y1 contain a drawn horizontal rule (a dark run across at least `minFrac` of the width)? Letters of a line never
 * form a dark run that long; a running header often has one between its title and the page number.
 */
/**
 * A page's first line is its running head (title, page number and a rule between or under them): it holds a rule of 15% of
 * its own width or more, its breaks bridged (a scanned rule is printed in pieces). Measured: the heads' rules are 17-77% of their
 * line; a kashida drawn out in a line of verse stays far shorter.
 */
export function isHeadLine(gray, w, h, boxes) {
  if (boxes.length <= 3 || boxes[0].y1 >= h * 0.2) return false;
  splitHeadFromLine(gray, w, boxes);
  const b = boxes[0];
  return hasRule(gray, w, b.y0, b.y1) || ruleRow(gray, w, b) !== null || dottedRule(gray, w, b);
}

/** The row of a rule of 15% of the box's width or more, its breaks bridged (a scanned rule is printed in pieces); null if none. */
function ruleRow(gray, w, b) {
  const need = (b.x1 - b.x0) * 0.15;
  for (let y = b.y0; y < b.y1; y++) {
    let start = -1;
    let gap = 0;
    for (let x = b.x0; x < b.x1; x++) {
      if (gray[y * w + x] < 140) {
        if (start < 0) start = x;
        gap = 0;
        if (x - start + 1 >= need) return y;
      } else if (start >= 0 && ++gap > 3) { start = -1; gap = 0; }
    }
  }
  return null;
}

/**
 * A dotted rule: eight dots or more, none longer than 14 px, a few pixels apart, along 10% of the box's width or more, with the rows a
 * little above and below it nearly empty there (letters reach up and down; a rule stands alone), and words beside it over 20% of
 * the width or more (a row of dots alone is a separator, not a head).
 */
function dottedRule(gray, w, b) {
  const need = (b.x1 - b.x0) * 0.1;
  const ink = (x, y) => y >= b.y0 && y < b.y1 && gray[y * w + x] < 140;
  const quiet = (x0, x1, y) => {
    let n = 0;
    for (const yy of [y - 6, y + 7]) for (let x = x0; x <= x1; x++) if (ink(x, yy)) n++;
    return n < (x1 - x0) * 0.08;
  };
  const besides = (x0, x1) => {
    let cols = 0;
    for (let x = b.x0; x < b.x1; x++) {
      if (x >= x0 && x <= x1) continue;
      for (let y = b.y0; y < b.y1; y++) if (gray[y * w + x] < 140) { cols++; break; }
    }
    return cols >= (b.x1 - b.x0) * 0.2;
  };
  for (let y = b.y0; y < b.y1; y++) {
    let start = -1;
    let last = -99;
    let dots = 0;
    let run = 0;
    for (let x = b.x0; x < b.x1; x++) {
      if (!(ink(x, y) || ink(x, y + 1))) continue;
      if (x - last > 12) { start = x; dots = 0; run = 0; }
      if (x - last > 1) { dots++; run = 0; }
      run++;
      last = x;
      if (run > 14) { start = -1; last = -99; continue; }
      if (dots >= 8 && x - start + 1 >= need && quiet(start, x, y) && besides(start, x)) return true;
    }
  }
  return false;
}

/**
 * A head whose rule the marks of the first line touch comes out of the line finder as one tall line: when the first line is far
 * taller than the others and holds a rule in its upper part, it is cut at the emptiest row under the rule.
 */
function splitHeadFromLine(gray, w, boxes) {
  const b = boxes[0];
  const hs = boxes.slice(1).map((x) => x.y1 - x.y0).sort((p, q) => p - q);
  const typical = hs[Math.floor(hs.length / 2)] || 0;
  if (!typical || b.y1 - b.y0 < typical * 1.3) return;
  const top = { ...b, y1: b.y0 + Math.round((b.y1 - b.y0) * 0.5) };
  const ry = ruleRow(gray, w, top);
  if (ry === null) return;
  let best = -1;
  let bestInk = Infinity;
  for (let y = ry + 3; y < b.y0 + (b.y1 - b.y0) * 0.65; y++) {
    let n = 0;
    for (let x = b.x0; x < b.x1; x++) if (gray[y * w + x] < 140) n++;
    if (n < bestInk) { bestInk = n; best = y; }
  }
  if (best < 0) return;
  boxes.splice(0, 1, { ...b, y1: best }, { ...b, y0: best });
}

export function hasRule(gray, w, y0, y1, { minFrac = 0.22, inkBelow = 140 } = {}) {
  const need = w * minFrac;
  for (let y = y0; y < y1; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] < inkBelow) { if (++run >= need) return true; } else run = 0;
    }
  }
  return false;
}


/**
 * A line that opens with an ornament (❋, a flower set before each item of a list): the reader cannot read it and makes letters of it
 * ("مِّمَّا حفظ", ":* التحق") or drops it and spoils the word after it. Measured on its first blob of ink (its right end, the text
 * being right to left), specks skipped: about as wide as high, under half the line's height, dense (a word fills a fifth of its box
 * at most), apart from the word after it, and its petals: going round its centre the ink is met 7 times or more, where a round
 * letter or digit (ه, ٥) is met once or twice.
 * @returns {number|null} the column the rest of the line starts after (the line is read up to it), or null
 */
export function lineOrnament(gray, w, h, box, { inkBelow = 140 } = {}) {
  const { y0, y1 } = box;
  const lineH = y1 - y0;
  const ink = (x, y) => gray[y * w + x] < inkBelow;
  const colInk = (x) => { for (let y = y0; y < y1; y++) if (ink(x, y)) return true; return false; };
  const minGap = Math.max(3, Math.round(lineH * 0.08));
  let x = box.x1 - 1;
  for (let tries = 0; tries < 3; tries++) {
    while (x >= box.x0 && !colInk(x)) x--;
    if (x < box.x0) return null;
    const c1 = x;
    let c0 = x;
    let blank = 0;
    while (x >= box.x0 && blank < minGap) { if (colInk(x)) { blank = 0; c0 = x; } else blank++; x--; }
    let gap = blank;
    while (x >= box.x0 && !colInk(x)) { gap++; x--; }
    // its rows: the run of inked rows holding most of its ink (a scan that broke it into petals leaves scraps above it)
    const rowInk = [];
    for (let y = y0; y < y1; y++) { let c = 0; for (let xx = c0; xx <= c1; xx++) if (ink(xx, y)) c++; rowInk.push(c); }
    const slack = Math.max(2, Math.round(lineH * 0.05));
    let r0 = y1;
    let r1 = y0;
    let fill = 0;
    for (let k = 0; k < rowInk.length;) {
      if (!rowInk[k]) { k++; continue; }
      let e = k;
      let sum = 0;
      for (let blank = 0, j = k; j < rowInk.length && blank <= slack; j++) { if (rowInk[j]) { e = j; blank = 0; sum += rowInk[j]; } else blank++; }
      if (sum > fill) { fill = sum; r0 = y0 + k; r1 = y0 + e; }
      k = e + 1;
    }
    const bw = c1 - c0 + 1;
    if (Math.max(bw, r1 - r0 + 1) < lineH * 0.12) continue; // a speck of dust before the line
    // taller than wide: scraps of a letter's marks lie close above it. It is square: the square holding the most ink is it
    if (r1 - r0 + 1 > bw * 1.25) {
      const side = Math.round(bw * 1.05);
      let top = r0;
      let most = -1;
      for (let a = r0; a + side - 1 <= r1; a++) {
        let sum = 0;
        for (let y = a; y < a + side; y++) sum += rowInk[y - y0];
        if (sum > most) { most = sum; top = a; }
      }
      // what lies outside it is scraps (a tenth of the ink or so), not most of a tall mark (an ornate bracket ﴿)
      if (most < fill * 0.8) return null;
      r0 = top;
      r1 = top + side - 1;
      while (r0 < r1 && !rowInk[r0 - y0]) r0++;
      while (r1 > r0 && !rowInk[r1 - y0]) r1--;
      fill = most;
    }
    const bh = r1 - r0 + 1;
    if (bw < lineH * 0.2 || bw / bh < 0.8 || bw / bh > 1.25 || bh > lineH * 0.55 || fill / (bw * bh) < 0.25 || gap < bw * 0.4) return null;
    const cx = (c0 + c1) / 2;
    const cy = (r0 + r1) / 2;
    const petals = [0.7, 0.85].map((f) => {
      const A = 96;
      const on = Array.from({ length: A }, (_, k) => {
        const px = Math.round(cx + Math.cos((2 * Math.PI * k) / A) * f * (bw / 2));
        const py = Math.round(cy + Math.sin((2 * Math.PI * k) / A) * f * (bh / 2));
        return px >= 0 && px < w && py >= 0 && py < h && ink(px, py);
      });
      return on.filter((v, k) => v && !on[(k + A - 1) % A]).length;
    });
    return Math.min(...petals) >= 7 ? c0 - Math.floor(gap / 2) : null;
  }
  return null;
}

/**
 * A line as the reader is to see it: rows [y0, y1) and columns [left, right) of the page, with the white margin above and below
 * the line that the reader needs, but without the pieces of the lines next to it that reach into that margin (the tails of the
 * line above cut off at the margin's edge are read as words of their own, before the line's first word). A piece of ink that
 * never enters the line's own rows is another line's.
 * @returns {Uint8Array} grey pixels, (right - left) x (y1 - y0)
 */
export function isolateLine(gray, w, box, left, right, y0, y1, { inkBelow = 140 } = {}) {
  const cw = right - left;
  const ch = y1 - y0;
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) out.set(gray.subarray((y0 + y) * w + left, (y0 + y) * w + right), y * cw);
  const ink = new Uint8Array(cw * ch);
  for (let i = 0; i < ink.length; i++) ink[i] = out[i] < inkBelow ? 1 : 0;
  const { labels, comps } = labelComponents(ink, cw, ch);
  const own0 = box.y0 - y0;
  const own1 = box.y1 - y0;
  const foreign = new Set(comps.filter((c) => c.y1 < own0 || c.y0 >= own1).map((c) => c.id));
  if (!foreign.size) return out;
  for (let i = 0; i < out.length; i++) if (foreign.has(labels[i])) out[i] = 255;
  return out;
}

/**
 * The wide gaps inside a line: between the two halves of a verse, between two notes set on one line. The reader reads one side
 * of such a gap and drops the other, so each side is read on its own. A gap is a run of blank columns wider than the line is high
 * (a space between words, even in justified text, is far narrower).
 * @returns {{x0:number, x1:number}[]} from the right of the line to its left
 */
export function lineGaps(gray, w, box, left = box.x0, right = box.x1, { inkBelow = 140 } = {}) {
  const lineH = box.y1 - box.y0;
  const from = Math.max(left, box.x0);
  const to = Math.min(right, box.x1);
  const inked = (x) => { for (let y = box.y0; y < box.y1; y++) if (gray[y * w + x] < inkBelow) return true; return false; };
  const gaps = [];
  const parts = []; // the inked columns between the gaps
  let start = -1;
  let inkCols = 0;
  for (let x = from; x < to; x++) {
    if (!inked(x)) { if (start < 0) start = x; continue; }
    if (start > from && x - start >= Math.max(lineH * 0.8, 40)) { gaps.push({ x0: start, x1: x - 1 }); parts.push(inkCols); inkCols = 0; }
    start = -1;
    inkCols++;
  }
  parts.push(inkCols);
  // both sides hold words, not a speck of the scan at the page's edge
  const keep = gaps.filter((g, i) => parts.slice(0, i + 1).reduce((a, b) => a + b, 0) >= lineH * 1.5 && parts.slice(i + 1).reduce((a, b) => a + b, 0) >= lineH * 1.5);
  return keep.sort((a, b) => b.x1 - a.x1);
}

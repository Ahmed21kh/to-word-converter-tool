// Scan cleaning for OCR: binarise, find the decorative page frame and crop to its inside, optionally
// strip diacritics (tashkeel) so the OCR engine sees plain letter shapes.
// Works on 8-bit grayscale buffers (0 = black ink, 255 = white paper).
import sharp from 'sharp';

/** Otsu threshold of a grayscale image. */
export function otsu(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 7) hist[gray[i]]++; // sampled: plenty for a histogram
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i];
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * ((sumB / wB - (sum - sumB) / wF) ** 2);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

/** @returns {Uint8Array} 1 = ink */
export function toInk(gray, threshold = otsu(gray)) {
  const ink = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) ink[i] = gray[i] <= threshold ? 1 : 0;
  return ink;
}

/** Longest run of ink in [from,to) allowing gaps of up to `gap` pixels. */
function longestRun(get, from, to, gap = 3) {
  let best = 0;
  let start = -1;
  let last = -1;
  for (let i = from; i < to; i++) {
    if (get(i)) {
      if (start < 0) start = i;
      last = i;
    } else if (start >= 0 && i - last > gap) {
      best = Math.max(best, last - start + 1);
      start = -1;
    }
  }
  if (start >= 0) best = Math.max(best, last - start + 1);
  return best;
}

/** Group consecutive indices into clusters [{from,to}] */
function clusters(indices) {
  const out = [];
  for (const i of indices) {
    const last = out[out.length - 1];
    if (last && i - last.to <= 2) last.to = i;
    else out.push({ from: i, to: i });
  }
  return out;
}

/**
 * Find the decorative frame (long horizontal/vertical rules) and return the box inside it.
 * Returns null when the page has no clear frame.
 */
export function findFrameInterior(gray, w, h, opts = {}) {
  // thin rules are anti-aliased to light grey when a 600 dpi scan is reduced: use a generous threshold
  const ink = toInk(gray, Math.max(otsu(gray), 185));
  const rowsLong = [];
  for (let y = 0; y < h; y++) {
    // an ornament on the top/bottom rule splits it in two, so a long half is enough
    if (longestRun((x) => ink[y * w + x], 0, w) >= w * 0.2) rowsLong.push(y);
  }
  const colsLong = [];
  for (let x = 0; x < w; x++) {
    if (longestRun((y) => ink[y * w + x], 0, h) >= h * 0.4) colsLong.push(x);
  }
  const rc = clusters(rowsLong);
  const cc = clusters(colsLong);
  const top = rc.filter((c) => c.to < h * 0.35).pop();
  const bottom = rc.find((c) => c.from > h * 0.65);
  const left = cc.filter((c) => c.to < w * 0.35).pop();
  const right = cc.find((c) => c.from > w * 0.65);
  if (opts.debug) console.log('rows', rc.map((c) => `${c.from}-${c.to}`).join(' '), '| cols', cc.map((c) => `${c.from}-${c.to}`).join(' '), '| top', !!top, 'bottom', !!bottom, 'left', !!left, 'right', !!right);
  if (!top || !bottom || !left || !right) return null;
  const pad = Math.round(w * 0.006);
  const box = { x0: left.to + pad, x1: right.from - pad, y0: top.to + pad, y1: bottom.from - pad };
  if (box.x1 - box.x0 < w * 0.4 || box.y1 - box.y0 < h * 0.4) return null;
  return box;
}

/**
 * Split a framed book page into the text inside the frame and the margin strips above / below it
 * (running header with the page number, footer). Strips without ink are left out. null = no frame found.
 */
export function frameBands(gray, w, h) {
  const body = findFrameInterior(gray, w, h);
  if (!body) return null;
  const pad = Math.round(w * 0.006);
  const inkRows = (y0, y1) => {
    const rows = [];
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
      let n = 0;
      for (let x = 0; x < w; x++) if (gray[y * w + x] < 110) n++;
      if (n >= 2) rows.push(y);
    }
    return rows;
  };
  const strip = (y0, y1) => {
    const rows = inkRows(y0, y1);
    if (rows.length < Math.max(6, h * 0.003)) return null;
    const margin = Math.round(h * 0.006);
    return { x0: 0, x1: w, y0: Math.max(0, rows[0] - margin), y1: Math.min(h, rows[rows.length - 1] + margin + 1) };
  };
  return { body, top: strip(0, body.y0 - pad * 2), bottom: strip(body.y1 + pad * 2, h) };
}

/**
 * Paints out the straight rules of a title or copyright page (the sides and top of its frame, a box drawn around its text), in
 * place. A frame's sides hold ink on every row, so a line finder sees the whole page as one line. No stroke of Arabic text is
 * that long: an alif is about one line tall, a kashida far shorter than half the page.
 */
export function eraseRules(gray, w, h, { inkBelow = 140, longV = Math.round(h * 0.06), longH = Math.round(w * 0.5) } = {}) {
  const paint = (idx) => { for (const i of idx) gray[i] = 255; };
  const runs = (count, len, at, long) => {
    for (let a = 0; a < count; a++) {
      let run = [];
      for (let b = 0; b <= len; b++) {
        const i = b < len ? at(a, b) : -1;
        if (i >= 0 && gray[i] < inkBelow) run.push(i);
        else { if (run.length >= long) paint(run); run = []; }
      }
    }
  };
  // both directions are measured before anything is painted: a rule that crosses another must not be cut in two
  const before = Uint8Array.from(gray);
  runs(w, h, (x, y) => y * w + x, longV);
  const afterV = Uint8Array.from(gray);
  gray.set(before);
  runs(h, w, (y, x) => y * w + x, longH);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.max(gray[i], afterV[i]);
  return gray;
}

/**
 * Paints out, in place, a thin rule down the page (the edge of the scanned page, the binding), straightened with the page: a rule
 * of a pixel or two that the turn broke into a staircase of short pieces, each much taller than it is wide. No stroke of type is
 * that thin for its height (an alif is a fifth as wide as it is tall), and a rule along the side puts ink on every row, so a line
 * finder sees the page as one block and the gap before the rule as the middle of a verse.
 * @returns {number} how many pieces were painted out
 */
export function eraseThinRules(gray, w, h, { inkBelow = 200 } = {}) {
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = gray[i] < inkBelow ? 1 : 0;
  const { labels, comps } = labelComponents(ink, w, h);
  const kill = new Set(comps.filter((c) => c.h >= h * 0.03 && c.w <= c.h * 0.06).map((c) => c.id));
  if (kill.size) for (let i = 0; i < labels.length; i++) if (kill.has(labels[i])) gray[i] = 255;
  return kill.size;
}

/**
 * Paints out, in place, the stamp an uploader set in the top left corner of a scanned book's pages ("رفع عبد الرحمن النجدي أسكنه
 * الله الفردوس www.moswarat.com", on the chapter openings of the books of that site): a small block of a few short lines, the first
 * ink of the page, with nothing printed beside it. Read, it was a line of nonsense joined to the chapter's heading.
 * A book's own text is never set there: an Arabic line that does not fill the measure ends at the right, a heading is
 * centred, a page number up there is narrower and has the running title beside it, and a block of text set there (an address at
 * the head of a letter) has no short first word centred over its other lines, as the stamp has.
 * @returns {object|null} the box painted out, or null when the page has no stamp
 */
export function eraseStamp(gray, w, h, { inkBelow = 140 } = {}) {
  // the edges of the scan (the shadow of the page's edge, a strip of the next page) are no part of it
  const xa = Math.round(w * 0.03);
  const xb = Math.round(w * 0.97);
  // the bands of ink at the top of the page, apart from one another by a white row or more, with how far each reaches
  const bands = [];
  let cur = null;
  for (let y = 0; y < Math.round(h * 0.2); y++) {
    let x0 = xb;
    let x1 = -1;
    let c = 0;
    for (let x = xa; x < xb; x++) if (gray[y * w + x] < inkBelow) { c++; if (x < x0) x0 = x; x1 = x; }
    if (c > 2) { // a speck of dust is no line
      if (!cur) bands.push(cur = { y0: y, y1: y, x0, x1 });
      cur.y1 = y;
      cur.x0 = Math.min(cur.x0, x0);
      cur.x1 = Math.max(cur.x1, x1);
    } else {
      cur = null;
      if (bands.length && y - bands[bands.length - 1].y1 > h * 0.03) break;
    }
  }
  // the stamp's lines, from the top, as far as they keep to the corner. A heading set close under it can run into its last lines
  // (no white row between them): of such a band, the part at the left of a wide white gap, where the stamp's lines stand, is the
  // stamp's; a heading's words are never that far apart
  const lines = [];
  const pieces = [];
  for (const b of bands) {
    if (b.y1 - b.y0 < 3 && b.x1 - b.x0 < w * 0.02) continue; // a speck
    if (b.x0 < w * 0.04 || (lines.length && b.y0 - (pieces.at(-1) || lines.at(-1)).y1 > h * 0.03)) break;
    if (b.x1 <= w * 0.43) { (pieces.length ? pieces : lines).push(b); continue; }
    // a speck of the scan out on the rows of a line of the stamp: the line is what stands at the left of the gap before it
    const left = !pieces.length && leftOfGap(gray, w, b, Math.round(w * 0.04), inkBelow);
    if (left && left.x1 <= w * 0.43 && inkIn(gray, w, { ...b, x0: left.x1 + 1 }, inkBelow) < (b.y1 - b.y0 + 1) * 3) {
      lines.push({ ...b, x1: left.x1 });
      continue;
    }
    if (lines.length < 2) break;
    const x0 = Math.min(...lines.map((l) => l.x0));
    const x1 = Math.max(...lines.map((l) => l.x1));
    const part = leftOfGap(gray, w, b, Math.round(w * 0.04), inkBelow);
    if (!part || Math.abs(part.x0 - x0) > w * 0.05 || part.x1 > x1 + w * 0.03) break;
    pieces.push(part);
  }
  if (lines.length < 2 || lines[0].y0 > h * 0.1) return null;
  const top = lines[0].y0;
  const bottom = lines.at(-1).y1;
  const x0 = Math.min(...lines.map((b) => b.x0));
  const x1 = Math.max(...lines.map((b) => b.x1));
  if (bottom - top < h * 0.03 || bottom - top > h * 0.13 || x1 - x0 < w * 0.12 || x1 - x0 > w * 0.38) return null;
  // the stamp's own shape: one short word ("رفع") centred over its wider lines
  const k = lines.findIndex((b) => b.x1 - b.x0 > (x1 - x0) * 0.5);
  if (k < 1) return null;
  const hx0 = Math.min(...lines.slice(0, k).map((b) => b.x0));
  const hx1 = Math.max(...lines.slice(0, k).map((b) => b.x1));
  if (hx1 - hx0 > (x1 - x0) * 0.35 || Math.abs((hx0 + hx1) / 2 - (x0 + x1) / 2) > (x1 - x0) * 0.15) return null;
  const pad = Math.round(h * 0.004);
  const paint = (r) => {
    const box = { x0: Math.max(0, r.x0 - pad), x1: Math.min(w, r.x1 + pad + 1), y0: Math.max(0, r.y0 - pad), y1: Math.min(h, r.y1 + pad + 1) };
    for (let y = box.y0; y < box.y1; y++) gray.fill(255, y * w + box.x0, y * w + box.x1);
    return box;
  };
  for (const r of pieces) paint(r);
  return paint({ x0, x1, y0: top, y1: bottom });
}

/** The ink of a band of rows at the left of its first white gap at least `minGap` wide: its box, or null when it has no such gap. */
/** How many inked pixels the box holds. */
function inkIn(gray, w, b, inkBelow) {
  let n = 0;
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (gray[y * w + x] < inkBelow) n++;
  return n;
}

function leftOfGap(gray, w, band, minGap, inkBelow) {
  const cols = new Uint8Array(w);
  const rows = [];
  for (let x = band.x0; x <= band.x1; x++) for (let y = band.y0; y <= band.y1; y++) if (gray[y * w + x] < inkBelow) { cols[x] = 1; break; }
  let white = 0;
  for (let x = band.x0; x <= band.x1; x++) {
    if (cols[x]) { white = 0; continue; }
    if (++white < minGap) continue;
    const x1 = x - white;
    for (let y = band.y0; y <= band.y1; y++) {
      for (let k = band.x0; k <= x1; k++) if (gray[y * w + k] < inkBelow) { rows.push(y); break; }
    }
    return { x0: band.x0, x1, y0: rows[0], y1: rows.at(-1) };
  }
  return null;
}

/**
 * A cover's lettering, dark on white whatever its colours: gold or white letters on a dark ground and dark letters on a light one
 * alike. Each pixel is measured against the ground around it (the median of its block, blended between blocks): what stands out
 * from the ground, lighter or darker, is ink. A whole page turned over (the earlier way) lost the light letters of a cover whose
 * dark ground is only part of it.
 */
export function inkFromGround(gray, w, h, { B = 96 } = {}) {
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const bg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const hist = new Uint32Array(256);
      let n = 0;
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y++) {
        for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x++) { hist[gray[y * w + x]]++; n++; }
      }
      let acc = 0;
      for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= n / 2) { bg[by * bw + bx] = k; break; } }
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, y / B - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, x / B - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const tx = fx - x0;
      const ground = (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx) * (1 - ty) + (bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx) * ty;
      const d = Math.abs(gray[y * w + x] - ground);
      out[y * w + x] = Math.max(0, Math.min(255, Math.round(255 - (d - 18) * 3)));
    }
  }
  return out;
}

/**
 * Make a page crop easy to read for a vision model: flatten uneven paper tone / shadows (evenPaper), turn a page photographed
 * or scanned askew straight (deskew), and sharpen thin strokes and dots slightly.
 * Returns a JPEG buffer. Nothing is binarised and nothing is smoothed away: dots and diacritics keep their grey edges (a median
 * filter, the usual cure for a phone camera's noise, erases a fatha or a sukun at 200 dpi).
 */
export async function enhanceForAi(gray, w, h, { straight = false } = {}) {
  // `straight`: the crop has been through straighten already (the hybrid reading looks at it before deciding who reads it)
  const g = straight ? gray : (await straighten(gray, w, h)).gray;
  return sharp(Buffer.from(g.buffer, g.byteOffset, g.length), { raw: { width: w, height: h, channels: 1 } })
    .sharpen({ sigma: 0.8 })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** Even paper, then straight lines: the page as the AI readers and the line geometry see it, before sharpening. */
export async function straighten(gray, w, h) {
  return deskew(evenPaper(gray, w, h).gray, w, h);
}

/**
 * Even paper: divide each pixel by a block-wise estimate of the paper tone (the shadow of a phone or of the book's spine, a page
 * yellowed at its edges), then stretch the contrast so ink is black and paper white.
 * The estimate is the tone a tenth of a block's pixels are darker than, never under 90: in a block of dense type that falls in the
 * ink, so whatever is lighter than it turns white. On a clean scan that only trims the grey fringe off black strokes. A faded
 * print, though, is grey ink (the strokes 90-150, not black): it lost half its strokes that way and the reader saw broken
 * letters (a line of نزل بها على جبريل أعادها ثلاثا وقال هى لك read as آذانشا ثُلثنا وَقَالَ هَسِيَ آلَكَ). When the division keeps
 * under 80% of a page's dark pixels (a clean scan keeps 85-90%, a faded one 55-70%), the page is divided by its paper's own tone
 * instead (the tone a tenth of a block's pixels are lighter than), which keeps every stroke, and its grey ink is darkened.
 * Under 40% kept is a cover or a picture (broad dark grounds, not strokes), left as it was.
 * `spread`: how far apart the paper tones of the page were (0-255; a flat scan stays under 20, a phone photo is 40 and up).
 * `faint`: the page was read as faded print.
 * @returns {{gray:Uint8Array, spread:number, faint:boolean}}
 */
export function evenPaper(gray, w, h) {
  const B = 24;
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const trim = new Float32Array(bw * bh);
  const paper = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const hist = new Uint32Array(256);
      let n = 0;
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y++) {
        for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x++) { hist[gray[y * w + x]]++; n++; }
      }
      let acc = 0;
      let v = -1;
      let u = 255;
      for (let k = 255; k >= 0; k--) {
        acc += hist[k];
        if (v < 0 && acc >= n * 0.1) v = k;
        if (acc >= n * 0.9) { u = k; break; }
      }
      trim[by * bw + bx] = Math.max(u, 90);
      paper[by * bw + bx] = Math.max(v, 90);
    }
  }
  let out = divideBy(gray, w, h, trim, B);
  let dark = 0;
  let kept = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] < 128) { dark++; if (out[i] < 128) kept++; }
  const faint = dark > gray.length * 0.01 && kept >= dark * 0.4 && kept < dark * 0.8;
  if (faint) out = divideBy(gray, w, h, paper, B);
  // contrast stretched between the 1st and 99th percentiles, but black is never set lighter than ink: on a title page the ink is
  // under 1% of the page, the 1st percentile falls in the faint print showing through from the back of the leaf, and stretching
  // to it turned that print black (measured: ink 0.6-0.8% of a title page, the show-through at 200-240)
  const hist = new Uint32Array(256);
  for (let i = 0; i < out.length; i++) hist[out[i]]++;
  const at = (q) => { let acc = 0; for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= out.length * q) return k; } return 255; };
  const lo = Math.min(at(0.01), 96);
  const hi = Math.max(at(0.99), lo + 64);
  // faded print: grey ink darkened, the paper's specks and the grey fringe of the strokes (above 215) set white
  const lut = new Uint8Array(256);
  for (let k = 0; k < 256; k++) {
    const t = Math.max(0, Math.min(1, (k - lo) / (hi - lo)));
    lut[k] = Math.round(255 * (faint ? Math.min(1, (t * 255) / 215) ** 1.6 : t));
  }
  for (let i = 0; i < out.length; i++) out[i] = lut[out[i]];
  return { gray: out, spread: paperSpread(gray, w, h), faint };
}

/** Each pixel divided by the block tones (bw x bh blocks of B pixels), bilinear between the blocks' centres. */
function divideBy(gray, w, h, bg, B) {
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, y / B - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, x / B - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const tx = fx - x0;
      const paper = (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx) * (1 - ty) + (bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx) * ty;
      out[y * w + x] = Math.min(255, Math.round((gray[y * w + x] * 255) / paper));
    }
  }
  return out;
}

/**
 * How far apart the paper tones of a page are (0-255): the page in 8 x 8 cells, the paper tone of each its 95th percentile (large
 * enough cells for the text in them not to count), and the spread between the lighter and darker cells (10th to 90th percentile).
 */
export function paperSpread(gray, w, h, { cells = 8 } = {}) {
  const tones = [];
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const hist = new Uint32Array(256);
      let n = 0;
      for (let y = Math.floor((cy * h) / cells); y < Math.floor(((cy + 1) * h) / cells); y += 2) {
        for (let x = Math.floor((cx * w) / cells); x < Math.floor(((cx + 1) * w) / cells); x += 2) { hist[gray[y * w + x]]++; n++; }
      }
      if (!n) continue;
      let acc = 0;
      for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc >= n * 0.05) { tones.push(k); break; } }
    }
  }
  tones.sort((a, b) => a - b);
  return tones.length ? tones[Math.floor(tones.length * 0.9)] - tones[Math.floor(tones.length * 0.1)] : 0;
}

/**
 * The angle (degrees) the text lines of a page are tilted by: the one at which the ink, summed along rows, falls into the
 * sharpest bands. Searched within ±maxDeg on a reduced copy; 0 when the page has too little ink or no angle is clearly better
 * than none. Positive: the lines run down to the right.
 */
export function skewAngle(gray, w, h, { maxDeg = 5, step = 0.25, inkBelow = 140 } = {}) {
  const k = Math.max(1, Math.round(w / 800));
  const sw = Math.floor(w / k);
  const sh = Math.floor(h / k);
  const xs = [];
  const ys = [];
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (gray[y * k * w + x * k] < inkBelow) { xs.push(x); ys.push(y); }
  if (xs.length < 400) return 0;
  const pad = Math.ceil(sw * Math.tan((maxDeg * Math.PI) / 180)) + 1;
  const rows = new Float64Array(sh + 2 * pad);
  const score = (deg) => {
    const t = Math.tan((deg * Math.PI) / 180);
    rows.fill(0);
    for (let i = 0; i < xs.length; i++) rows[Math.round(ys[i] - xs[i] * t) + pad]++;
    let s = 0;
    for (const r of rows) s += r * r;
    return s;
  };
  const flat = score(0);
  let best = 0;
  let top = flat;
  for (let d = -maxDeg; d <= maxDeg + 1e-9; d += step) { const s = score(d); if (s > top) { top = s; best = d; } }
  for (let d = best - step; d <= best + step + 1e-9; d += step / 5) { const s = score(d); if (s > top) { top = s; best = d; } }
  return top > flat * 1.05 ? Math.round(best * 100) / 100 : 0;
}

/**
 * A page tilted by 0.3° or more is turned straight (white comes in at the corners), and kept at its size, so the lines can be
 * found and cut apart (a 2° tilt across a page is wider than a line's height). A straight page is returned as it is.
 * @returns {Promise<{gray:Uint8Array, angle:number}>}
 */
export async function deskew(gray, w, h) {
  const angle = skewAngle(gray, w, h);
  if (Math.abs(angle) < 0.3) return { gray, angle: 0 };
  const turned = await sharp(Buffer.from(gray.buffer, gray.byteOffset, gray.length), { raw: { width: w, height: h, channels: 1 } })
    .rotate(-angle, { background: { r: 255, g: 255, b: 255 } }) // turned back by the tilt
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: tw, height: th } = turned.info;
  const left = Math.max(0, Math.round((tw - w) / 2));
  const top = Math.max(0, Math.round((th - h) / 2));
  const out = await sharp(turned.data, { raw: { width: tw, height: th, channels: turned.info.channels } })
    .extract({ left, top, width: Math.min(w, tw - left), height: Math.min(h, th - top) })
    .extend({ right: Math.max(0, w - (tw - left)), bottom: Math.max(0, h - (th - top)), background: { r: 255, g: 255, b: 255 } })
    .greyscale()
    .raw()
    .toBuffer();
  return { gray: new Uint8Array(out.buffer, out.byteOffset, w * h), angle };
}

/**
 * Remove everything outside `box` (paper colour) and return the cropped gray image.
 */
export function crop(gray, w, h, box) {
  const cw = box.x1 - box.x0;
  const ch = box.y1 - box.y0;
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    out.set(gray.subarray((y + box.y0) * w + box.x0, (y + box.y0) * w + box.x0 + cw), y * cw);
  }
  return { gray: out, width: cw, height: ch };
}

// ---------------------------------------------------------------------------------------------
// Connected components + diacritics removal
// ---------------------------------------------------------------------------------------------

/** 8-connected component labelling (two-pass, union-find). Returns labels + per-component stats. */
export function labelComponents(ink, w, h) {
  const labels = new Int32Array(w * h);
  const parent = [0];
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  let next = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ink[i]) continue;
      const nb = [];
      if (x > 0 && labels[i - 1]) nb.push(labels[i - 1]);
      if (y > 0) {
        if (labels[i - w]) nb.push(labels[i - w]);
        if (x > 0 && labels[i - w - 1]) nb.push(labels[i - w - 1]);
        if (x < w - 1 && labels[i - w + 1]) nb.push(labels[i - w + 1]);
      }
      if (!nb.length) {
        labels[i] = next;
        parent.push(next);
        next++;
      } else {
        const m = Math.min(...nb);
        labels[i] = m;
        for (const n of nb) if (n !== m) union(m, n);
      }
    }
  }
  const stats = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!labels[i]) continue;
      const r = find(labels[i]);
      labels[i] = r;
      let s = stats.get(r);
      if (!s) {
        s = { id: r, x0: x, x1: x, y0: y, y1: y, area: 0 };
        stats.set(r, s);
      }
      s.area++;
      if (x < s.x0) s.x0 = x;
      if (x > s.x1) s.x1 = x;
      if (y > s.y1) s.y1 = y;
    }
  }
  return { labels, comps: [...stats.values()].map((s) => ({ ...s, w: s.x1 - s.x0 + 1, h: s.y1 - s.y0 + 1 })) };
}

const percentile = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0;
};

/**
 * Erase diacritics (tashkeel): small marks that are not round solid dots (letter dots are kept).
 * `specks`: how many of the removed marks were specks of dust or noise (a phone camera's grain), not diacritics.
 * @returns {{gray:Uint8Array, removed:number, specks:number, unit:number, bigCount:number}}
 */
export function stripDiacritics(gray, w, h, opts = {}) {
  const ink = toInk(gray, opts.threshold ?? otsu(gray));
  const { labels, comps } = labelComponents(ink, w, h);
  const big = comps.filter((c) => c.area >= 300).map((c) => c.h);
  const unit = percentile(big, 0.5) || 40; // typical word height
  const out = Uint8Array.from(gray);
  const kill = new Set();
  let specks = 0;
  for (const c of comps) {
    if (c.h > unit * 0.5 || c.w > unit * 0.9) continue; // letters / words
    if (c.area < 3) { kill.add(c.id); specks++; continue; } // specks
    const extent = c.area / (c.w * c.h);
    const aspect = Math.max(c.w / c.h, c.h / c.w);
    const isDot = extent >= (opts.dotExtent ?? 0.35) && aspect <= (opts.dotAspect ?? 1.3);
    if (!isDot) kill.add(c.id);
  }
  for (let i = 0; i < labels.length; i++) if (labels[i] && kill.has(labels[i])) out[i] = 255;
  return { gray: out, removed: kill.size, specks, unit, bigCount: big.length };
}

/**
 * Erase ink components that touch the border of the (frame-cropped) image: the scroll ornament that hangs
 * from the frame's top rule, corner flourishes and leftovers of the rule itself are not text.
 */
export function eraseEdgeComponents(gray, w, h, margin = 4) {
  const ink = toInk(gray, Math.max(otsu(gray), 170));
  const { labels, comps } = labelComponents(ink, w, h);
  const kill = new Set();
  for (const c of comps) {
    if (c.y0 < margin || c.x0 < margin || c.y1 > h - 1 - margin || c.x1 > w - 1 - margin) kill.add(c.id);
  }
  if (!kill.size) return { gray, erased: 0 };
  const out = Uint8Array.from(gray);
  for (let i = 0; i < labels.length; i++) if (labels[i] && kill.has(labels[i])) out[i] = 255;
  return { gray: out, erased: kill.size };
}

// ---------------------------------------------------------------------------------------------
// One call that prepares a rendered scan for OCR
// ---------------------------------------------------------------------------------------------

// The Arabic OCR model is tuned for text whose typical word height is about this many pixels.
// (Measured on real scans: accuracy collapses when the text is 30% smaller or larger.)
const TARGET_UNIT = 50;

/**
 * Crop to the decorative frame, remove diacritics when the page is heavily vowelled, and normalise
 * the text size. Returns the image plus the geometry needed to map OCR boxes back onto the page.
 *
 * @param {Uint8Array} gray 8-bit grayscale render
 * @returns {Promise<{gray:Uint8Array,width:number,height:number,geometry:{scale:number,offsetX:number,offsetY:number},info:object}>}
 */
export async function prepareForOcr(gray, w, h, opts = {}) {
  let g = gray;
  let cw = w;
  let ch = h;
  let offsetX = 0;
  let offsetY = 0;
  // a page photographed with a phone (a shadow across it, paper darker at one side): the OCR's single threshold would cut the
  // dark side's letters into blobs and lose the light side's thin strokes. A flat scan is left exactly as it was.
  const even = evenPaper(g, w, h);
  const evened = even.spread >= (opts.unevenAt ?? 40);
  if (evened) g = even.gray;
  const box = opts.crop === false ? null : findFrameInterior(g, w, h);
  if (box) {
    const c = crop(g, w, h, box);
    g = c.gray;
    cw = c.width;
    ch = c.height;
    offsetX = box.x0;
    offsetY = box.y0;
    g = eraseEdgeComponents(g, cw, ch).gray;
  }

  const stripped = stripDiacritics(g, cw, ch);
  // marks per word-sized component: vowelled books have well over one, plain text far less
  const ratio = stripped.bigCount ? stripped.removed / stripped.bigCount : 0;
  const strip = opts.strip === true || (opts.strip !== false && ratio >= 0.5);
  if (strip) g = stripped.gray;

  let scale = 1;
  const unit = stripped.unit;
  if (stripped.bigCount >= 20 && unit > 8) scale = Math.min(2, Math.max(0.6, TARGET_UNIT / unit));
  if (Math.abs(scale - 1) > 0.08) {
    const nw = Math.round(cw * scale);
    const nh = Math.round(ch * scale);
    g = new Uint8Array(await sharp(Buffer.from(g.buffer, g.byteOffset, g.length), { raw: { width: cw, height: ch, channels: 1 } })
      .resize(nw, nh, { kernel: 'lanczos3' }).raw().toBuffer());
    cw = nw;
    ch = nh;
  } else scale = 1;

  return {
    gray: g,
    width: cw,
    height: ch,
    geometry: { scale, offsetX, offsetY },
    info: {
      cropped: !!box,
      diacriticsStripped: strip,
      marksPerWord: Number(ratio.toFixed(2)),
      // the same without the specks: the diacritics the page really prints
      vowelsPerWord: Number((stripped.bigCount ? (stripped.removed - stripped.specks) / stripped.bigCount : 0).toFixed(2)),
      wordsSeen: stripped.bigCount,
      paperEvened: evened || undefined,
      textUnitPx: unit,
      scale: Number(scale.toFixed(2)),
    },
  };
}

/** RGBA canvas pixels -> 8-bit gray. */
export function rgbaToGray(rgba, w, h) {
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
  return gray;
}

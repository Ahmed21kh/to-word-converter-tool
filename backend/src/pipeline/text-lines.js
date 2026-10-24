// Split a page body (8-bit grey, dark ink on light paper) into its text lines, so that each line can be read on its own.
// A line is a run of rows that hold ink. The marks above or below a line can float free of it as thin runs of their own: those are
// joined to the nearer line. Tight leading makes the descenders of one line touch the ascenders of the next, so a run that is much
// taller than the typical line is cut again at the quietest rows near the expected line boundaries.

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

  // thin runs (the marks of a line that are separated from it by a blank row) belong to the nearer line
  const typical = median(real.map((r) => r.b - r.a));
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
  const pitch = periodicPitch(rows, h) || median(heights.filter((v) => v <= low * 1.25)) || low;
  const profile = smooth(rows, Math.max(1, Math.round(pitch * 0.06)));
  const out = [];
  for (const { a, b } of real) {
    const parts = Math.round((b - a) / pitch);
    if (parts < 2) { out.push({ y0: a, y1: b }); continue; }
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
  return out.map((l) => ({ ...l, ...inkExtent(gray, w, l.y0, l.y1, inkBelow) }));
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
  for (let lag = lo + 1; lag < hi; lag++) if (r[lag] >= best * 0.85 && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) return lag;
  return 0;
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
 */
export function findFootnoteRule(gray, w, h, lines, { minFrac = 0.15, inkBelow = 140 } = {}) {
  const need = w * minFrac;
  for (let y = Math.round(h * 0.4); y < h; y++) {
    if (lines.some((l) => y >= l.y0 && y < l.y1)) continue;
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] < inkBelow) { if (++run >= need) return y; } else run = 0;
    }
  }
  return null;
}

/**
 * Does the strip y0..y1 contain a drawn horizontal rule (a dark run across at least `minFrac` of the width)? Letters of a line never
 * form a dark run that long; a running header often has one between its title and the page number.
 */
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

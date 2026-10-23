// Layout analysis: turns raw positioned glyph items into ordered paragraphs / tables.
// All coordinates are in viewport space: points, origin top-left, y grows downward.
import { strongKind, isMarksOnly, normalizeShaping, mirrorBrackets, clusters, dominantDirection, ARABIC_ANY } from './arabic.js';

const median = (arr) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};

// ---------------------------------------------------------------------------
// 1. Marks (diacritics) are separate zero-width items: attach each to its base item.
// ---------------------------------------------------------------------------
export function splitMarksAndBases(items) {
  const bases = [];
  const marks = [];
  for (const it of items) {
    if (!it.str) continue;
    if (isMarksOnly(it.str)) marks.push({ ...it, str: it.str.replace(/[\s\u200B-\u200F]/g, '') });
    else bases.push({ ...it, marks: [] });
  }
  return { bases, marks };
}

export function attachMarks(bases, marks) {
  if (!marks.length || !bases.length) return;
  const sorted = [...bases].sort((a, b) => a.y - b.y);
  const ys = sorted.map((b) => b.y);
  const lowerBound = (v) => {
    let lo = 0;
    let hi = ys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ys[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const m of marks) {
    const win = Math.max(m.fs, 8) * 1.1;
    let best = null;
    let bestCost = Infinity;
    for (let i = lowerBound(m.y - win); i < sorted.length && sorted[i].y <= m.y + win; i++) {
      const b = sorted[i];
      if (!b.str.trim()) continue;
      // marks are drawn centred on their base glyph: compare glyph centres
      const dx = Math.abs(m.x + m.w / 2 - (b.x + b.w / 2));
      const cost = dx + 0.35 * Math.abs(m.y - b.y);
      if (cost < bestCost) {
        bestCost = cost;
        best = b;
      }
    }
    if (best && bestCost < m.fs * 1.5) best.marks.push(m);
  }
  for (const b of bases) {
    if (!b.marks.length) continue;
    const cl = clusters(b.str.replace(/\s+$/g, (s) => s));
    const rtl = b.dir === 'rtl' || strongKind(b.str) === 'rtl';
    const w = Math.max(b.w, 0.001);
    // distribute marks over the clusters of this item by their x position
    const buckets = cl.map(() => []);
    for (const m of b.marks) {
      const rel = rtl ? (b.x + w - m.x) / w : (m.x - b.x) / w;
      const idx = Math.max(0, Math.min(cl.length - 1, Math.floor(rel * cl.length)));
      buckets[idx].push(m);
    }
    b.str = cl
      .map((c, i) => c + buckets[i].sort((p, q) => (rtl ? q.x - p.x : p.x - q.x)).map((m) => m.str).join(''))
      .join('');
    b.marks = [];
  }
}

// ---------------------------------------------------------------------------
// 2. Lines
// ---------------------------------------------------------------------------
export function groupLines(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.y - last.y) <= 0.42 * Math.max(it.fs, last.fs)) {
      last.items.push(it);
      last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length;
      last.fs = Math.max(last.fs, it.fs);
    } else {
      lines.push({ y: it.y, fs: it.fs, items: [it] });
    }
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

const visibleExtent = (items) => {
  const v = items.filter((i) => i.str.trim());
  return v.length ? { x0: Math.min(...v.map((i) => i.x)), x1: Math.max(...v.map((i) => i.x + i.w)) } : null;
};

/** Find vertical gutters (column separators) consistently present across lines. */
export function findGutters(lines, fsBody) {
  const G = Math.max(10, fsBody * 0.9);
  const real = lines.filter((l) => l.items.filter((i) => i.str.trim()).length >= 2);
  if (real.length < 6) return [];
  const gapVotes = new Map();
  for (const l of real) {
    const v = l.items.filter((i) => i.str.trim());
    const seen = new Set();
    for (let i = 0; i < v.length - 1; i++) {
      const g0 = v[i].x + v[i].w;
      const g1 = v[i + 1].x;
      if (g1 - g0 >= G) for (let x = Math.ceil(g0); x <= Math.floor(g1); x++) seen.add(x);
    }
    for (const x of seen) gapVotes.set(x, (gapVotes.get(x) || 0) + 1);
  }
  const candidates = [...gapVotes.entries()].filter(([, n]) => n >= 4).map(([x]) => x).sort((a, b) => a - b);
  const gutters = [];
  let start = null;
  let prev = null;
  const flush = () => {
    if (start !== null && prev - start >= G * 0.7) gutters.push([start, prev]);
  };
  for (const x of candidates) {
    if (start === null) start = x;
    else if (x - prev > 1) {
      flush();
      start = x;
    }
    prev = x;
  }
  if (start !== null) flush();

  // keep only bands that (almost) no line crosses
  return gutters.filter(([g0, g1]) => {
    let crossing = 0;
    for (const l of lines) {
      if (l.items.some((i) => i.str.trim() && i.x < g1 && i.x + i.w > g0)) crossing++;
    }
    return crossing <= Math.max(2, lines.length * 0.06);
  });
}

/** Split lines into segments so that each segment lies within a single column. */
export function splitLinesIntoSegments(lines, gutters) {
  if (!gutters.length) return lines.map((l) => ({ ...l }));
  const out = [];
  for (const l of lines) {
    const buckets = new Map();
    for (const it of l.items) {
      const c = it.x + it.w / 2;
      let col = 0;
      for (const [g0, g1] of gutters) if (c > (g0 + g1) / 2) col++;
      if (!buckets.has(col)) buckets.set(col, []);
      buckets.get(col).push(it);
    }
    for (const [col, its] of buckets) out.push({ y: l.y, fs: Math.max(...its.map((i) => i.fs)), items: its, col });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Logical order of a line segment (visual -> logical, bidi)
// ---------------------------------------------------------------------------
const NUM_SEP = /^[.,:/\-٫٬،]$/;

export function assembleSegment(seg, pageDir, { reverseItems = false } = {}) {
  const items = seg.items;
  const toks = [];
  // visual order tokens with synthetic spaces where there is a gap
  let prevEnd = null;
  let prevSpace = true;
  for (const it of items) {
    const raw = it.str;
    const isSpace = !raw.trim();
    if (!isSpace && prevEnd !== null && !prevSpace && it.x - prevEnd > Math.max(0.22 * it.fs, 1.4)) {
      toks.push({ text: ' ', kind: 'space', x: prevEnd, w: it.x - prevEnd, fs: it.fs, synthetic: true });
    }
    const text = normalizeShaping(raw);
    toks.push({ text, kind: isSpace ? 'space' : strongKind(text), x: it.x, w: it.w, fs: it.fs, bold: it.bold, italic: it.italic, rawDir: it.dir });
    prevEnd = it.x + it.w;
    prevSpace = isSpace;
  }
  // paragraph direction
  let rtlN = 0;
  let ltrN = 0;
  for (const t of toks) {
    if (t.kind === 'rtl') rtlN += t.text.length;
    else if (t.kind === 'ltr') ltrN += t.text.length;
  }
  const baseDir = rtlN + ltrN === 0 ? pageDir : rtlN >= ltrN * 0.35 && rtlN > 0 ? 'rtl' : 'ltr';

  // resolve neutral/space tokens
  const embedOf = (t) => (t.kind === 'rtl' ? 'rtl' : t.kind === 'ltr' ? 'ltr' : t.kind === 'num' ? baseDir : null);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'rtl' || t.kind === 'ltr') t.run = t.kind;
    else if (t.kind === 'num') t.run = 'ltr';
  }
  for (let i = 0; i < toks.length; ) {
    if (toks[i].run) {
      i++;
      continue;
    }
    let j = i;
    while (j < toks.length && !toks[j].run) j++;
    const left = i > 0 ? toks[i - 1] : null;
    const right = j < toks.length ? toks[j] : null;
    let dir;
    if (left && right && left.kind === 'num' && right.kind === 'num' && j - i === 1 && NUM_SEP.test(toks[i].text)) dir = 'ltr';
    else {
      const l = left ? embedOf(left) : baseDir;
      const r = right ? embedOf(right) : baseDir;
      dir = l === r ? l : baseDir;
    }
    for (let k = i; k < j; k++) toks[k].run = dir;
    i = j;
  }
  // group into runs
  const runs = [];
  for (const t of toks) {
    if (t.run === 'rtl' && !reverseItems) t.text = mirrorBrackets(t.text);
    const last = runs[runs.length - 1];
    if (last && last.dir === t.run) last.toks.push(t);
    else runs.push({ dir: t.run, toks: [t] });
  }
  // `reverseItems`: the PDF placed Arabic glyphs left-to-right in logical order
  // (broken generators) - the x-order already is the logical order, so do not flip.
  if (!reverseItems) {
    for (const r of runs) if (r.dir === 'rtl') r.toks.reverse();
    if (baseDir === 'rtl') runs.reverse();
  }
  const ordered = runs.flatMap((r) => r.toks);
  return { tokens: ordered, dir: baseDir };
}

/** Collapse tokens into style runs; trims and collapses whitespace. */
export function tokensToRuns(tokens) {
  const runs = [];
  for (const t of tokens) {
    const style = { fs: Math.round(t.fs * 2) / 2, bold: !!t.bold, italic: !!t.italic };
    const last = runs[runs.length - 1];
    if (last && last.fs === style.fs && last.bold === style.bold && last.italic === style.italic) last.text += t.text;
    else if (!t.text.trim() && last) last.text += t.text;
    else runs.push({ ...style, text: t.text });
  }
  for (const r of runs) r.text = r.text.replace(/[ \t ]{2,}/g, ' ');
  while (runs.length && !runs[0].text.trim()) runs.shift();
  while (runs.length && !runs[runs.length - 1].text.trim()) runs.pop();
  if (runs.length) {
    runs[0].text = runs[0].text.replace(/^\s+/, '');
    runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
  }
  return runs.filter((r) => r.text.length);
}

// ---------------------------------------------------------------------------
// 4. XY-cut reading order
// ---------------------------------------------------------------------------
export function xyCut(nodes, { rtl, gutterMin, rowGapMin = 0 }) {
  if (nodes.length <= 1) return nodes;
  const bx0 = Math.min(...nodes.map((n) => n.x0));
  const bx1 = Math.max(...nodes.map((n) => n.x1));

  // vertical cut (columns): needs a clear gutter across the whole set
  const byX = [...nodes].sort((a, b) => a.x0 - b.x0);
  const groups = [];
  let cur = [byX[0]];
  let curEnd = byX[0].x1;
  for (let i = 1; i < byX.length; i++) {
    if (byX[i].x0 - curEnd >= gutterMin) {
      groups.push(cur);
      cur = [byX[i]];
      curEnd = byX[i].x1;
    } else {
      cur.push(byX[i]);
      curEnd = Math.max(curEnd, byX[i].x1);
    }
  }
  groups.push(cur);
  const wide = bx1 - bx0;
  if (groups.length > 1 && wide > gutterMin * 2) {
    const ordered = rtl ? groups.reverse() : groups;
    return ordered.flatMap((g) => xyCut(g, { rtl, gutterMin, rowGapMin }));
  }

  // horizontal cut (bands)
  const byY = [...nodes].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const bands = [];
  let band = [byY[0]];
  let bandEnd = byY[0].y1;
  for (let i = 1; i < byY.length; i++) {
    if (byY[i].y0 - bandEnd > rowGapMin) {
      bands.push(band);
      band = [byY[i]];
      bandEnd = byY[i].y1;
    } else {
      band.push(byY[i]);
      bandEnd = Math.max(bandEnd, byY[i].y1);
    }
  }
  bands.push(band);
  if (bands.length > 1) return bands.flatMap((b) => xyCut(b, { rtl, gutterMin, rowGapMin }));

  // cannot cut: read rows top->bottom, each row in reading direction
  return [...nodes].sort((a, b) => (Math.abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) < 3 ? (rtl ? b.x0 - a.x0 : a.x0 - b.x0) : a.y0 - b.y0));
}

// ---------------------------------------------------------------------------
// 5. Tables from ruling lines
// ---------------------------------------------------------------------------
const TOL = 2.5;
const near = (a, b, t = TOL) => Math.abs(a - b) <= t;

function clusterValues(vals, tol = TOL) {
  const s = [...vals].sort((a, b) => a - b);
  const out = [];
  for (const v of s) {
    if (out.length && v - out[out.length - 1].max <= tol) {
      const c = out[out.length - 1];
      c.sum += v;
      c.n++;
      c.max = v;
    } else out.push({ sum: v, n: 1, max: v });
  }
  return out.map((c) => c.sum / c.n);
}

export function detectTables(rulings, pageW, pageH) {
  const H = rulings.filter((r) => r.type === 'h');
  const V = rulings.filter((r) => r.type === 'v');
  if (H.length < 2 || V.length < 2) return [];
  // connected components of touching segments
  const segs = [...H, ...V].map((s, i) => ({ ...s, id: i }));
  const parent = segs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const touch = (a, b) => a.x0 - TOL <= b.x1 && b.x0 - TOL <= a.x1 && a.y0 - TOL <= b.y1 && b.y0 - TOL <= a.y1;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (touch(segs[i], segs[j])) parent[find(i)] = find(j);
  const comps = new Map();
  for (const s of segs) {
    const r = find(s.id);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(s);
  }
  const tables = [];
  for (const comp of comps.values()) {
    const h = comp.filter((s) => s.type === 'h');
    const v = comp.filter((s) => s.type === 'v');
    if (h.length < 2 || v.length < 2) continue;
    const ys = clusterValues(h.map((s) => (s.y0 + s.y1) / 2));
    const xs = clusterValues(v.map((s) => (s.x0 + s.x1) / 2));
    if (ys.length < 2 || xs.length < 2) continue;
    const bbox = { x0: xs[0], x1: xs[xs.length - 1], y0: ys[0], y1: ys[ys.length - 1] };
    if (bbox.x1 - bbox.x0 < 30 || bbox.y1 - bbox.y0 < 12) continue;
    if ((bbox.x1 - bbox.x0) * (bbox.y1 - bbox.y0) > pageW * pageH * 0.97) continue;
    const nR = ys.length - 1;
    const nC = xs.length - 1;
    if (nR < 2 && nC < 2) continue;
    // does a vertical rule exist at xs[c] spanning row r ? / horizontal at ys[r] spanning col c ?
    const vHas = (c, r) => v.some((s) => near((s.x0 + s.x1) / 2, xs[c]) && s.y0 <= (ys[r] + ys[r + 1]) / 2 && s.y1 >= (ys[r] + ys[r + 1]) / 2);
    const hHas = (r, c) => h.some((s) => near((s.y0 + s.y1) / 2, ys[r]) && s.x0 <= (xs[c] + xs[c + 1]) / 2 && s.x1 >= (xs[c] + xs[c + 1]) / 2);
    const covered = Array.from({ length: nR }, () => Array(nC).fill(false));
    const cells = [];
    for (let r = 0; r < nR; r++) {
      for (let c = 0; c < nC; c++) {
        if (covered[r][c]) continue;
        let cs = 1;
        while (c + cs < nC && !vHas(c + cs, r) && !covered[r][c + cs]) cs++;
        let rs = 1;
        while (r + rs < nR) {
          let line = false;
          for (let k = c; k < c + cs; k++) if (hHas(r + rs, k)) line = true;
          if (line) break;
          rs++;
        }
        for (let a = r; a < r + rs; a++) for (let b = c; b < c + cs; b++) covered[a][b] = true;
        cells.push({ r, c, rowspan: rs, colspan: cs, x0: xs[c], x1: xs[c + cs], y0: ys[r], y1: ys[r + rs] });
      }
    }
    tables.push({ bbox, xs, ys, nR, nC, cells });
  }
  // drop tables fully nested in another
  return tables.filter((t, i) => !tables.some((o, j) => j !== i && o.bbox.x0 <= t.bbox.x0 + 1 && o.bbox.x1 >= t.bbox.x1 - 1 && o.bbox.y0 <= t.bbox.y0 + 1 && o.bbox.y1 >= t.bbox.y1 - 1 && (o.nR * o.nC > t.nR * t.nC)));
}

// ---------------------------------------------------------------------------
// 6. Paragraph building
// ---------------------------------------------------------------------------
const BULLET = /^([•●▪◦·*\-–—]|[0-9٠-٩]{1,3}\s*[.)\-–:]|\([0-9٠-٩]{1,3}\))\s/;

/**
 * lines: array of {y, fs, x0, x1, tokens, dir, runs, text}
 * Returns paragraph blocks.
 */
export function linesToParagraphs(lineNodes, ctx) {
  const paras = [];
  let cur = null;
  const regionW = ctx.regionW;
  for (const ln of lineNodes) {
    const full = ln.x1 - ln.x0;
    if (cur) {
      const prev = cur.lines[cur.lines.length - 1];
      const gap = ln.y - prev.y;
      const fsMax = Math.max(prev.fs, ln.fs);
      const similarFs = Math.abs(prev.fs - ln.fs) <= Math.max(1.5, prev.fs * 0.15);
      const sameCol = (prev.col ?? 0) === (ln.col ?? 0);
      const prevFull = prev.x1 - prev.x0 >= regionW * 0.8;
      const aligned = prev.dir === ln.dir && (ln.dir === 'rtl' ? Math.abs(prev.x1 - ln.x1) < fsMax * 3.2 : Math.abs(prev.x0 - ln.x0) < fsMax * 3.2);
      const startsBullet = BULLET.test(ln.text);
      if (sameCol && similarFs && gap > 0 && gap <= fsMax * 2.1 && prevFull && aligned && !startsBullet && !ln.breakBefore) {
        cur.lines.push(ln);
        continue;
      }
    }
    cur = { lines: [ln] };
    paras.push(cur);
    void full;
  }
  return paras.map((p) => finishParagraph(p, ctx));
}

function finishParagraph(p, ctx) {
  const ls = p.lines;
  const dir = dominantDirection(ls.map((l) => l.text).join(' ')) || ls[0].dir;
  const x0 = Math.min(...ls.map((l) => l.x0));
  const x1 = Math.max(...ls.map((l) => l.x1));
  const y0 = ls[0].y - ls[0].fs;
  const y1 = ls[ls.length - 1].y + ls[ls.length - 1].fs * 0.35;
  // merge runs across lines with a single space between
  const runs = [];
  ls.forEach((l, i) => {
    const lr = l.runs.map((r) => ({ ...r }));
    if (i > 0 && runs.length && lr.length) {
      const last = runs[runs.length - 1];
      if (!/\s$/.test(last.text)) last.text += ' ';
    }
    for (const r of lr) {
      const last = runs[runs.length - 1];
      if (last && last.fs === r.fs && last.bold === r.bold && last.italic === r.italic) last.text += r.text;
      else runs.push(r);
    }
  });
  // alignment relative to the region
  const { regionX0, regionX1 } = ctx;
  const rw = Math.max(1, regionX1 - regionX0);
  const marginL = x0 - regionX0;
  const marginR = regionX1 - x1;
  let align = 'start';
  const symmetric = Math.abs(marginL - marginR) <= rw * 0.05;
  if (symmetric && marginL > rw * 0.06 && marginR > rw * 0.06) align = 'center';
  else if (ls.length >= 3 && ls.slice(0, -1).every((l) => l.x1 - l.x0 >= rw * 0.97)) align = 'both';
  else if (dir === 'rtl' && marginR > rw * 0.25 && marginL < rw * 0.1) align = 'end';
  else if (dir === 'ltr' && marginL > rw * 0.25 && marginR < rw * 0.1) align = 'end';
  const fsList = [];
  for (const r of runs) for (let k = 0; k < r.text.length; k++) fsList.push(r.fs);
  const baseline = ls.length > 1 ? (ls[ls.length - 1].y - ls[0].y) / (ls.length - 1) : null;
  return {
    type: 'p',
    runs,
    dir,
    align,
    fs: median(fsList) || ls[0].fs,
    lineGap: baseline,
    x0,
    x1,
    y0,
    y1,
    firstBaseline: ls[0].y,
    lastBaseline: ls[ls.length - 1].y,
    lineCount: ls.length,
  };
}

export { ARABIC_ANY, median };

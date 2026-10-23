// Scan cleaning for OCR: binarise, find the decorative page frame and crop to its inside, optionally
// strip diacritics (tashkeel) so the OCR engine sees plain letter shapes.
// Works on 8-bit grayscale buffers (0 = black ink, 255 = white paper).

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
export function findFrameInterior(gray, w, h) {
  // thin rules are anti-aliased to light grey when a 600 dpi scan is reduced: use a generous threshold
  const ink = toInk(gray, Math.max(otsu(gray), 185));
  const rowsLong = [];
  for (let y = 0; y < h; y++) {
    // an ornament on the top/bottom rule splits it in two, so a long half is enough
    if (longestRun((x) => ink[y * w + x], 0, w) >= w * 0.3) rowsLong.push(y);
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
  if (!top || !bottom || !left || !right) return null;
  const pad = Math.round(w * 0.006);
  const box = { x0: left.to + pad, x1: right.from - pad, y0: top.to + pad, y1: bottom.from - pad };
  if (box.x1 - box.x0 < w * 0.4 || box.y1 - box.y0 < h * 0.4) return null;
  return box;
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
 * @returns {{gray:Uint8Array, removed:number, unit:number}}
 */
export function stripDiacritics(gray, w, h, opts = {}) {
  const ink = toInk(gray, opts.threshold ?? otsu(gray));
  const { labels, comps } = labelComponents(ink, w, h);
  const big = comps.filter((c) => c.area >= 300).map((c) => c.h);
  const unit = percentile(big, 0.5) || 40; // typical word height
  const out = Uint8Array.from(gray);
  const kill = new Set();
  for (const c of comps) {
    if (c.h > unit * 0.5 || c.w > unit * 0.9) continue; // letters / words
    if (c.area < 3) { kill.add(c.id); continue; } // specks
    const extent = c.area / (c.w * c.h);
    const aspect = Math.max(c.w / c.h, c.h / c.w);
    const isDot = extent >= (opts.dotExtent ?? 0.66) && aspect <= (opts.dotAspect ?? 1.7);
    if (!isDot) kill.add(c.id);
  }
  for (let i = 0; i < labels.length; i++) if (labels[i] && kill.has(labels[i])) out[i] = 255;
  return { gray: out, removed: kill.size, unit };
}

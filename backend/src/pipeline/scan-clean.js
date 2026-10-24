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
 * Make a page crop easy to read for a vision model: flatten uneven paper tone / shadows (divide by a block-wise paper
 * estimate), stretch the contrast so ink is black and paper white, and sharpen thin strokes and dots slightly.
 * Returns a JPEG buffer. Nothing is binarised: dots and diacritics keep their grey edges.
 */
export async function enhanceForAi(gray, w, h) {
  const B = 24;
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const bg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      // paper tone of a block = a high percentile of its pixels (ink is a minority)
      const hist = new Uint32Array(256);
      let n = 0;
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y++) {
        for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x++) { hist[gray[y * w + x]]++; n++; }
      }
      let acc = 0;
      let v = 255;
      for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc >= n * 0.9) { v = k; break; } }
      bg[by * bw + bx] = Math.max(v, 90);
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
      const paper = (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx) * (1 - ty) + (bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx) * ty;
      out[y * w + x] = Math.min(255, Math.round((gray[y * w + x] * 255) / paper));
    }
  }
  return sharp(Buffer.from(out.buffer, out.byteOffset, out.length), { raw: { width: w, height: h, channels: 1 } })
    .normalise({ lower: 1, upper: 99 })
    .sharpen({ sigma: 0.8 })
    .jpeg({ quality: 92 })
    .toBuffer();
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
 * @returns {{gray:Uint8Array, removed:number, unit:number, bigCount:number}}
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
    const isDot = extent >= (opts.dotExtent ?? 0.35) && aspect <= (opts.dotAspect ?? 1.3);
    if (!isDot) kill.add(c.id);
  }
  for (let i = 0; i < labels.length; i++) if (labels[i] && kill.has(labels[i])) out[i] = 255;
  return { gray: out, removed: kill.size, unit, bigCount: big.length };
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
    info: { cropped: !!box, diacriticsStripped: strip, marksPerWord: Number(ratio.toFixed(2)), textUnitPx: unit, scale: Number(scale.toFixed(2)) },
  };
}

/** RGBA canvas pixels -> 8-bit gray. */
export function rgbaToGray(rgba, w, h) {
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
  return gray;
}

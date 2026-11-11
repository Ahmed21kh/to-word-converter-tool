// A page number read by the shapes of its digits (printMatch). The line reader is a language model: it reads a number set alone
// ("٥٦" between two dashes) as nothing, or as a guess; Tesseract does no better on two small digits. Arabic-Indic digits are ten
// plain shapes, so each one is matched against the digits drawn in the usual Arabic book fonts: its outline, how wide it is for its
// height, and how tall it is next to the others (a zero is a small dot).
import { labelComponents } from './scan-clean.js';

const DIGITS = '٠١٢٣٤٥٦٧٨٩';
const SETS = { ar: DIGITS, en: '0123456789' }; // Arabic-Indic digits, and the Western ones some books print
const FONTS = ['Traditional Arabic', 'Simplified Arabic', 'Arabic Typesetting', 'Sakkal Majalla', 'Times New Roman', 'Arial', 'Tahoma', 'Andalus'];
const S = 16; // the grid a digit is compared on
const INK = 140;

/** The ink of box b scaled into a size x size grid (aspect kept, centred), as a vector with its mean taken off and length 1. */
export function shapeVector(isInk, w, b, size = S) {
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const scale = size / Math.max(bw, bh);
  const ox = (size - bw * scale) / 2;
  const oy = (size - bh * scale) / 2;
  const v = new Float32Array(size * size);
  const n = new Float32Array(size * size);
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      const gx = Math.min(size - 1, Math.floor((x - b.x0) * scale + ox));
      const gy = Math.min(size - 1, Math.floor((y - b.y0) * scale + oy));
      n[gy * size + gx]++;
      if (isInk(x, y)) v[gy * size + gx]++;
    }
  }
  let mean = 0;
  for (let i = 0; i < v.length; i++) { v[i] = n[i] ? v[i] / n[i] : 0; mean += v[i]; }
  mean /= v.length;
  let len = 0;
  for (let i = 0; i < v.length; i++) { v[i] -= mean; len += v[i] * v[i]; }
  len = Math.sqrt(len) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= len;
  return v;
}

let templates = null;
/** The ten digits of each set in every installed font, regular and bold: [{set, digit, vec, aspect, rel}] (rel: height next to a one). */
async function getTemplates() {
  if (templates) return templates;
  templates = [];
  try {
    const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas');
    const have = new Set(GlobalFonts.families.map((f) => f.family));
    for (const font of FONTS.filter((f) => have.has(f))) {
      for (const [set, chars] of Object.entries(SETS)) for (const weight of ['normal', 'bold']) {
        const drawn = [];
        for (let d = 0; d < 10; d++) {
          const c = createCanvas(160, 160);
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, 160, 160);
          ctx.fillStyle = '#000';
          ctx.font = `${weight} 96px "${font}"`;
          ctx.fillText(chars[d], 30, 120);
          const px = ctx.getImageData(0, 0, 160, 160).data;
          const isInk = (x, y) => px[(y * 160 + x) * 4] < 128;
          const b = { x0: 160, y0: 160, x1: -1, y1: -1 };
          for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) if (isInk(x, y)) { b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y); }
          if (b.x1 < 0) break; // the font has no Arabic-Indic digits
          drawn.push({ digit: d, vec: shapeVector(isInk, 160, b), aspect: (b.x1 - b.x0 + 1) / (b.y1 - b.y0 + 1), h: b.y1 - b.y0 + 1 });
        }
        if (drawn.length < 10) continue;
        const one = drawn[1].h;
        for (const t of drawn) templates.push({ set, digit: t.digit, vec: t.vec, aspect: t.aspect, rel: t.h / one });
      }
    }
  } catch { /* no canvas: page numbers are left to the line reader */ }
  return templates;
}

/**
 * The number in a small grey image holding a page number (and perhaps the dashes beside it).
 * @returns {Promise<{n:number, text:string, indic:boolean, sure:number}|null>} sure: the weakest digit's lead over its runner-up
 */
export async function readPageDigits(gray, w, h) {
  const tpl = await getTemplates();
  if (!tpl.length) return null;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = gray[i] < INK ? 1 : 0;
  const { labels, comps } = labelComponents(ink, w, h);
  let parts = comps.filter((c) => c.area >= 3);
  if (!parts.length) return null;
  const tall = Math.max(...parts.map((c) => c.h));
  // the dashes of the rule beside the number are flat; a speck of the rule is far from the digits
  parts = parts.filter((c) => !(c.w > c.h * 2.2 && c.h < tall * 0.5));
  // a digit the scan broke in two: pieces one above the other are one digit
  parts.sort((a, b) => a.x0 - b.x0);
  const merged = [];
  for (const c of parts) {
    const prev = merged[merged.length - 1];
    const overlap = prev ? Math.min(prev.x1, c.x1) - Math.max(prev.x0, c.x0) : -1;
    if (prev && overlap > Math.min(prev.w, c.w) * 0.5) {
      prev.ids.push(c.id);
      prev.x0 = Math.min(prev.x0, c.x0); prev.x1 = Math.max(prev.x1, c.x1); prev.y0 = Math.min(prev.y0, c.y0); prev.y1 = Math.max(prev.y1, c.y1);
      prev.w = prev.x1 - prev.x0 + 1; prev.h = prev.y1 - prev.y0 + 1;
    } else merged.push({ ...c, ids: [c.id] });
  }
  const top = Math.max(...merged.map((c) => c.h));
  const big = merged.filter((c) => c.h >= top * 0.55);
  if (!big.length) return null;
  const bandY0 = Math.min(...big.map((c) => c.y0));
  const bandH = Math.max(...big.map((c) => c.y1)) - bandY0 + 1;
  const digits = merged.filter((c, i) => {
    if (c.h >= top * 0.55) return true;
    // a small part is a zero only right beside a digit, half-way up the digits, roundish and alone: a speck of the rule stands
    // apart or lies at the foot of the line, and the rule's dots come several in a row
    const close = (o) => o && Math.min(Math.abs(o.x1 - c.x0), Math.abs(c.x1 - o.x0)) < top * 0.9;
    const near = (o) => close(o) && o.h >= top * 0.55;
    const dot = (o) => close(o) && o.h < top * 0.55;
    const mid = ((c.y0 + c.y1) / 2 - bandY0) / bandH;
    const aspect = c.w / c.h;
    return (near(merged[i - 1]) || near(merged[i + 1])) && mid > 0.2 && mid < 0.75 && aspect > 0.4 && aspect < 2.5
      && !dot(merged[i - 1]) && !dot(merged[i + 1]);
  });
  if (!digits.length || digits.length > 4) return null;
  // each digit against each set; the number is read in the set its digits fit best together
  const reads = {};
  for (const set of Object.keys(SETS)) reads[set] = { text: '', value: '', total: 0, sure: 1 };
  for (const c of digits) {
    const own = new Set(c.ids);
    const vec = shapeVector((x, y) => own.has(labels[y * w + x]), w, c);
    const aspect = c.w / c.h;
    const rel = c.h / top;
    const best = {};
    for (const set of Object.keys(SETS)) best[set] = new Map();
    for (const t of tpl) {
      let dot = 0;
      for (let i = 0; i < vec.length; i++) dot += vec[i] * t.vec[i];
      const score = dot - 0.35 * Math.abs(Math.log(aspect / t.aspect)) - 0.8 * Math.abs(Math.min(rel, 1) - Math.min(t.rel, 1));
      const m = best[t.set];
      if (!m.has(t.digit) || score > m.get(t.digit)) m.set(t.digit, score);
    }
    for (const set of Object.keys(SETS)) {
      const ranked = [...best[set].entries()].sort((a, b) => b[1] - a[1]);
      if (!ranked.length) continue;
      const r = reads[set];
      r.text += SETS[set][ranked[0][0]];
      r.value += ranked[0][0];
      r.total += ranked[0][1];
      r.sure = Math.min(r.sure, Math.max(0, ranked[0][1] - (ranked[1]?.[1] ?? 0)));
    }
  }
  const [set, r] = Object.entries(reads).filter(([, x]) => x.text.length === digits.length).sort((a, b) => b[1].total - a[1].total)[0] || [];
  const n = r ? Number(r.value) : 0;
  return n > 0 ? { n, text: r.text, indic: set === 'ar', sure: r.sure } : null;
}

/**
 * The numbers printed in a line of text (a year, a date), read by the shapes of their Arabic-Indic digits: the line reader writes
 * other digits than the printed ones (١٢٩٣ as ١١٤٤ or ٢٠١٣, whatever the size). A digit is a blob that fits a digit's shape closely
 * (letters fit one at 0.47 at most, digits at 0.75 and over); its neighbours in the same band that fit a digit at all are digits
 * with it, and a small round dot half-way up among them (or just after them) is a zero. Brackets are not digits: a parenthesis
 * bends ("(" fits ١), a square bracket has wide ends.
 * @returns {Promise<{x0:number, x1:number, text:string}[]>} the numbers of three digits or more, from the right of the line to its left
 */
export async function lineNumbers(gray, w, h, box) {
  const tpl = (await getTemplates()).filter((t) => t.set === 'ar');
  if (!tpl.length) return [];
  const { y0, y1 } = box;
  const lh = y1 - y0;
  const ink = new Uint8Array(w * lh);
  for (let y = 0; y < lh; y++) for (let x = box.x0; x < box.x1; x++) ink[y * w + x] = gray[(y0 + y) * w + x] < INK ? 1 : 0;
  const { labels, comps } = labelComponents(ink, w, lh);
  // a digit the scan broke in two (٤ in its upper and lower strokes): pieces one above the other are one glyph
  const parts = [];
  for (const c of comps.filter((p) => p.area >= 3).sort((a, b) => a.y0 - b.y0)) {
    const o = parts.find((p) => Math.min(p.x1, c.x1) - Math.max(p.x0, c.x0) + 1 >= Math.min(p.w, c.w) * 0.5 && c.y0 - p.y1 <= Math.max(p.h, c.h) * 0.3);
    if (!o) { parts.push({ ...c, ids: new Set([c.id]) }); continue; }
    o.ids.add(c.id);
    o.x0 = Math.min(o.x0, c.x0); o.x1 = Math.max(o.x1, c.x1); o.y1 = Math.max(o.y1, c.y1); o.area += c.area;
    o.w = o.x1 - o.x0 + 1; o.h = o.y1 - o.y0 + 1;
  }
  const own = (c) => (x, y) => c.ids.has(labels[y * w + x]);
  const bracket = (c) => {
    if (c.w / c.h >= 0.37) return false; // brackets are 0.27-0.35; ٤, ٨, ٩ (0.39 and up) bend or widen in their own right
    const mean = [0, 1, 2].map((k) => {
      let s = 0;
      let n = 0;
      for (let y = c.y0 + Math.floor((k * c.h) / 3); y < c.y0 + Math.floor(((k + 1) * c.h) / 3); y++) for (let x = c.x0; x <= c.x1; x++) if (own(c)(x, y)) { s += x; n++; }
      return n ? s / n : 0;
    });
    const span = (y) => { let a = Infinity; let z = -1; for (let x = c.x0; x <= c.x1; x++) if (own(c)(x, y)) { a = Math.min(a, x); z = x; } return z - a + 1; };
    const bend = Math.abs(mean[1] - (mean[0] + mean[2]) / 2) / c.w;
    return bend >= 0.25 || Math.max(span(c.y0), span(c.y1)) >= span(c.y0 + (c.h >> 1)) * 3;
  };
  const best = new Map();
  for (const c of parts) {
    if (c.h < lh * 0.25 || bracket(c)) continue;
    const vec = shapeVector(own(c), w, c);
    const aspect = c.w / c.h;
    const byDigit = new Array(10).fill(-1);
    for (const t of tpl) {
      let dot = 0;
      for (let i = 0; i < vec.length; i++) dot += vec[i] * t.vec[i];
      byDigit[t.digit] = Math.max(byDigit[t.digit], dot - 0.35 * Math.abs(Math.log(aspect / t.aspect)));
    }
    const ranked = byDigit.map((score, digit) => ({ digit, score })).sort((a, b) => b.score - a.score);
    // lead: how far the digit's shape is from the next digit's
    best.set(c, { ...ranked[0], lead: ranked[0].score - ranked[1].score });
  }
  // what stands between two numbers of a reference: a slash ("١٠/١٢٥", a slanted stroke taller than the digits) or a dash
  // ("١٤٢ـ١٦٧", flat, on their baseline or half-way up)
  const slant = (c) => {
    const meanX = (ya, yb) => { let s = 0; let n = 0; for (let y = ya; y < yb; y++) for (let x = c.x0; x <= c.x1; x++) if (own(c)(x, y)) { s += x; n++; } return n ? s / n : 0; };
    const q = Math.max(1, c.h >> 2);
    return (meanX(c.y0, c.y0 + q) - meanX(c.y1 + 1 - q, c.y1 + 1)) / c.w;
  };
  const separator = (c, seed) => {
    if (best.has(c) && best.get(c).score >= 0.65) return null;
    const mid = ((c.y0 + c.y1) / 2 - seed.y0) / seed.h;
    if (c.h <= seed.h * 0.3 && c.w >= seed.h * 0.35 && c.w <= seed.h * 1.5 && c.w >= c.h * 2.5 && mid >= 0.3 && mid <= 1.15) return mid >= 0.75 ? 'ـ' : '-';
    if (c.h >= seed.h * 1.1 && c.h <= seed.h * 1.8 && c.w / c.h >= 0.2 && c.w / c.h <= 0.6 && mid >= 0.3 && mid <= 0.7 && slant(c) >= 0.35) return '/';
    return null;
  };
  const used = new Set();
  const pieces = [];
  const seeds = [...best].filter(([, b]) => b.score >= 0.65).map(([c]) => c).sort((a, b) => best.get(b).score - best.get(a).score);
  for (const seed of seeds) {
    if (used.has(seed)) continue;
    const band0 = seed.y0 - seed.h * 0.25;
    const band1 = seed.y1 + seed.h * 0.25;
    // in the band of the seed (some digits are shorter than the others: ٥), fitting a digit at all
    const digit = (c) => best.has(c) && best.get(c).score >= 0.35 && c.y0 >= band0 && c.y1 <= band1 && c.h >= seed.h * 0.45;
    const zero = (c) => {
      // about a sixth of a digit's ink (a speck of the scan is a twentieth), round or a little taller than wide (the ٠ of "١٠/١٢٥")
      if (best.has(c) || c.h >= seed.h * 0.5 || c.area < seed.area * 0.1 || c.w / c.h > 1.8 || c.h / c.w > 2.2) return false;
      const mid = ((c.y0 + c.y1) / 2 - seed.y0) / seed.h;
      return mid >= 0.25 && mid <= 0.8;
    };
    // some books space a year's digits widely (٢ ٠ ٠ ٢); a slash or a dash between two digits parts two numbers
    const seps = parts.filter((c) => separator(c, seed));
    const near = (a, b) => Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1) <= seed.h
      && !seps.some((s) => s.x0 >= Math.min(a.x1, b.x1) && s.x1 <= Math.max(a.x0, b.x0));
    const run = [seed];
    for (let grew = true; grew;) {
      grew = false;
      for (const c of parts) {
        if (run.includes(c) || used.has(c) || !(digit(c) || zero(c)) || !run.some((o) => near(c, o))) continue;
        run.push(c);
        grew = true;
      }
    }
    run.sort((a, b) => a.x0 - b.x0);
    // a one at either end that is short of the number's height, or only a loose fit, is the alif or lam of the word beside it
    const fullH = run.filter((c) => best.has(c) && ![1, 5].includes(best.get(c).digit)).map((c) => c.h).sort((a, b) => a - b);
    const H = fullH[fullH.length >> 1] || seed.h;
    const odd = (c) => best.has(c) && best.get(c).digit === 1 && (Math.abs(c.h - H) > H * 0.3 || best.get(c).score < 0.6);
    for (const c of run) used.add(c);
    // no number starts with a zero: dots before it are not part of it (the dots of the word beside it, a row of ornaments ❋❋❋
    // that fits ٠), nor is a loose one
    while (run.length && (!best.has(run[0]) || best.get(run[0]).digit === 0 || odd(run[0]))) run.shift();
    while (run.length && odd(run[run.length - 1])) run.pop();
    // dots that go on past the number are a row of leader dots (a table of contents), not zeros
    const more = run.length && parts.some((c) => !run.includes(c) && zero(c) && near(c, run[run.length - 1]));
    // and a dot after two digits is a full stop as often as a zero ("٢٤."), unless it stands half-way up the digits, where a zero
    // stands (٨٥٠: 0.45 of their height) and no full stop does (on the line); after a year's three it is its zero (١٢٥٠)
    const halfUp = (c) => { const mid = ((c.y0 + c.y1) / 2 - seed.y0) / seed.h; return mid >= 0.3 && mid <= 0.62; };
    if (more) while (run.length && !best.has(run[run.length - 1])) run.pop();
    if (run.filter((c) => best.has(c)).length < 3) while (run.length && !best.has(run[run.length - 1]) && !halfUp(run[run.length - 1])) run.pop();
    // each digit plainly the digit it is taken for (an upright stroke alone, alif or lam, fits ١ as well as ١ does)
    const digits = run.filter((c) => best.has(c));
    if (!digits.length || digits.some((c) => best.get(c).score < 0.5 || best.get(c).lead < 0.05)) continue;
    pieces.push({ x0: run[0].x0, x1: run[run.length - 1].x1, seed, run, text: run.map((c) => DIGITS[best.has(c) ? best.get(c).digit : 0]).join('') });
  }
  // a reference's two numbers, the slash or the dash between them and nothing else: "١٠/١٢٥" (the volume and its page) is
  // written as printed, left to right, as the slash keeps it; a range "١٤٢ـ١٦٧" from its right number, as it is read
  pieces.sort((a, b) => a.x0 - b.x0);
  const joined = [];
  for (const p of pieces) {
    const a = joined[joined.length - 1];
    const gap = a && parts.filter((c) => c.x0 > a.x1 && c.x1 < p.x0 && c.area >= 3);
    const sep = gap && gap.length === 1 && gap[0].x0 - a.x1 <= a.seed.h && p.x0 - gap[0].x1 <= a.seed.h && separator(gap[0], a.seed);
    if (!sep) { joined.push({ ...p, parts: [p] }); continue; }
    a.parts.push(p);
    a.text = sep === '/' ? `${a.text}/${p.text}` : `${p.text}${sep}${a.text}`;
    a.x1 = p.x1;
  }
  // a year or a date: three digits or more, one of them at least plainly a digit other than ١
  const out = joined.filter((n) => {
    const run = n.parts.flatMap((p) => p.run);
    const digits = run.filter((c) => best.has(c));
    return run.length >= 3 && digits.some((c) => best.get(c).digit !== 1 && best.get(c).score >= 0.65);
  }).map(({ x0, x1, text }) => ({ x0, x1, text }));
  return out.sort((a, b) => b.x1 - a.x1);
}

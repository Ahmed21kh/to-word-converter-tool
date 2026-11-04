// ﷺ printed as a glyph (the words صلى الله عليه وسلم stacked into one small square of calligraphy). The line reader makes words
// of it ("وَشَيْءٌ" after "والشريعة الغراء") wherever it is not right after the Prophet's name, where honorifics.js looks for it.
// On the page it stands apart: a cluster of many small pieces (its thin strokes break in the scan: 14 and more, a word has 3 to 9),
// dense (a fifth of its box and more, a word less), about as wide as high, and shaped like ﷺ as the usual Arabic fonts draw it.
import { labelComponents } from './scan-clean.js';
import { shapeVector } from './page-digits.js';

const FONTS = ['Traditional Arabic', 'Arabic Typesetting', 'Simplified Arabic', 'Sakkal Majalla', 'Times New Roman', 'Arial', 'Tahoma', 'Segoe UI', 'Andalus', 'Aldhabi', 'Urdu Typesetting'];
const G = 24; // the grid it is compared on: its strokes are finer than a digit's
const INK = 140;

let templates = null;
/** ﷺ in every installed font that has it: [{vec, aspect}] */
async function getTemplates() {
  if (templates) return templates;
  templates = [];
  try {
    const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas');
    const have = new Set(GlobalFonts.families.map((f) => f.family));
    for (const font of FONTS.filter((f) => have.has(f))) {
      const c = createCanvas(300, 300);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 300, 300);
      ctx.fillStyle = '#000';
      ctx.font = `160px "${font}"`;
      ctx.fillText('ﷺ', 40, 220);
      const px = ctx.getImageData(0, 0, 300, 300).data;
      const isInk = (x, y) => px[(y * 300 + x) * 4] < 128;
      const b = { x0: 300, y0: 300, x1: -1, y1: -1 };
      for (let y = 0; y < 300; y++) for (let x = 0; x < 300; x++) if (isInk(x, y)) { b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y); }
      if (b.x1 < 0) continue;
      templates.push({ vec: shapeVector(isInk, 300, b, G), aspect: (b.x1 - b.x0 + 1) / (b.y1 - b.y0 + 1) });
    }
  } catch { /* no canvas: the glyph is left to the reader */ }
  return templates;
}

/**
 * The ﷺ glyphs printed in a line of text.
 * @returns {Promise<{x0:number, x1:number}[]>} from the right of the line to its left
 */
export async function findSalla(gray, w, h, box) {
  const tpl = await getTemplates();
  if (!tpl.length) return [];
  const { y0, y1 } = box;
  const lh = y1 - y0;
  const ink = new Uint8Array(w * lh);
  for (let y = 0; y < lh; y++) for (let x = box.x0; x < box.x1; x++) ink[y * w + x] = gray[(y0 + y) * w + x] < INK ? 1 : 0;
  const { labels, comps } = labelComponents(ink, w, lh);
  // clusters: pieces closer to each other than a small gap
  const gap = Math.max(4, lh * 0.12);
  const clusters = [];
  for (const c of comps.filter((p) => p.area >= 3).sort((a, b) => a.x0 - b.x0)) {
    const o = clusters[clusters.length - 1];
    if (o && c.x0 - o.x1 <= gap) {
      o.ids.add(c.id);
      o.x1 = Math.max(o.x1, c.x1); o.y0 = Math.min(o.y0, c.y0); o.y1 = Math.max(o.y1, c.y1); o.n++; o.area += c.area;
    } else clusters.push({ ids: new Set([c.id]), x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, n: 1, area: c.area });
  }
  const out = [];
  for (const c of clusters) {
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    const aspect = bw / bh;
    if (bh < lh * 0.5 || c.n < 9 || c.area / (bw * bh) < 0.2 || aspect < 0.8 || aspect > 1.25) continue;
    const vec = shapeVector((x, y) => c.ids.has(labels[y * w + x]), w, c, G);
    let fit = -1;
    for (const t of tpl) {
      let dot = 0;
      for (let i = 0; i < vec.length; i++) dot += vec[i] * t.vec[i];
      fit = Math.max(fit, dot - 0.35 * Math.abs(Math.log(aspect / t.aspect)));
    }
    // measured on a book's 37 glyphs and its words: the many-pieced ones, or a small one (fewer pieces) shaped like it
    if (c.n >= 14 || fit >= 0.24) out.push({ x0: c.x0, x1: c.x1 });
  }
  return out.sort((a, b) => b.x1 - a.x1);
}

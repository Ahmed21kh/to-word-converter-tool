// "Matches the printed edition" (printMatch): every PDF page must stay exactly one Word page, nothing spills onto the next.
// Word wraps the text again with its own font, so for each page we measure how many lines each paragraph will take in Word
// (with the real font file) and shrink that page's text until it fits the page: the font first, then the line spacing.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { ARABIC_ANY } from './arabic.js';

// [regular, bold]: Word draws bold text with the bold file, which is wider
const FONT_FILES = {
  'Traditional Arabic': ['trado.ttf', 'tradbdo.ttf'],
  'Simplified Arabic': ['simpo.ttf', 'simpbdo.ttf'],
  'Sakkal Majalla': ['majalla.ttf', 'majallab.ttf'],
  Arial: ['arial.ttf', 'arialbd.ttf'],
  Tahoma: ['tahoma.ttf', 'tahomabd.ttf'],
  'Times New Roman': ['times.ttf', 'timesbd.ttf'],
  Calibri: ['calibri.ttf', 'calibrib.ttf'],
};
// Word breaks lines between words, so a line is never quite full. 0.9 = measured against Word on a 300-page book: no paragraph
// took more lines in Word than estimated
const WRAP = 0.9;
const MIN_SCALE = 0.6;
const STEP = 0.025;

let canvas = null; // { ctx, GlobalFonts } | false when @napi-rs/canvas is missing
const families = new Map();

async function measureContext() {
  if (canvas === null) {
    try {
      const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas');
      canvas = { ctx: createCanvas(4, 4).getContext('2d'), GlobalFonts };
    } catch {
      canvas = false;
    }
  }
  return canvas;
}

/** Canvas font for a Word font: its real file when the system has it ({family, bold} = draw with synthetic bold). */
function fontFor(name, bold) {
  const key = `${name}|${bold ? 1 : 0}`;
  if (families.has(key)) return families.get(key);
  let font = { family: 'sans-serif', bold }; // a little wider than the Arabic book fonts: errs on the safe side
  const files = FONT_FILES[name] || [];
  const dir = path.join(process.env.WINDIR || 'C:/Windows', 'Fonts');
  for (const [file, synthetic] of [[files[bold ? 1 : 0], false], [files[0], bold]]) {
    if (!file) continue;
    const alias = `p2w ${file}`;
    try {
      if (existsSync(path.join(dir, file)) && (families.has(alias) || canvas.GlobalFonts.registerFromPath(path.join(dir, file), alias))) {
        families.set(alias, true);
        font = { family: alias, bold: synthetic };
        break;
      }
    } catch { /* try the next file */ }
  }
  families.set(key, font);
  return font;
}

/** Width in points of a paragraph's text, written at `scale` times its sizes. */
export function textWidth(par, scale, o) {
  let w = 0;
  for (const r of par.runs) {
    if (!r.text) continue;
    const pt = (r.fs || par.fs || 12) * scale;
    const name = ARABIC_ANY.test(r.text) ? o.arabicFont : o.latinFont;
    if (canvas) {
      const f = fontFor(name, !!(r.bold || r.verse));
      canvas.ctx.font = `${f.bold ? 'bold ' : ''}${pt}px "${f.family}"`;
      w += canvas.ctx.measureText(r.text).width;
    } else {
      w += r.text.length * pt * 0.36;
    }
  }
  return w;
}

/**
 * How to shrink one page so it stays one page.
 * @param page page model; `layout` = [{block, before, lineGap}] as the section builder places them
 * @returns {{scale:number, spacing:number}} font scale and line-spacing scale (1 = as printed)
 */
export async function fitPage(page, layout, o) {
  await measureContext();
  const { width, height, margins } = page;
  const contentW = Math.max(40, width - margins.left - margins.right);
  const avail = height - margins.top - margins.bottom - 3; // a few points for Word's rounding to twips
  let fixed = 0; // pictures and tables keep their size
  const pars = [];
  for (const it of layout) {
    if (it.block.type === 'p') pars.push(it);
    else fixed += it.height || 0;
    if (it.inner) pars.push(...it.inner); // the text of a box (a cover read as text): shrinks with the page, in the box's width
  }
  if (!pars.length) return { scale: 1, spacing: 1 };
  const heightAt = (scale) => {
    let flex = 0;
    for (const it of pars) {
      const lineW = ((it.width || contentW) - (it.block.firstLine || 0) * 0.5) * WRAP;
      const lines = Math.max(1, Math.ceil(textWidth(it.block, scale, o) / lineW));
      flex += it.before + lines * it.lineGap;
    }
    return flex;
  };
  for (let scale = 1; scale >= MIN_SCALE - 1e-9; scale -= STEP) {
    if (fixed + heightAt(scale) <= avail) return { scale, spacing: 1 };
  }
  // still too tall at the smallest font: tighten the lines as well
  const flex = heightAt(MIN_SCALE);
  return { scale: MIN_SCALE, spacing: Math.max(0.5, (avail - fixed) / Math.max(1, flex)) };
}

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
// took more lines in Word than estimated (used when no font can be measured)
const WRAP = 0.9;
// laying the words out as Word does: the share of a line the measured words may fill
const FILL = 0.95;
const MIN_SCALE = 0.6;
const MAX_GROW = 1.15; // "a little larger, not much"
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

const widths = new Map(); // "font|word" -> width at 100pt

/**
 * How many lines Word sets a paragraph in, `scale` times its sizes, in a column `lineW` wide: its words laid one after another
 * and a new line begun where the next word does not fit, as Word breaks lines (measured with the real font file). Lines are
 * filled to FILL of the column only: Word's widths are not quite the canvas's.
 */
export function linesOf(par, scale, o, lineW, firstLine = 0) {
  if (!canvas) return Math.max(1, Math.ceil(textWidth(par, scale, o) / ((lineW - firstLine) * WRAP)));
  let lines = 1;
  let used = firstLine;
  let room = lineW * FILL;
  for (const r of par.runs) {
    if (!r.text) continue;
    const pt = (r.fs || par.fs || 12) * scale;
    const f = fontFor(ARABIC_ANY.test(r.text) ? o.arabicFont : o.latinFont, !!(r.bold || r.verse));
    const font = `${f.bold ? 'bold ' : ''}100px "${f.family}"`;
    const width = (word) => {
      const k = `${font}|${word}`;
      if (!widths.has(k)) { canvas.ctx.font = font; widths.set(k, canvas.ctx.measureText(word).width); }
      return (widths.get(k) * pt) / 100;
    };
    const space = width(' ');
    r.text.split(/(\s+)/).forEach((word) => {
      if (!word) return;
      if (/^\s+$/.test(word)) { used += space; return; }
      const ww = width(word);
      if (used > 0 && used + ww > room) { lines++; used = 0; }
      used += ww;
      while (used > room) { lines++; used -= room; } // a word longer than the line
    });
  }
  return lines;
}

/** A page's room: the space its text may take, and the height of its text at `scale` times its font and `spacing` times its lines. */
function measurePage(page, layout, o) {
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
  const heightAt = (scale, spacing = 1) => {
    let flex = 0;
    for (const it of pars) {
      const lines = linesOf(it.block, scale, o, it.width || contentW, it.block.firstLine || 0);
      flex += (it.before + lines * it.lineGap) * spacing;
    }
    return flex;
  };
  // growing is a choice, not a need: it keeps a line to spare, as Word may wrap a paragraph a line longer than measured
  const spare = Math.max(0, ...pars.map((it) => it.lineGap));
  return { avail, fixed, pars, heightAt, spare };
}

/**
 * How much larger the text of a book may be set (font and line spacing alike): Traditional Arabic draws small for its size, and a
 * page whose text fills three quarters of it tires the eye. The full pages of the book (text over half their height) each have
 * room to grow by some amount; the book takes what three in four of them have room for, and never more than a little
 * (MAX_GROW). The fullest pages are brought back down to what their own page holds by fitPage (never below the measured size).
 * @param {{page, layout}[]} pages
 * @returns {Promise<number>} 1 = as measured
 */
export async function bookGrowth(pages, o) {
  await measureContext();
  const rooms = [];
  for (const { page, layout } of pages) {
    const m = measurePage(page, layout, o);
    if (!m.pars.length || m.fixed + m.heightAt(1) < m.avail * 0.5) continue; // a title page, the end of a chapter
    let s = MAX_GROW;
    while (s > 1 + 1e-9 && m.fixed + m.heightAt(s, s) > m.avail - m.spare * s) s -= STEP;
    rooms.push(Math.max(1, s));
  }
  if (!rooms.length) return 1;
  rooms.sort((a, b) => a - b);
  return rooms[Math.floor(rooms.length * 0.75)];
}

/**
 * How to fit one page so it stays one page: the book's growth (o.grow) where it has room for it, less where it has not, and
 * shrunk below the measured size where even that does not fit.
 * @param page page model; `layout` = [{block, before, lineGap}] as the section builder places them
 * @returns {{scale:number, spacing:number}} font scale and line-spacing scale (1 = as printed)
 */
export async function fitPage(page, layout, o) {
  await measureContext();
  const { avail, fixed, pars, heightAt, spare } = measurePage(page, layout, o);
  if (!pars.length) return { scale: 1, spacing: 1 };
  for (let s = o.grow || 1; s > 1 + 1e-9; s -= STEP) {
    if (fixed + heightAt(s, s) <= avail - spare * s) return { scale: s, spacing: s };
  }
  for (let scale = 1; scale >= MIN_SCALE - 1e-9; scale -= STEP) {
    if (fixed + heightAt(scale) <= avail) return { scale, spacing: 1 };
  }
  // still too tall at the smallest font: tighten the lines as well
  const flex = heightAt(MIN_SCALE);
  return { scale: MIN_SCALE, spacing: Math.max(0.5, (avail - fixed) / Math.max(1, flex)) };
}

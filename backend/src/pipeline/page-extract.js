// Worker-side PDF page processing: raw extraction -> layout -> page model.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import {
  splitMarksAndBases, attachMarks, groupLines, findGutters, splitLinesIntoSegments, assembleSegment,
  tokensToRuns, xyCut, detectTables, linesToParagraphs, median,
} from './layout.js';
import { dominantDirection, reversalEvidence, textQuality, normalizeShaping } from './arabic.js';

const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const CMAP_URL = `${pathToFileURL(path.join(pdfjsRoot, 'cmaps')).href}/`;
const FONT_URL = `${pathToFileURL(path.join(pdfjsRoot, 'standard_fonts')).href}/`;
const { OPS } = pdfjs;

export async function openPdf(file) {
  const task = pdfjs.getDocument({
    url: pathToFileURL(file).href,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: FONT_URL,
    useSystemFonts: false,
    isEvalSupported: false,
    fontExtraProperties: true,
    verbosity: 0,
    disableAutoFetch: true,
    disableStream: false,
  });
  return task.promise;
}

// ---- matrices ---------------------------------------------------------------
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function fontInfo(page, fontName, cache) {
  if (cache.has(fontName)) return cache.get(fontName);
  let info = { bold: false, italic: false, name: '' };
  try {
    const f = page.commonObjs.get(fontName);
    const name = String(f?.name || f?.fallbackName || '');
    info = {
      name,
      bold: /bold|black|heavy|demi|semibold/i.test(name) || !!f?.bold,
      italic: /italic|oblique/i.test(name) || !!f?.italic,
    };
  } catch { /* font not resolved */ }
  cache.set(fontName, info);
  return info;
}

/** Parse pdf.js constructPath data into polylines in user space. */
function parsePath(data) {
  const subs = [];
  let cur = null;
  let i = 0;
  while (i < data.length) {
    const code = data[i++];
    if (code === 0) {
      cur = [[data[i++], data[i++]]];
      subs.push(cur);
    } else if (code === 1) {
      (cur ||= (subs.push([]), subs[subs.length - 1])).push([data[i++], data[i++]]);
    } else if (code === 2) i += 6;
    else if (code === 3) i += 4;
    else if (code === 4 && cur && cur.length) cur.push(cur[0]);
  }
  return subs;
}

const STROKE_OPS = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const FILL_OPS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);

async function walkOperators(page, viewport, fontCache) {
  const list = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const rulings = [];
  const images = [];
  const glyphItems = [];
  const vt = viewport.transform;
  // text state
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let tfs = 1;
  let tc = 0;
  let tw = 0;
  let th = 1;
  let tl = 0;
  let rise = 0;
  let fontStyle = { bold: false, italic: false };
  const move = (tx, ty) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  const showGlyphs = (arr) => {
    for (const g of arr) {
      if (typeof g === 'number') {
        tm = mul([1, 0, 0, 1, (-g / 1000) * tfs * th, 0], tm);
        continue;
      }
      if (!g || typeof g !== 'object') continue;
      const adv = ((g.width / 1000) * tfs + tc + (g.isSpace ? tw : 0)) * th;
      const m = mul(mul(tm, ctm), vt);
      const p0 = apply(m, 0, rise);
      const p1 = apply(m, adv, rise);
      const up = apply(m, 0, rise + 1);
      const fsEff = Math.abs(tfs) * Math.hypot(up[0] - p0[0], up[1] - p0[1]);
      const uni = g.unicode ?? '';
      if (uni !== '') {
        glyphItems.push({
          str: uni,
          x: Math.min(p0[0], p1[0]),
          y: p0[1],
          w: Math.abs(p1[0] - p0[0]),
          fs: fsEff || 10,
          bold: fontStyle.bold,
          italic: fontStyle.italic,
        });
      }
      tm = mul([1, 0, 0, 1, adv, 0], tm);
    }
  };
  const toVp = (x, y) => {
    const [ux, uy] = apply(ctm, x, y);
    return viewport.convertToViewportPoint(ux, uy);
  };
  const addRuling = (p0, p1) => {
    const dx = Math.abs(p1[0] - p0[0]);
    const dy = Math.abs(p1[1] - p0[1]);
    if (dy <= 1 && dx >= 6) rulings.push({ type: 'h', x0: Math.min(p0[0], p1[0]), x1: Math.max(p0[0], p1[0]), y0: (p0[1] + p1[1]) / 2, y1: (p0[1] + p1[1]) / 2 });
    else if (dx <= 1 && dy >= 6) rulings.push({ type: 'v', y0: Math.min(p0[1], p1[1]), y1: Math.max(p0[1], p1[1]), x0: (p0[0] + p1[0]) / 2, x1: (p0[0] + p1[0]) / 2 });
  };
  const addImage = () => {
    const pts = [toVp(0, 0), toVp(1, 0), toVp(1, 1), toVp(0, 1)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    images.push({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
  };

  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    switch (fn) {
      case OPS.save: stack.push(ctm); break;
      case OPS.restore: if (stack.length) ctm = stack.pop(); break;
      case OPS.transform: ctm = mul(args, ctm); break;
      case OPS.beginText: tm = [1, 0, 0, 1, 0, 0]; tlm = tm; break;
      case OPS.setFont: {
        tfs = args[1];
        const fi = fontInfo(page, args[0], fontCache);
        fontStyle = { bold: fi.bold, italic: fi.italic };
        break;
      }
      case OPS.setTextMatrix: tm = Array.from(args[0]?.length === 6 ? args[0] : args); tlm = tm; break;
      case OPS.moveText: move(args[0], args[1]); break;
      case OPS.setLeadingMoveText: tl = -args[1]; move(args[0], args[1]); break;
      case OPS.nextLine: move(0, -tl); break;
      case OPS.setLeading: tl = args[0]; break;
      case OPS.setCharSpacing: tc = args[0]; break;
      case OPS.setWordSpacing: tw = args[0]; break;
      case OPS.setHScale: th = args[0] / 100; break;
      case OPS.setTextRise: rise = args[0]; break;
      case OPS.showText: showGlyphs(args[0]); break;
      case OPS.showSpacedText: showGlyphs(args[0]); break;
      case OPS.paintFormXObjectBegin: stack.push(ctm); if (args?.[0]) ctm = mul(args[0], ctm); break;
      case OPS.paintFormXObjectEnd: if (stack.length) ctm = stack.pop(); break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintImageXObjectRepeat:
      case OPS.paintJpegXObject:
        addImage();
        break;
      case OPS.constructPath: {
        const paintOp = args[0];
        const isStroke = STROKE_OPS.has(paintOp);
        const isFill = FILL_OPS.has(paintOp);
        if (!isStroke && !isFill) break;
        const data = args[1]?.[0] ?? args[1];
        if (!data || data.length > 4000) break;
        for (const sub of parsePath(data)) {
          const pts = sub.map(([x, y]) => toVp(x, y));
          if (pts.length < 2) continue;
          const xs = pts.map((p) => p[0]);
          const ys = pts.map((p) => p[1]);
          const bx0 = Math.min(...xs);
          const bx1 = Math.max(...xs);
          const by0 = Math.min(...ys);
          const by1 = Math.max(...ys);
          const w = bx1 - bx0;
          const h = by1 - by0;
          const axisAligned = pts.every((p, k) => k === 0 || Math.abs(p[0] - pts[k - 1][0]) < 0.5 || Math.abs(p[1] - pts[k - 1][1]) < 0.5);
          if (isFill && axisAligned && Math.min(w, h) <= 2.5 && Math.max(w, h) >= 6) {
            if (w >= h) rulings.push({ type: 'h', x0: bx0, x1: bx1, y0: (by0 + by1) / 2, y1: (by0 + by1) / 2 });
            else rulings.push({ type: 'v', y0: by0, y1: by1, x0: (bx0 + bx1) / 2, x1: (bx0 + bx1) / 2 });
          } else if (isStroke) {
            for (let k = 1; k < pts.length; k++) addRuling(pts[k - 1], pts[k]);
          }
        }
        break;
      }
      default: break;
    }
  }
  return { rulings, images, glyphItems };
}

export async function rawPage(page) {
  const viewport = page.getViewport({ scale: 1 });
  const fontCache = new Map();
  const { rulings, images, glyphItems } = await walkOperators(page, viewport, fontCache);
  const glyphChars = glyphItems.reduce((n, g) => n + g.str.trim().length, 0);
  // Glyph-level extraction is exact (ligatures, diacritics, visual order). Fall back to
  // pdf.js' own text chunks for pages where it finds almost nothing (e.g. Type3 fonts).
  if (glyphChars >= 12) return { width: viewport.width, height: viewport.height, items: glyphItems, rulings, images, viewport, source: 'glyphs' };
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!('str' in it) || it.str === '') continue;
    const t = it.transform;
    const [x, y] = viewport.convertToViewportPoint(t[4], t[5]);
    const f = fontInfo(page, it.fontName, fontCache);
    items.push({
      str: it.str,
      x,
      y,
      w: Math.abs(it.width * viewport.scale),
      fs: Math.hypot(t[2], t[3]) * viewport.scale || it.height || 10,
      dir: it.dir,
      bold: f.bold,
      italic: f.italic,
    });
  }
  return { width: viewport.width, height: viewport.height, items, rulings, images, viewport, source: 'textContent' };
}

// ---- rendering --------------------------------------------------------------
export async function renderPage(page, dpi, maxSide = 4200) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(dpi / 72, maxSide / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  return { canvas, scale };
}

async function cropImage(canvas, scale, bbox, file) {
  const pad = 0.5;
  const sx = Math.max(0, Math.floor((bbox.x0 - pad) * scale));
  const sy = Math.max(0, Math.floor((bbox.y0 - pad) * scale));
  const sw = Math.min(canvas.width - sx, Math.ceil((bbox.x1 - bbox.x0 + 2 * pad) * scale));
  const sh = Math.min(canvas.height - sy, Math.ceil((bbox.y1 - bbox.y0 + 2 * pad) * scale));
  if (sw < 4 || sh < 4) return null;
  const c = createCanvas(sw, sh);
  c.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  const usePng = sw * sh < 1_500_000;
  const buf = usePng ? c.toBuffer('image/png') : c.toBuffer('image/jpeg', 90);
  const out = `${file}.${usePng ? 'png' : 'jpg'}`;
  await writeFile(out, buf);
  return { file: out, imgType: usePng ? 'png' : 'jpg', wPx: sw, hPx: sh };
}

// ---- text page model ----------------------------------------------------------
const inside = (it, b, tol = 1.5) => {
  const cx = it.x + it.w / 2;
  return cx >= b.x0 - tol && cx <= b.x1 + tol && it.y >= b.y0 - tol && it.y <= b.y1 + tol;
};

function bodyFontSize(bases) {
  const w = new Map();
  for (const b of bases) {
    const k = Math.round(b.fs * 2) / 2;
    w.set(k, (w.get(k) || 0) + b.str.trim().length);
  }
  let best = 11;
  let bn = -1;
  for (const [k, n] of w) if (n > bn) { bn = n; best = k; }
  return best;
}

function buildLineNodes(segments, pageDir, reverseItems) {
  const out = [];
  for (const seg of segments) {
    const { tokens, dir } = assembleSegment(seg, pageDir, { reverseItems });
    const runs = tokensToRuns(tokens);
    const text = runs.map((r) => r.text).join('');
    if (!text.trim()) continue;
    const vis = seg.items.filter((i) => i.str.trim());
    const x0 = Math.min(...vis.map((i) => i.x));
    const x1 = Math.max(...vis.map((i) => i.x + i.w));
    out.push({
      kind: 'line', y: seg.y, fs: seg.fs, col: seg.col ?? 0, dir, runs, text, tokens,
      x0, x1, y0: seg.y - seg.fs * 0.85, y1: seg.y + seg.fs * 0.3,
    });
  }
  return out;
}

function paragraphsFromLines(lines, regionBox) {
  const byCol = new Map();
  for (const l of lines) {
    const e = byCol.get(l.col) || { x0: Infinity, x1: -Infinity };
    e.x0 = Math.min(e.x0, l.x0);
    e.x1 = Math.max(e.x1, l.x1);
    byCol.set(l.col, e);
  }
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const col = byCol.get(run[0].col);
    const r = regionBox || col;
    out.push(...linesToParagraphs(run, { regionW: col.x1 - col.x0, regionX0: r.x0, regionX1: r.x1 }));
    run = [];
  };
  for (const l of lines) {
    if (run.length && run[run.length - 1].col !== l.col) flush();
    run.push(l);
  }
  flush();
  return out;
}

export function buildTextPage(raw, opts = {}) {
  const { bases, marks } = splitMarksAndBases(raw.items);
  attachMarks(bases, marks);
  const fsBody = bodyFontSize(bases);
  const allText = bases.map((b) => normalizeShaping(b.str)).join(' ');
  const pageDir = dominantDirection(allText) || opts.defaultDir || 'ltr';

  // tables
  const tables = detectTables(raw.rulings, raw.width, raw.height).filter((t) => bases.some((b) => inside(b, t.bbox)));
  const tableOf = (it) => tables.find((t) => inside(it, t.bbox));
  const body = [];
  const perTable = new Map(tables.map((t) => [t, []]));
  for (const b of bases) {
    const t = tableOf(b);
    if (t) perTable.get(t).push(b);
    else body.push(b);
  }

  const lines = groupLines(body);
  const gutters = findGutters(lines, fsBody);
  const segments = splitLinesIntoSegments(lines, gutters);

  let reversed = false;
  let lineNodes = buildLineNodes(segments, pageDir, false);
  const evidence = reversalEvidence(lineNodes.map((l) => l.text).join(' '));
  if (opts.reverseHint === true || (opts.reverseHint == null && evidence.reversed)) {
    reversed = true;
    lineNodes = buildLineNodes(segments, pageDir, true);
  }

  // table blocks
  const tableBlocks = tables.map((t) => buildTable(t, perTable.get(t), pageDir, reversed, fsBody));

  // images worth keeping (figures, not full-page backgrounds / tiny glyph-like bits)
  const pageArea = raw.width * raw.height;
  const figures = raw.images
    .filter((im) => {
      const w = im.x1 - im.x0;
      const h = im.y1 - im.y0;
      return w >= 10 && h >= 10 && w * h >= 600 && w * h < pageArea * 0.85;
    })
    .filter((im) => !tableBlocks.some((t) => im.x0 >= t.bbox.x0 - 2 && im.x1 <= t.bbox.x1 + 2 && im.y0 >= t.bbox.y0 - 2 && im.y1 <= t.bbox.y1 + 2));

  const nodes = [
    ...lineNodes,
    ...tableBlocks.map((t) => ({ kind: 'table', ref: t, ...t.bbox })),
    ...figures.map((f) => ({ kind: 'image', ref: f, ...f })),
  ];
  const gutterMin = Math.max(12, fsBody * 1.2);
  const ordered = xyCut(nodes, { rtl: pageDir === 'rtl', gutterMin, rowGapMin: 0 });

  const blocks = [];
  let pending = [];
  const flushLines = () => {
    if (pending.length) blocks.push(...paragraphsFromLines(pending));
    pending = [];
  };
  for (const n of ordered) {
    if (n.kind === 'line') pending.push(n);
    else {
      flushLines();
      blocks.push(n.kind === 'table' ? n.ref : { type: 'image', bbox: { x0: n.x0, x1: n.x1, y0: n.y0, y1: n.y1 }, pending: true });
    }
  }
  flushLines();

  return {
    blocks,
    pageDir,
    fsBody,
    figures,
    stats: {
      chars: allText.replace(/\s+/g, '').length,
      reversedFixed: reversed,
      reversalEvidence: { fwd: evidence.fwd, rev: evidence.rev },
      tables: tableBlocks.length,
      columns: gutters.length ? gutters.length + 1 : 1,
    },
  };
}

function buildTable(t, items, pageDir, reversed, fsBody) {
  const text = items.map((i) => normalizeShaping(i.str)).join(' ');
  const rtl = (dominantDirection(text) || pageDir) === 'rtl';
  const cells = t.cells.map((c) => {
    const its = items.filter((i) => inside(i, c, 2.5));
    const lines = groupLines(its);
    const segs = lines.map((l) => ({ ...l, col: 0 }));
    const nodes = buildLineNodes(segs, rtl ? 'rtl' : 'ltr', reversed);
    const paras = nodes.length
      ? linesToParagraphs(nodes.map((n) => ({ ...n, breakBefore: false })), { regionW: c.x1 - c.x0, regionX0: c.x0, regionX1: c.x1 })
      : [];
    const col = rtl ? t.nC - c.c - c.colspan : c.c;
    return { r: c.r, c: col, rowspan: c.rowspan, colspan: c.colspan, paras, bbox: { x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 } };
  });
  const colWidths = t.xs.slice(1).map((x, i) => x - t.xs[i]);
  if (rtl) colWidths.reverse();
  const rowHeights = t.ys.slice(1).map((y, i) => y - t.ys[i]);
  void fsBody;
  return { type: 'table', rtl, nR: t.nR, nC: t.nC, colWidths, rowHeights, cells, bbox: t.bbox };
}

// ---- page finalisation (margins, figure files) --------------------------------------
export async function finalizeBlocks(page, raw, model, { workDir, pageNum }) {
  const figs = model.blocks.filter((b) => b.type === 'image');
  if (figs.length) {
    const { canvas, scale } = await renderPage(page, 200);
    let k = 0;
    for (const b of figs) {
      const saved = await cropImage(canvas, scale, b.bbox, path.join(workDir, `p${pageNum}_i${k++}`));
      if (saved) Object.assign(b, saved, { wPt: b.bbox.x1 - b.bbox.x0, hPt: b.bbox.y1 - b.bbox.y0, pending: false });
      else b.drop = true;
    }
    model.blocks = model.blocks.filter((b) => !b.drop);
  }
  return model;
}

export function pageText(model) {
  const parts = [];
  for (const b of model.blocks) {
    if (b.type === 'p') parts.push(b.runs.map((r) => r.text).join(''));
    else if (b.type === 'table') for (const c of b.cells) for (const p of c.paras) parts.push(p.runs.map((r) => r.text).join(''));
  }
  return parts.join('\n');
}

export function contentBox(blocks, width, height) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const b of blocks) {
    const bb = b.bbox || { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 };
    if (bb.x0 == null) continue;
    x0 = Math.min(x0, bb.x0);
    x1 = Math.max(x1, bb.x1);
    y0 = Math.min(y0, bb.y0);
    y1 = Math.max(y1, bb.y1);
  }
  if (!isFinite(x0)) return { left: 36, right: 36, top: 36, bottom: 36 };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return {
    left: clamp(x0 - 1, 10, width * 0.45),
    right: clamp(width - x1 - 1, 10, width * 0.45),
    top: clamp(y0 - 1, 10, height * 0.45),
    bottom: clamp(height - y1 - 18, 10, height * 0.45),
  };
}

export { median, textQuality };

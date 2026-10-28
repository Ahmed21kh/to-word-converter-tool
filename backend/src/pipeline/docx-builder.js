// Builds the .docx from page models. One Word section per source page keeps pages in order
// and at the original size; Arabic runs are flagged right-to-left with complex-script fonts.
import { readFile } from 'node:fs/promises';
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, WidthType, AlignmentType,
  HeadingLevel, SectionType, LineRuleType, TableLayoutType, PageOrientation, VerticalAlign,
  CommentRangeStart, CommentRangeEnd, CommentReference, BorderStyle, Tab, TabStopType,
} from 'docx';
import { ARABIC_ANY, ARABIC_LETTER, UNMAPPED } from './arabic.js';
import { fitPage } from './page-fit.js';

const TW = 20; // twips per point
const tw = (pt) => Math.max(0, Math.round(pt * TW));
const hp = (pt) => Math.max(2, Math.round(pt * 2)); // half-points

// ---- script segmentation --------------------------------------------------------
const ARABIC_DIGIT = /[٠-٩۰-۹]/;
const kindOf = (c) => {
  if (c === UNMAPPED) return 'bad';
  if (ARABIC_ANY.test(c) || ARABIC_DIGIT.test(c)) return 'ar';
  if (/[\p{L}]/u.test(c)) return 'lat';
  return 'neutral';
};

/** Split text into [{text, kind: 'ar'|'lat'|'bad'}]; neutrals join the preceding segment. */
export function segmentText(text, paragraphRtl) {
  const segs = [];
  let pendingNeutral = '';
  for (const ch of text) {
    const k = kindOf(ch);
    if (k === 'neutral') {
      pendingNeutral += ch;
      continue;
    }
    const last = segs[segs.length - 1];
    if (last && last.kind === k && k !== 'bad') {
      last.text += pendingNeutral + ch;
    } else {
      if (pendingNeutral) {
        if (last) last.text += pendingNeutral;
        else segs.push({ text: pendingNeutral, kind: paragraphRtl ? 'ar' : 'lat' });
      }
      segs.push({ text: ch, kind: k });
    }
    pendingNeutral = '';
  }
  if (pendingNeutral) {
    if (segs.length) segs[segs.length - 1].text += pendingNeutral;
    else segs.push({ text: pendingNeutral, kind: paragraphRtl ? 'ar' : 'lat' });
  }
  return segs;
}

function fontSet(name) {
  return { ascii: name, hAnsi: name, cs: name, eastAsia: name };
}

// a word the reader was unsure about carries its other possible readings as a Word comment (r.alts)
function addComment(o, alts) {
  const id = o.comments.length;
  o.comments.push({
    id,
    author: 'AI',
    initials: 'AI',
    date: new Date(),
    children: [new Paragraph({
      bidirectional: true,
      children: [new TextRun({ text: `${o.commentLabel || 'قراءات أخرى محتملة'}: ${alts.join(' / ')}`, font: fontSet(o.arabicFont), rightToLeft: true })],
    })],
  });
  return id;
}

function runsToTextRuns(runs, par, o) {
  const out = [];
  const rtlPar = par.dir === 'rtl';
  for (const r of runs) {
    if (!r.text) continue;
    const cid = o.highlightUncertain && r.alts && r.alts.length && o.comments ? addComment(o, r.alts) : -1;
    if (cid >= 0) out.push(new CommentRangeStart(cid));
    if (r.tab) out.push(new TextRun({ children: [new Tab()], rightToLeft: rtlPar })); // a running head: to the far end of the line
    for (const seg of segmentText(r.text, rtlPar)) {
      const isAr = seg.kind === 'ar' || (seg.kind === 'bad' && rtlPar);
      const fontName = isAr ? o.arabicFont : o.latinFont;
      // a page shrunk to fit (printMatch) rounds down, never past the size that was measured to fit
      const size = o.fsScale < 1 ? Math.max(2, Math.floor((r.fs || par.fs || 12) * o.fsScale * 2)) : hp(r.fs || par.fs || 12);
      const bad = seg.kind === 'bad';
      out.push(new TextRun({
        text: seg.text,
        font: fontSet(fontName),
        size,
        sizeComplexScript: size,
        bold: !!(r.bold || r.verse),
        boldComplexScript: !!(r.bold || r.verse),
        italics: !!r.italic,
        italicsComplexScript: !!r.italic,
        rightToLeft: isAr,
        language: isAr ? { value: 'en-US', bidirectional: 'ar-SA' } : { value: 'en-US' },
        highlight: bad || (o.highlightUncertain && r.lowConf) ? 'yellow' : undefined,
        color: bad ? 'C00000' : undefined,
      }));
    }
    if (cid >= 0) out.push(new CommentRangeEnd(cid), new TextRun({ children: [new CommentReference(cid)] }));
  }
  return out;
}

function headingFor(par, bodyFs, o) {
  if (!o.detectHeadings || !par.fs || !bodyFs) return undefined;
  const len = par.runs.reduce((s, r) => s + r.text.length, 0);
  if (par.lineCount > 2 || len > 140 || len < 2) return undefined;
  const ratio = par.fs / bodyFs;
  if (ratio >= 1.7) return HeadingLevel.HEADING_1;
  if (ratio >= 1.45) return HeadingLevel.HEADING_2;
  if (ratio >= 1.3) return HeadingLevel.HEADING_3;
  return undefined;
}

const ALIGN = { center: AlignmentType.CENTER, both: AlignmentType.BOTH, end: AlignmentType.END };

const lineGapOf = (par) => (par.lineGap && par.lineGap > par.fs * 0.9 && par.lineGap < par.fs * 4 ? par.lineGap : (par.fs || 12) * 1.45);

const HEAD_RULE = { style: BorderStyle.SINGLE, size: 6, space: 4, color: '000000' };

function buildParagraph(par, ctx) {
  const { o, bodyFs, spaceBefore = 0, noSpacing = false, spacingScale = 1, contentW } = ctx;
  const lineGap = lineGapOf(par) * spacingScale;
  // a running head (printMatch): the rule that sets it off from the text, as printed
  let border = par.ruleAbove ? { top: { style: BorderStyle.SINGLE, size: 6, space: 8, color: '000000' } } : undefined;
  if (par.runningHead) border = par.runningHead === 'top' ? { bottom: HEAD_RULE } : { top: HEAD_RULE };
  return new Paragraph({
    bidirectional: par.dir === 'rtl',
    alignment: ALIGN[par.align],
    heading: par.runningHead ? undefined : headingFor(par, bodyFs, o),
    indent: par.firstLine ? { firstLine: tw(par.firstLine) } : undefined,
    tabStops: par.runningHead && contentW ? [{ type: TabStopType.END, position: tw(contentW) - 10 }] : undefined,
    border,
    spacing: {
      before: noSpacing ? 0 : tw(Math.min(spaceBefore, 220) * spacingScale),
      after: 0,
      line: tw(lineGap),
      // printMatch: exact line heights, so the page holds exactly the lines it was measured for
      lineRule: o.printMatch && !noSpacing ? LineRuleType.EXACT : LineRuleType.AT_LEAST,
    },
    widowControl: o.printMatch ? false : undefined,
    children: runsToTextRuns(par.runs, par, o),
  });
}

function imageSize(block, contentW) {
  const maxW = Math.max(20, contentW);
  let w = block.wPt || block.bbox.x1 - block.bbox.x0;
  let h = block.hPt || block.bbox.y1 - block.bbox.y0;
  if (w > maxW) {
    h *= maxW / w;
    w = maxW;
  }
  return { w, h };
}

async function buildImage(block, contentW, o, region) {
  const data = await readFile(block.file);
  const { w, h } = imageSize(block, contentW);
  const pxW = Math.max(1, Math.round((w * 96) / 72));
  const pxH = Math.max(1, Math.round((h * 96) / 72));
  const centered = region && Math.abs((block.bbox.x0 - region.x0) - (region.x1 - block.bbox.x1)) <= (region.x1 - region.x0) * 0.06;
  return new Paragraph({
    alignment: centered || block.fullPage ? AlignmentType.CENTER : undefined,
    bidirectional: o.pageDir === 'rtl',
    spacing: { before: 0, after: 0 },
    children: [new ImageRun({
      type: block.imgType === 'jpg' ? 'jpg' : 'png',
      data,
      transformation: { width: pxW, height: pxH },
      altText: { name: 'Image', title: 'Image', description: 'Image from the original document (kept as-is)' },
    })],
  });
}

// the box around a cover / title page read as text (printMatch): its padding, and the gap between its lines
const CARD_PAD = { top: 8, bottom: 8, side: 10 };
const CARD_GAP = 4;
const CARD_BORDER = { style: BorderStyle.SINGLE, size: 12, color: '1F3864' };

/** A cover / title page read as text: its lines centred in a bordered box, as Shamela shows a book's card. */
function buildCard(block, ctx) {
  const w = tw(block.colWidths[0]);
  // the title of a cover is not a heading of the book (it would show up in its table of contents)
  const o = { ...ctx.o, detectHeadings: false };
  const paras = block.cells[0].paras.map((p, i) => buildParagraph(p, { ...ctx, o, spaceBefore: i ? CARD_GAP : 0 }));
  const border = { top: CARD_BORDER, bottom: CARD_BORDER, left: CARD_BORDER, right: CARD_BORDER };
  return new Table({
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: w, type: WidthType.DXA },
        margins: { top: tw(CARD_PAD.top), bottom: tw(CARD_PAD.bottom), left: tw(CARD_PAD.side), right: tw(CARD_PAD.side) },
        borders: border,
        shading: { fill: 'EAF0FA', color: 'auto', type: 'clear' },
        children: paras,
      })],
    })],
    columnWidths: [w],
    width: { size: w, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    visuallyRightToLeft: true,
    alignment: AlignmentType.CENTER,
    borders: { ...border, insideHorizontal: CARD_BORDER, insideVertical: CARD_BORDER },
  });
}

function buildTable(block, ctx) {
  if (block.card) return buildCard(block, ctx);
  const { contentW } = ctx;
  const totalPt = block.colWidths.reduce((a, b) => a + b, 0);
  const scale = Math.min(1, contentW / Math.max(1, totalPt));
  const widths = block.colWidths.map((w) => Math.max(tw(18), tw(w * scale)));
  const rows = [];
  for (let r = 0; r < block.nR; r++) {
    const cells = block.cells.filter((c) => c.r === r).sort((a, b) => a.c - b.c);
    rows.push(new TableRow({
      cantSplit: true,
      height: { value: tw(block.rowHeights[r]), rule: 'atLeast' },
      children: cells.map((c) => {
        let w = 0;
        for (let k = c.c; k < c.c + c.colspan; k++) w += widths[k] || 0;
        const paras = c.paras.length
          ? c.paras.map((p) => buildParagraph(p, { ...ctx, noSpacing: true }))
          : [new Paragraph({ bidirectional: block.rtl, children: [] })];
        return new TableCell({
          columnSpan: c.colspan > 1 ? c.colspan : undefined,
          rowSpan: c.rowspan > 1 ? c.rowspan : undefined,
          width: { size: w, type: WidthType.DXA },
          verticalAlign: VerticalAlign.CENTER,
          margins: { top: 40, bottom: 40, left: 80, right: 80 },
          children: paras,
        });
      }),
    }));
  }
  return new Table({
    rows,
    columnWidths: widths,
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    visuallyRightToLeft: !!block.rtl,
    alignment: block.rtl ? AlignmentType.START : undefined,
  });
}

function documentBodySize(pages) {
  const w = new Map();
  for (const p of pages) {
    for (const b of p.blocks) {
      if (b.type !== 'p' || !b.fs) continue;
      const k = Math.round(b.fs * 2) / 2;
      const len = b.runs.reduce((s, r) => s + r.text.length, 0);
      w.set(k, (w.get(k) || 0) + len);
    }
  }
  let best = 0;
  let n = -1;
  for (const [k, v] of w) if (v > n) { n = v; best = k; }
  return best;
}

async function buildSection(page, bodyFs, o) {
  const { width, height, blocks, margins } = page;
  const contentW = width - margins.left - margins.right;
  const children = [];
  const region = { x0: margins.left, x1: width - margins.right };

  // where each block goes: the space above a paragraph reproduces the gap between the printed lines
  const layout = [];
  let prev = null; // {bottom} in points
  for (const b of blocks) {
    if (b.type === 'p') {
      const lh = b.lineGap && b.lineGap > b.fs * 0.9 ? b.lineGap : b.fs * 1.45;
      let before = 0;
      if (page.flow || b.firstBaseline == null) before = 0;
      else if (prev) before = Math.max(0, (b.firstBaseline - lh * 0.8) - prev.bottom);
      else before = Math.max(0, b.firstBaseline - lh * 0.8 - margins.top);
      layout.push({ block: b, before: Math.min(before, 220), lineGap: lineGapOf(b) });
      if (b.lastBaseline != null) prev = { bottom: b.lastBaseline + lh * 0.2 };
    } else if (b.type === 'table' && b.card) {
      // its lines are text like any other: the page fit may make them smaller
      const width = b.colWidths[0] - CARD_PAD.side * 2;
      const inner = b.cells[0].paras.map((p, i) => ({ block: p, before: i ? CARD_GAP : 0, lineGap: lineGapOf(p), width }));
      layout.push({ block: b, inner, height: CARD_PAD.top + CARD_PAD.bottom + 6 }); // + borders and the paragraph after the table
    } else if (b.type === 'table') {
      layout.push({ block: b, height: (b.rowHeights || []).reduce((a, h) => a + h, 0) + 1 });
      prev = { bottom: b.bbox.y1 };
    } else if (b.type === 'image') {
      layout.push({ block: b, height: imageSize(b, contentW).h });
      prev = { bottom: b.bbox.y1 };
    }
  }

  // printMatch: shrink this page's text until it is sure to stay one Word page
  const fit = o.printMatch ? await fitPage(page, layout, o) : { scale: 1, spacing: 1 };
  if (fit.scale < 1 || fit.spacing < 1) o.fitted.push({ n: page.n, scale: fit.scale, spacing: fit.spacing });
  const po = fit.scale < 1 ? { ...o, fsScale: fit.scale } : o;
  const ctxBase = { o: po, bodyFs, contentW, spacingScale: fit.spacing };

  for (const it of layout) {
    const b = it.block;
    if (b.type === 'p') {
      children.push(buildParagraph(b, { ...ctxBase, spaceBefore: it.before }));
    } else if (b.type === 'table') {
      children.push(buildTable(b, ctxBase));
      children.push(new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT }, children: [] }));
    } else if (b.type === 'image') {
      children.push(await buildImage(b, contentW, o, region));
    }
  }
  if (!children.length) children.push(new Paragraph({ children: [] }));

  const landscape = width > height;
  return {
    properties: {
      type: SectionType.NEXT_PAGE,
      page: {
        size: landscape
          ? { width: tw(height), height: tw(width), orientation: PageOrientation.LANDSCAPE }
          : { width: tw(width), height: tw(height) },
        margin: {
          top: tw(margins.top), bottom: tw(margins.bottom), left: tw(margins.left), right: tw(margins.right), header: 0, footer: 0,
        },
      },
    },
    children,
  };
}

/**
 * @param pages page models (in order)
 * @param o { arabicFont, latinFont, detectHeadings, title, pageDir }
 * @returns {Promise<Buffer>}
 */
export async function buildDocx(pages, opts) {
  const o = { ...opts, comments: [], fitted: [] };
  const bodyFs = documentBodySize(pages);
  const sections = [];
  for (const p of pages) sections.push(await buildSection(p, bodyFs, o));
  const headingRun = (size) => ({ size, bold: false, color: '000000', font: fontSet(o.arabicFont) });
  const headingPara = { spacing: { before: 0, after: 0 }, keepNext: false, keepLines: false };
  const doc = new Document({
    creator: 'PDF to Word Converter',
    title: o.title || 'Converted document',
    description: 'Converted from PDF',
    features: { updateFields: false },
    comments: { children: o.comments },
    styles: {
      default: {
        document: {
          run: { font: fontSet(o.arabicFont), size: 24, sizeComplexScript: 24 },
          paragraph: { spacing: { after: 0 } },
        },
        heading1: { run: headingRun(48), paragraph: headingPara },
        heading2: { run: headingRun(40), paragraph: headingPara },
        heading3: { run: headingRun(34), paragraph: headingPara },
      },
    },
    sections,
  });
  const buffer = await Packer.toBuffer(doc);
  if (opts.stats) opts.stats.fitted = o.fitted; // printMatch: the pages whose text was made smaller to stay one page
  return buffer;
}

export { ARABIC_LETTER };

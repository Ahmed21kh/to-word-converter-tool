// Builds the .docx from page models. One Word section per source page keeps pages in order
// and at the original size; Arabic runs are flagged right-to-left with complex-script fonts.
import { readFile } from 'node:fs/promises';
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, WidthType, AlignmentType,
  HeadingLevel, SectionType, LineRuleType, TableLayoutType, PageOrientation, VerticalAlign,
} from 'docx';
import { ARABIC_ANY, ARABIC_LETTER, UNMAPPED } from './arabic.js';

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

function runsToTextRuns(runs, par, o) {
  const out = [];
  const rtlPar = par.dir === 'rtl';
  for (const r of runs) {
    if (!r.text) continue;
    for (const seg of segmentText(r.text, rtlPar)) {
      const isAr = seg.kind === 'ar' || (seg.kind === 'bad' && rtlPar);
      const fontName = isAr ? o.arabicFont : o.latinFont;
      const size = hp(r.fs || par.fs || 12);
      const bad = seg.kind === 'bad';
      out.push(new TextRun({
        text: seg.text,
        font: fontSet(fontName),
        size,
        sizeComplexScript: size,
        bold: !!r.bold,
        boldComplexScript: !!r.bold,
        italics: !!r.italic,
        italicsComplexScript: !!r.italic,
        rightToLeft: isAr,
        language: isAr ? { value: 'en-US', bidirectional: 'ar-SA' } : { value: 'en-US' },
        highlight: bad || r.lowConf ? 'yellow' : undefined,
        color: bad ? 'C00000' : undefined,
      }));
    }
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

function buildParagraph(par, ctx) {
  const { o, bodyFs, spaceBefore = 0, noSpacing = false } = ctx;
  const lineGap = par.lineGap && par.lineGap > par.fs * 0.9 && par.lineGap < par.fs * 4 ? par.lineGap : (par.fs || 12) * 1.45;
  return new Paragraph({
    bidirectional: par.dir === 'rtl',
    alignment: ALIGN[par.align],
    heading: headingFor(par, bodyFs, o),
    spacing: {
      before: noSpacing ? 0 : tw(Math.min(spaceBefore, 220)),
      after: 0,
      line: tw(lineGap),
      lineRule: LineRuleType.AT_LEAST,
    },
    children: runsToTextRuns(par.runs, par, o),
  });
}

async function buildImage(block, contentW, o, region) {
  const data = await readFile(block.file);
  const maxW = Math.max(20, contentW);
  let w = block.wPt || block.bbox.x1 - block.bbox.x0;
  let h = block.hPt || block.bbox.y1 - block.bbox.y0;
  if (w > maxW) {
    h *= maxW / w;
    w = maxW;
  }
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

function buildTable(block, ctx) {
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
  let prev = null; // {bottom} in points
  const ctxBase = { o, bodyFs, contentW };

  for (const b of blocks) {
    if (b.type === 'p') {
      const lh = b.lineGap && b.lineGap > b.fs * 0.9 ? b.lineGap : b.fs * 1.45;
      let before = 0;
      if (page.flow) before = 0;
      else if (prev) before = Math.max(0, (b.firstBaseline - lh * 0.8) - prev.bottom);
      else before = Math.max(0, b.firstBaseline - lh * 0.8 - margins.top);
      children.push(buildParagraph(b, { ...ctxBase, spaceBefore: before }));
      prev = { bottom: b.lastBaseline + lh * 0.2 };
    } else if (b.type === 'table') {
      children.push(buildTable(b, ctxBase));
      children.push(new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACTLY }, children: [] }));
      prev = { bottom: b.bbox.y1 };
    } else if (b.type === 'image') {
      children.push(await buildImage(b, contentW, o, region));
      prev = { bottom: b.bbox.y1 };
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
export async function buildDocx(pages, o) {
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
  return Packer.toBuffer(doc);
}

export { ARABIC_LETTER };

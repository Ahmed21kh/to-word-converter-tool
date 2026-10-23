// Writes a compact, page-by-page preview of the converted document (NDJSON: one page per line)
// from the same page models the docx is built from, i.e. after Quran verification.
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const round = (n) => Math.round(n * 10) / 10;

const simplifyRuns = (runs) => runs.map((r) => {
  const o = { x: r.text };
  if (r.bold) o.b = 1;
  if (r.italic) o.i = 1;
  if (r.lowConf) o.l = 1;
  if (r.fs) o.s = round(r.fs);
  return o;
});

function simplifyPara(p, before = 0) {
  return {
    t: 'p',
    dir: p.dir,
    al: p.align,
    fs: round(p.fs || 12),
    sb: round(before),
    lh: p.lineGap ? round(p.lineGap) : undefined,
    runs: simplifyRuns(p.runs),
  };
}

async function simplifyPage(page, previewDir) {
  const { margins, blocks } = page;
  const out = [];
  let prevBottom = null;
  let imgIdx = 0;
  for (const b of blocks) {
    if (b.type === 'p') {
      const lh = b.lineGap && b.lineGap > b.fs * 0.9 ? b.lineGap : (b.fs || 12) * 1.45;
      let before = 0;
      if (!page.flow && b.firstBaseline !== undefined) {
        before = prevBottom === null ? Math.max(0, b.firstBaseline - lh * 0.8 - margins.top) : Math.max(0, b.firstBaseline - lh * 0.8 - prevBottom);
        before = Math.min(before, 220);
        prevBottom = b.lastBaseline + lh * 0.2;
      }
      out.push(simplifyPara(b, before));
    } else if (b.type === 'table') {
      out.push({
        t: 't',
        rtl: !!b.rtl,
        widths: b.colWidths.map(round),
        cells: b.cells.map((c) => ({ r: c.r, c: c.c, rs: c.rowspan, cs: c.colspan, ps: c.paras.map((p) => simplifyPara(p)) })),
        rows: b.nR,
      });
      prevBottom = b.bbox.y1;
    } else if (b.type === 'image' && b.file) {
      const ext = path.extname(b.file) || '.png';
      const name = `p${page.n}_${imgIdx++}${ext}`;
      await copyFile(b.file, path.join(previewDir, name)).catch(() => {});
      out.push({ t: 'i', img: name, w: round(b.wPt || b.bbox.x1 - b.bbox.x0), h: round(b.hPt || b.bbox.y1 - b.bbox.y0), full: b.fullPage ? 1 : undefined });
      prevBottom = b.bbox.y1;
    }
  }
  return {
    n: page.n,
    w: round(page.width),
    h: round(page.height),
    m: [margins.top, margins.right, margins.bottom, margins.left].map(round),
    method: page.method,
    flow: page.flow ? 1 : undefined,
    blocks: out,
  };
}

export async function savePreview(pages, previewDir, extra = {}) {
  await mkdir(previewDir, { recursive: true });
  const lines = [];
  for (const p of pages) lines.push(JSON.stringify(await simplifyPage(p, previewDir)));
  await writeFile(path.join(previewDir, 'preview.ndjson'), lines.join('\n'), 'utf8');
  await writeFile(path.join(previewDir, 'meta.json'), JSON.stringify({ total: pages.length, ...extra }), 'utf8');
}

export async function readPreview(previewDir, from, count) {
  const meta = JSON.parse(await readFile(path.join(previewDir, 'meta.json'), 'utf8'));
  const lines = (await readFile(path.join(previewDir, 'preview.ndjson'), 'utf8')).split('\n');
  const start = Math.max(1, from);
  const slice = lines.slice(start - 1, start - 1 + count).map((l) => JSON.parse(l));
  return { ...meta, from: start, pages: slice };
}

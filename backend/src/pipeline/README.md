# backend/src/pipeline - the conversion engine

Order of use for one PDF page: `page-extract` → `layout` (+ `arabic`) → `process-page` decides text / OCR / image →
`convert-pdf` collects pages → `quran` → `preview` + `docx-builder`.

| File | Purpose |
| --- | --- |
| `arabic.js` | Arabic utilities: script detection, presentation-form → real letters, bracket mirroring, grapheme-safe reversing, **reversed-text detection**, **garbled-text-layer detection** (letter-frequency profile, unmapped glyphs). |
| `layout.js` | Layout analysis: attach floating diacritics to base letters, group lines, find column gutters, **visual → logical bidi ordering**, XY-cut reading order, table detection from ruling lines, paragraph building (alignment, bullets, line merging). |
| `page-extract.js` | Worker-side PDF reading with pdf.js: walks the operator list (glyphs with exact Unicode and position, ruling lines, image positions), renders pages with canvas, crops images, builds the text page model, computes page margins. |
| `process-page.js` | Per-page strategy: text layer → quality check → OCR fallback → picture fallback; also the `exact` mode. Returns the page model + metadata for the report. |
| `ocr.js` | Tesseract (local `ara`/`eng` models) → lines → paragraphs using the same layout rules; marks low-confidence words. |
| `quran.js` | **Quran guard**: finds ﴿…﴾ quotations, aligns them to the Mushaf word-by-word (tolerates missing glyphs, repeated verses, citations), repairs letters/diacritics, checks `[surah: ayah]` citations. |
| `docx-builder.js` | Builds the .docx with the `docx` library: one section per PDF page (original size, margins from content), RTL paragraphs/runs, complex-script fonts, tables, images, headings, highlights. |
| `preview.js` | Writes/reads the page-by-page preview (NDJSON) used by the in-app preview. |
| `convert-pdf.js` | Orchestrates a whole PDF on the worker pool, document-level consistency, Quran guard, report, docx. Also option normalisation. |
| `convert-image.js` | Images (JPG/PNG/WebP/TIFF/BMP/GIF) → OCR → docx (or the picture itself in `exact` mode). |
| `convert-text.js` | `.txt/.md/.csv` → docx with per-paragraph direction detection. |

Page model (shared by all converters, the docx builder and the preview): `{ n, width, height, margins, method, blocks[] }` where a
block is a paragraph (`runs`, `dir`, `align`, `fs`), a `table` (cells with paragraphs) or an `image`.

# backend/src/pipeline - the conversion engine

Order of use for one PDF page: `page-extract` → `layout` (+ `arabic`) → `process-page` decides text / OCR / image →
`convert-pdf` collects pages → `quran` → `preview` + `docx-builder`.

| File | Purpose |
| --- | --- |
| `arabic.js` | Arabic utilities: script detection, presentation-form → real letters, bracket mirroring, grapheme-safe reversing, **reversed-text detection**, **garbled-text-layer detection** (letter-frequency profile, unmapped glyphs). |
| `layout.js` | Layout analysis: attach floating diacritics to base letters, group lines, find column gutters, **visual → logical bidi ordering**, XY-cut reading order, table detection from ruling lines, paragraph building (alignment, bullets, line merging). |
| `page-extract.js` | Worker-side PDF reading with pdf.js: walks the operator list (glyphs with exact Unicode and position, ruling lines, image positions), renders pages with canvas, crops images, builds the text page model, computes page margins. Loads the pdf.js WASM decoders, so scans stored as JPEG2000 or JBIG2 (very common) are not rendered blank. |
| `process-page.js` | Per-page strategy: text layer → quality check → AI reading (if requested) → standard OCR → picture fallback (covers, ornaments, any page that fails); also the `exact` mode. Returns the page model + metadata for the report. |
| `scan-clean.js` | Prepares a scanned page for OCR: finds and crops the decorative frame, removes diacritics on heavily vowelled pages (keeping letter dots), normalises the text size. This raised letter accuracy on a real scanned book from 54% to 86%. Also erases ornament/header fragments that touch the crop edge, so they are not read as text. |
| `ocr.js` | Tesseract (local models; Arabic-only by default, which is far more accurate on Arabic books) → lines → paragraphs using the same layout rules; marks low-confidence words; drops only short noise lines, never real text; recycles/retries workers. Repairs the ﷺ glyph (read as junk tokens) only right after "رسول الله" / النبي / محمد (`fixHonorifics`). |
| `vision-ocr.js` | Optional **AI reading** of page images (Anthropic API via the official SDK, or a local Ollama model): transcription prompts, answer parsing, flow-layout blocks. A local model (Qari-OCR through `llamacpp`, or a general model through Ollama) reads the page **line by line** (`readPageByLines`), keeps only Arabic-script letters (`cleanArabicLine`), and `groupLines` turns the lines into paragraphs, headings and `[bracketed]` titles from the geometry. |
| `text-lines.js` | Splits a page body into its text lines (ink rows; floating marks are joined to their line; the line spacing is found from the periodic rhythm of the page, and touching lines are cut at the quietest rows) and reports the ink extent of each. Also finds the drawn rule of a running header and the rule above the footnotes. |
| `token-confidence.js` | Per-word confidence from the model's token probabilities, counted on the **letters** (a doubt between fatha and damma is not a doubt) and the other letters it considered (ف/ق, ب/ن …) as alternatives. |
| `quran.js` | **Quran guard**: finds ﴿…﴾ quotations (and, for OCR/AI text, unbracketed passages backed by rare-word evidence), aligns them to the Mushaf word-by-word (tolerates missing glyphs, repeated verses, citations), repairs letters/diacritics, checks `[surah: ayah]` citations. |
| `docx-builder.js` | Builds the .docx with the `docx` library: one section per PDF page (original size, margins from content), RTL paragraphs/runs, complex-script fonts, tables, images, headings, highlights, and Word comments listing the other possible readings of a doubtful AI-read word. |
| `preview.js` | Writes/reads the page-by-page preview (NDJSON) used by the in-app preview. |
| `convert-pdf.js` | Orchestrates a whole PDF on the worker pool, document-level consistency, Quran guard, report, docx. Also option normalisation. |
| `convert-image.js` | Images (JPG/PNG/WebP/TIFF/BMP/GIF) → OCR → docx (or the picture itself in `exact` mode). |
| `convert-text.js` | `.txt/.md/.csv` → docx with per-paragraph direction detection. |

Page model (shared by all converters, the docx builder and the preview): `{ n, width, height, margins, method, blocks[] }` where a
block is a paragraph (`runs`, `dir`, `align`, `fs`), a `table` (cells with paragraphs) or an `image`.

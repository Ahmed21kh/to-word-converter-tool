# backend/test

Run: `npm test` (from `backend/`). Fixtures are created with `npm run fixtures` (pipeline test is skipped without them).

| File | Purpose |
| --- | --- |
| `arabic.test.js` | Shaping normalisation, unmapped-glyph marker, reversed-text detection, bracket mirroring, quality check, docx script segmentation. |
| `quran.test.js` | Dataset completeness (6236 verses), exact/damaged verse repair, report-only mode, citation checks, repeated verses (Ar-Rahman), النساء vs الناس, multi-verse passages, prose left untouched. |
| `pipeline.test.js` | Converts the sample PDF end-to-end and checks the docx text: exact verses, un-reversed prose, no unmapped glyphs, pages in order. |
| `api-run.mjs` | Manual: `node test/api-run.mjs <file> <out.docx> [options-json]` uploads to a running server, prints progress, downloads the result. |
| `verify_docx.py` | Manual: reads a docx with python-docx (sections, RTL flags, tables, images, verse accuracy). `pip install python-docx` |
| `verify_big.py` | Manual: compares the 650-page result with its ground truth. |
| `fixtures/` | Generated sample PDFs/images (the 650-page files are git-ignored). |

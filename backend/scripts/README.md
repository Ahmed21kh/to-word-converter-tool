# backend/scripts

Development tooling (none of these run in production).

| File | Purpose |
| --- | --- |
| `prepare-tessdata.mjs` | `postinstall`: copies the Arabic + English Tesseract models from npm into `data/tessdata/` so OCR works offline. |
| `make-fixtures.mjs` | Generates `test/fixtures/arabic-sample.pdf` (headings, mixed text, table, Quran verses taken from the dataset, an image with Arabic words) using headless Edge/Chrome. |
| `make-scan-fixture.mjs` | Builds an image-only PDF (no text layer) from the sample to test OCR. |
| `make-big-fixture.mjs [pages]` | Generates a large Arabic PDF (default 650 pages, a different verse per page) + a `.truth.json` for load and accuracy tests. |
| `e2e-pdf.mjs <in.pdf> <out.docx> [mode]` | Runs the full pipeline without HTTP and prints the report. |
| `extract-quran.mjs` | One-off: extracts the Arabic-only text from the `quran-json` package into `data/quran-uthmani.json` (install that package temporarily first). |
| `make-surah-names.mjs` | Writes `data/surah-names.json` (114 Arabic surah names). |

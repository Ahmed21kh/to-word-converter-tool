# backend/scripts

Development tooling (none of these run in production).

| File | Purpose |
| --- | --- |
| `prepare-tessdata.mjs` | `postinstall`: copies the Arabic + English Tesseract models from npm into `data/tessdata/` so OCR works offline. |
| `make-fixtures.mjs` | Generates `test/fixtures/arabic-sample.pdf` (headings, mixed text, table, Quran verses taken from the dataset, an image with Arabic words) using headless Edge/Chrome. |
| `make-scan-fixture.mjs` | Builds an image-only PDF (no text layer) from the sample to test OCR. |
| `make-big-fixture.mjs [pages]` | Generates a large Arabic PDF (default 650 pages, a different verse per page) + a `.truth.json` for load and accuracy tests. |
| `e2e-pdf.mjs <in.pdf> <out.docx> [mode]` | Runs the full pipeline without HTTP and prints the report. |
| `probe-page.mjs <pdf> 1,6,8 [mode] [transcript.txt]` | Shows how single pages are handled (method, confidence, text) and, with a transcript, the letter accuracy. |
| `probe-quran.mjs <pdf> 9,10` | Shows what the Quran guard changes on OCR'd pages (before / after). |
| `ai-eval.mjs <pdf> <page> <transcript.txt>` | Measures the configured AI reader (`VISION_PROVIDER`) on a page prepared like the converter does: time, letter accuracy, accuracy including diacritics, and how many of the wrong words were flagged. `EVAL_OUT=<file>` saves the text; try `VISION_MODE=page`, `VISION_LINE_SCALE`, `VISION_IMAGE_DPI`. |
| `ai-pages.mjs <pdf> 4,5` | Shows how single pages come out with the AI engine (blocks, method, time). `FULL=1` prints whole paragraphs, `PAGES_OUT=<file>` saves the text. |
| `score-text.mjs <truth.txt> <got.txt>` | Letter accuracy (diacritics, hamza forms, ة/ه and the honorific folded) and accuracy including diacritics of one text against a transcript. |
| `render-page.mjs <pdf> <page> <out.png> [dpi]` | Renders one page to a PNG (also decodes JPEG2000 / JBIG2 scans) to look at what the converter sees. |
| `start-qari.ps1 [-Download] [-Parallel 3] [-Stop]` | Windows: starts the local **Qari-OCR** server (`VISION_PROVIDER=llamacpp`) with the `llama-server.exe` that ships with Ollama. `-Download` first fetches the two model files (3 GB, resumable) into `E:ollamaqari`. |
| `setup-local-ai.ps1 [-Model qwen2.5vl:7b] [-InstallDir E:\ollama] [-DryRun]` | Windows: installs Ollama and a free vision model on the drive you choose (resumable downloads), then prints the settings to use. |
| `ocr-native.mjs <pdf> <page> <transcript> <tessdata-dir> [psm]` | Compares native Tesseract models (needs the Tesseract program installed) on one page, scored against a transcript. |
| `ocr-lab.mjs <pdf> <page> <transcript.txt>` | OCR experiments scored against a transcript (frame crop, diacritics stripping, language model, scale). |
| `frame-check.mjs <pdf> <page>` | Debug: prints how the decorative frame of a scanned page is detected (row/column rules, crop box). |
| `extract-quran.mjs` | One-off: extracts the Arabic-only text from the `quran-json` package into `data/quran-uthmani.json` (install that package temporarily first). |
| `make-surah-names.mjs` | Writes `data/surah-names.json` (114 Arabic surah names). |

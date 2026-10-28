# Backend (Node.js)

Express API + conversion pipeline. ES modules, Node 20+. No database: jobs live in memory, files in `storage/` and are deleted
automatically.

## Run

```bash
npm install          # also copies the Arabic/English OCR models into data/tessdata (postinstall)
npm run dev          # nodemon (restarts on changes in src/ and data/; ignores storage/ and test/)
npm start            # production
npm test             # node --test (25 tests)
npm run fixtures     # (re)generate test PDFs with headless Edge/Chrome
```

If you see *"Port 4100 is already in use"* another copy is running: stop it, or use `PORT=4101 npm run dev`
(and set `VITE_DEV_API=http://localhost:4001` for the frontend dev server).

## Configuration (environment variables, see `.env.example`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 4100 | HTTP port |
| `WORKERS` | CPU cores − 1 (max 6) | page worker threads (speed vs. memory) |
| `MAX_CONCURRENT_JOBS` | 2 | documents converted at once; others wait in a queue |
| `MAX_UPLOAD_MB` | 500 | upload size limit |
| `RETENTION_MINUTES` | 60 | results/previews are deleted after this long |
| `PAGE_TIMEOUT_MS` | 180000 | a page taking longer is skipped (blank page + warning), the rest continues |
| `RATE_LIMIT_PER_MINUTE` | 30 | uploads per IP per minute |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | allowed browser origins (not needed when the built frontend is served by this server) |
| `DATA_DIR` | `./storage` | uploads / results |
| `SOFFICE_PATH` | auto-detect | LibreOffice binary (enables `.doc` output and Office/RTF input) |
| `FRONTEND_DIST` | `../frontend/dist` | built frontend to serve |
| `VISION_PROVIDER` | *(empty = off)* | `claude` (Anthropic API, needs `ANTHROPIC_API_KEY`), `llamacpp` (local **Qari-OCR**, an Arabic OCR model trained on diacritised text; start it with `scripts/start-qari.ps1`) or `ollama` (a general local model): enables the **AI** reading engine |
| `LLAMA_URL` | `http://127.0.0.1:8081` | where the Qari-OCR server listens (`llamacpp` provider). The API **starts it by itself** (and stops it on exit); a server that is already running is reused |
| `QARI_DIR` | `E:/ollama/qari` | folder with `model.gguf` and `mmproj.gguf` (use forward slashes in `.env`) |
| `LLAMA_SERVER_EXE` | *(found next to Ollama)* | path of `llama-server.exe` if it is not found automatically |
| `LLAMA_PARALLEL` | *auto* | text lines the Qari server reads at once: 8 with a 7 GB+ GPU, 4 with 6 GB+, 2 with 4.5 GB+, 1 below. Only the speed changes, never the text (measured on an 8 GB card: 4 lines 77 tokens/s, 8 lines 126) |
| `QARI_IDLE_SECONDS` | 120 | the Qari server gives back its GPU and RAM (about 3.6 GB + 0.6 GB) after this many seconds without work and wakes up in ~3 s on the next page; 0 keeps it loaded |
| `QARI_GPU` | *auto* | `0` runs Qari on the CPU (also chosen when no NVIDIA GPU with 3.8 GB+ is found): slower, same result |
| `QARI_EAGER` | 0 | `1` starts the Qari server together with the API instead of at the first AI job |
| `VISION_MODEL` | `claude-opus-5-5` / `qwen2.5vl:7b` | model used by the AI engine (`claude-sonnet-5-5` is about half the price) |
| `OLLAMA_URL` | `http://localhost:11434` | where Ollama listens |
| `OLLAMA_NUM_CTX` | 6144 | context size for whole-page reading with the local model (6144 fits an 8 GB GPU entirely; 8192 spills to the CPU and is slower) |
| `VISION_MODE` | `lines` (Ollama) | `lines` = the local model reads every text line separately (more accurate, tells which words it is unsure about), `page` = one request per page. Claude always reads the whole page |
| `VISION_LINE_PARALLEL` | 8 | text lines of a page sent to the local model at the same time (match `LLAMA_PARALLEL`; with Ollama, `OLLAMA_NUM_PARALLEL`). Lines read at once cost little more than one |
| `VISION_LINE_MARGIN` / `VISION_LINE_PAD` | 12 / 20 | white space (px) kept above and below each line image. Tighter crops send a quarter fewer image tokens but made Qari drop words (a poetry half-line, a verse start), so they are not the default |
| `VISION_LINE_SCALE` | 1.0 | enlargement of each line image before the local model reads it. Measured with Qari-OCR on two pages: 1.0 reads 98.4-98.8% of the letters, the old 1.4 only 91.8-98.2%, and is slower: it was trained on normal-size text. (The general Ollama model preferred 1.4) |
| `VISION_IMAGE_DPI` | 200 | resolution the page is rendered at for the AI engine |
| `AI_FLAG_CONF` | 0.5 | words the AI reading is less sure about than this are highlighted yellow in Word, with the other possible spellings in a Word comment |
| `VISION_TIMEOUT_MS` | 170000 | how long one AI page request may take |
| `AI_CONCURRENCY` | 2 (Ollama) / 4 (Claude) | AI pages processed at the same time (a local model answers one at a time) |
| `PUBLIC_URL` | *(empty)* | public **https** address of the site, e.g. `https://pdf.example.com`. Turns on the optional **Word view (Microsoft)** tab in the preview: Microsoft's online viewer opens the converted file from `PUBLIC_URL/api/jobs/<id>/document.docx`. Read-only, sends the document to Microsoft, and does not work on `localhost` or private addresses. |

## API

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | liveness + queue/pool stats |
| `GET /api/capabilities` | accepted types, limits, whether `.doc` is available |
| `POST /api/convert` | multipart `file` + `options` (JSON). Returns `202` and the job |
| `GET /api/jobs/:id` | job status |
| `GET /api/jobs/:id/events` | live progress (Server-Sent Events) |
| `GET /api/jobs/:id/preview?from=1&count=3` | page-by-page preview of the converted document |
| `GET /api/jobs/:id/preview/images/:name` | images used by the preview |
| `GET /api/jobs/:id/report` | per-page methods, Quran findings, pages to review |
| `GET /api/jobs/:id/download` | the file (`HEAD`, `Range`, `ETag` supported) |
| `POST /api/jobs/:id/pause` | pause a running conversion: the pages being read are finished, no new page starts, the time stops counting. Converted pages are kept on disk, so a paused job (or one cut by a server restart, which comes back paused) goes on from them. Paused jobs are deleted after 24 h |
| `POST /api/jobs/:id/resume` | go on with a paused conversion |
| `DELETE /api/jobs/:id` | cancel / delete now |

Options: `format` (docx or doc), `mode` (smart, ocr or exact), `language` (`ar` = Arabic OCR model, `mixed` = Arabic + English, `en`), `engine` (`standard` = free Tesseract, `ai` = vision model, needs `VISION_PROVIDER`), `quran` (correct, verify or off), `highlightUncertain`, `detectHeadings`, `frontAsPictures` (AI engine, default on: a book's cover and title pages before its first page of text stay pictures), `printMatch` (default off: "matches the printed edition", one Word page per PDF page in the same order; each page's text is measured with the real Word font and made smaller until it fits, so nothing spills onto another page. It keeps no pictures at all, as Shamela requires: the cover and title pages are read as text and set inside a bordered table (a calligraphic line the reader was unsure of takes the same words from a front page printed in a plain font, or is left out), the running head is read as text in its place: the page number comes from the page sequence (a few clear readings fix every page's number) and the running title is set as the book prints it in a chapter heading or on its card; any other picture is left out and its page marked for review; `frontAsPictures` and the `exact` mode do not apply), `arabicFont`, `latinFont`.

Job fields for progress: `percent` (one decimal), `activeMs` + `resumedAt` (time spent converting, pauses not counted: `activeMs + (now - resumedAt)` while it runs), `status` `paused` while paused.

## Security & performance notes

Helmet with a strict CSP, CORS allow-list, rate limiting, content sniffing (not extensions), random 128-bit job ids, originals
deleted as soon as conversion ends, streamed uploads to disk, `Range` downloads, no compression on SSE, per-page timeouts and
worker crash recovery.

## Folders

| Folder | Contents |
| --- | --- |
| [`src/`](src/README.md) | server entry, app, config |
| [`src/pipeline/`](src/pipeline/README.md) | the conversion engine |
| [`src/services/`](src/services/README.md) | job manager, worker pool, file sniffing, LibreOffice |
| [`src/workers/`](src/workers/README.md) | worker-thread entry |
| [`scripts/`](scripts/README.md) | fixtures and data tooling |
| [`test/`](test/README.md) | tests and verification scripts |
| [`data/`](data/README.md) | Quran text, surah names, OCR models |

Other files: `package.json`, `nodemon.json` (watch/ignore rules), `.env.example`.

# Backend (Node.js)

Express API + conversion pipeline. ES modules, Node 20+. No database: jobs live in memory, files in `storage/` and are deleted
automatically.

## Run

```bash
npm install          # also copies the Arabic/English OCR models into data/tessdata (postinstall)
npm run dev          # nodemon (restarts on changes in src/ and data/; ignores storage/ and test/)
npm start            # production
npm test             # node --test (19 tests)
npm run fixtures     # (re)generate test PDFs with headless Edge/Chrome
```

If you see *"Port 4000 is already in use"* another copy is running: stop it, or use `PORT=4001 npm run dev`
(and set `VITE_DEV_API=http://localhost:4001` for the frontend dev server).

## Configuration (environment variables, see `.env.example`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 4000 | HTTP port |
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
| `DELETE /api/jobs/:id` | cancel / delete now |

Options: `format` (`docx`\|`doc`), `mode` (`smart`\|`ocr`\|`exact`), `language` (`ar`\|`en`), `quran` (`correct`\|`verify`\|`off`),
`highlightUncertain`, `detectHeadings`, `arabicFont`, `latinFont`.

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

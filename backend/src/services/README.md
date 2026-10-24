# backend/src/services

| File | Purpose |
| --- | --- |
| `jobs.js` | Job manager: creates jobs (file sniffing, option validation), FIFO queue with a concurrency limit, progress events for SSE, cancellation, deletion of originals/temp files, retention cleanup of results. |
| `pool.js` | Worker-thread pool: FIFO tasks, per-task timeout, crash recovery (respawn), cancellation of a job's queued tasks. |
| `llama-server.js` | Starts the local Qari-OCR server (`VISION_PROVIDER=llamacpp`) with the `llama-server` that ships with Ollama when the API starts or when an AI job needs it; reuses a server that is already running; stops the one it started when the API exits. |
| `filetype.js` | Detects the real file type from the first bytes (PDF, images, Office, RTF, text); the extension alone is never trusted. |
| `libreoffice.js` | Optional LibreOffice integration (serialised): Office/OpenDocument/RTF → docx, and docx → legacy `.doc`. Reports availability for `/api/capabilities`. |

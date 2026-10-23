# backend/src/workers

| File | Purpose |
| --- | --- |
| `pdf-worker.js` | Worker-thread entry. Keeps the opened pdf.js documents and an OCR engine alive, and handles tasks sent by `services/pool.js`: `info` (page count/size), `page` (convert one page), `release` (close a document), `shutdown`. Runs one task at a time; the pool starts several workers. |

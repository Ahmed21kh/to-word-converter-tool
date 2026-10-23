# backend/src

| File | Purpose |
| --- | --- |
| `server.js` | Process entry: creates the app, listens, handles port-in-use errors, graceful shutdown (SIGINT/SIGTERM). |
| `app.js` | Express app: security middleware (helmet/CORS/rate limit), all `/api` routes (upload, SSE progress, preview, report, download), and serving of the pre-rendered frontend with a real 404 page. |
| `config.js` | Reads environment variables (port, workers, limits, retention, LibreOffice path). |
| `logger.js` | pino logger. |

Sub-folders: [`pipeline/`](pipeline/README.md), [`services/`](services/README.md), [`workers/`](workers/README.md).

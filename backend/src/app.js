import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './logger.js';
import { JobManager } from './services/jobs.js';
import { libreOfficeAvailable } from './services/libreoffice.js';
import { ACCEPTED_EXTENSIONS } from './services/filetype.js';
import { readPreview } from './pipeline/preview.js';
import { visionStatus } from './pipeline/vision-ocr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
};

export async function createApp() {
  const app = express();
  const jobs = new JobManager();
  await mkdir(path.join(config.dataDir, 'jobs'), { recursive: true });
  await jobs.restore();
  const uploadDir = path.join(config.dataDir, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  await mkdir(path.join(config.dataDir, 'jobs'), { recursive: true });

  app.disable('x-powered-by');
  app.set('trust proxy', config.env === 'production' ? 1 : false);

  // Microsoft's online viewer fetches the file from the public address, so it only works for a real public https site
  const officeViewerOn = (() => {
    try {
      const u = new URL(config.publicUrl);
      const h = u.hostname;
      const [a, b] = h.split('.').map(Number);
      const privateIp = a === 10 || a === 127 || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31);
      const local = h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.includes(':') || !h.includes('.') || privateIp;
      return u.protocol === 'https:' && !local;
    } catch { return false; }
  })();

  app.use(helmet({
    // the SPA uses CSS-in-JS (Ant Design), hence inline styles; everything else is same-origin
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'frame-src': officeViewerOn ? ["'self'", 'https://view.officeapps.live.com'] : ["'self'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': config.env === 'production' ? [] : null,
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // access control is done by CORS (allow-list) + secret job ids
  }));
  app.use(cors({
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    exposedHeaders: ['Content-Disposition'],
  }));
  // do not compress server-sent events (they must flush immediately)
  app.use(compression({ filter: (req, res) => !req.path.endsWith('/events') && compression.filter(req, res) }));

  const api = express.Router();
  api.use(rateLimit({ windowMs: 60_000, limit: config.rateLimitPerMinute * 20, standardHeaders: 'draft-7', legacyHeaders: false }));
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()), ...jobs.stats() });
  });

  api.get('/capabilities', (req, res) => {
    const lo = libreOfficeAvailable();
    res.json({
      inputs: {
        pdf: true,
        images: ['jpg', 'png', 'webp', 'tiff', 'bmp', 'gif'],
        text: ['txt', 'md', 'csv'],
        office: lo ? ['doc', 'docx', 'odt', 'rtf', 'ppt', 'pptx', 'xls', 'xlsx', 'html'] : [],
      },
      outputs: lo ? ['docx', 'doc'] : ['docx'],
      accept: ACCEPTED_EXTENSIONS.filter((e) => lo || !['.doc', '.docx', '.odt', '.rtf', '.ppt', '.pptx', '.odp', '.xls', '.xlsx', '.ods', '.html', '.htm'].includes(e)),
      limits: { maxUploadMb: config.maxUploadMb },
      features: { officeViewer: officeViewerOn ? { available: true, baseUrl: config.publicUrl } : { available: false }, ocr: true, ocrLanguages: ['ar', 'en'], quranCheck: true, libreOffice: lo, ai: visionStatus() },
      retentionMinutes: config.retentionMinutes,
    });
  });

  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 20, fieldSize: 10_000 },
    fileFilter: (req, file, cb) => {
      // multer decodes names as latin1; restore UTF-8 (Arabic file names)
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const ext = path.extname(file.originalname).toLowerCase();
      if (!ACCEPTED_EXTENSIONS.includes(ext)) {
        const err = new Error(`File type "${ext || 'unknown'}" is not supported`);
        err.status = 415;
        return cb(err);
      }
      return cb(null, true);
    },
  });

  api.post('/convert', rateLimit({ windowMs: 60_000, limit: config.rateLimitPerMinute, standardHeaders: 'draft-7', legacyHeaders: false }), upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: "file")' });
    let options = {};
    try {
      options = req.body.options ? JSON.parse(req.body.options) : { ...req.body };
    } catch {
      options = {};
    }
    const job = await jobs.create({ tmpFile: req.file.path, originalName: req.file.originalname, size: req.file.size, options });
    return res.status(202).json(jobs.publicView(job));
  });

  api.get('/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found or expired' });
    return res.json(jobs.publicView(job));
  });

  api.get('/jobs/:id/report', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job?.report) return res.status(404).json({ error: 'Report not available' });
    return res.json(job.report);
  });

  api.get('/jobs/:id/events', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found or expired' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send(jobs.publicView(job));
    const onUpdate = (id, view) => {
      if (id !== job.id) return;
      send(view);
      if (['done', 'error', 'cancelled'].includes(view.status)) res.end();
    };
    jobs.on('update', onUpdate);
    const hb = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(hb);
      jobs.off('update', onUpdate);
    });
    if (['done', 'error', 'cancelled'].includes(job.status)) res.end();
  });

  // Served through res.download (send): HEAD, Range / If-Range, ETag, Accept-Ranges and a correct
  // Content-Length. Browsers and external download managers (IDM, NDM, ...) re-request the URL with
  // HEAD and parallel Range requests, so a plain piped stream is not enough for them.
  // `document.docx` is the same file under a name that ends in the extension, which Microsoft's viewer expects
  api.get(['/jobs/:id/download', '/jobs/:id/document.docx'], (req, res, next) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status !== 'done' || !job.output || !existsSync(job.output.path)) {
      return res.status(404).json({ error: 'File not available (it may have expired)' });
    }
    const base = path.basename(job.name, path.extname(job.name)) || 'document';
    const filename = `${base}.${job.output.format}`;
    res.set({
      'Content-Type': MIME[job.output.format] || 'application/octet-stream',
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.download(job.output.path, filename, { acceptRanges: true, lastModified: true, etag: true }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  // Page-by-page preview of the converted document (the same content that went into the .docx)
  api.get('/jobs/:id/preview', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status !== 'done' || !job.hasPreview) return res.status(404).json({ error: 'Preview not available' });
    const from = Math.max(1, Number.parseInt(req.query.from, 10) || 1);
    const count = Math.min(10, Math.max(1, Number.parseInt(req.query.count, 10) || 3));
    return res.json(await readPreview(path.join(jobs.jobDir(job.id), 'preview'), from, count));
  });

  api.get('/jobs/:id/preview/images/:name', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status !== 'done' || !/^[A-Za-z0-9_.-]+$/.test(req.params.name)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=600');
    return res.sendFile(req.params.name, { root: path.join(jobs.jobDir(job.id), 'preview') }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  api.delete('/jobs/:id', async (req, res) => {
    const ok = await jobs.cancelOrDelete(req.params.id);
    return res.status(ok ? 204 : 404).end();
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Optional: serve the built (pre-rendered) frontend from the same process
  const dist = process.env.FRONTEND_DIST || path.join(here, '..', '..', 'frontend', 'dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, {
      index: 'index.html',
      setHeaders: (res, file) => {
        if (/\.(?:js|css|woff2?|png|jpg|svg|webp|ico)$/.test(file) && file.includes(`${path.sep}assets${path.sep}`)) {
          res.set('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.set('Cache-Control', 'public, max-age=300');
        }
      },
    }));
    // every real page is pre-rendered; anything else is a genuine 404 (good for SEO)
    const notFoundPage = existsSync(path.join(dist, '404.html')) ? path.join(dist, '404.html') : path.join(dist, 'index.html');
    app.get(/^(?!\/api\/).*/, (req, res) => res.status(404).sendFile(notFoundPage));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || 500;
    let message = err.message;
    if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      if (err.code === 'LIMIT_FILE_SIZE') message = `File is too large (limit ${config.maxUploadMb} MB)`;
    }
    if (status >= 500) logger.error({ err: err.stack }, 'request failed');
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : message });
  });

  return { app, jobs };
}

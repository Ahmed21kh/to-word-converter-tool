import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// settings from backend/.env (copy .env.example); real environment variables win
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env file */ }
const int = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

export const config = {
  port: int(process.env.PORT, 4100),
  // public https address of this site (e.g. https://pdf.example.com): enables the optional Microsoft Word viewer in the preview
  publicUrl: (process.env.PUBLIC_URL || '').trim().replace(new RegExp(`${String.fromCharCode(47)}+$`), ''),
  env: process.env.NODE_ENV || 'development',
  // proxies in front of the API (a host's load balancer): the visitor's address, which the rate limits count, is that many hops back
  trustProxy: process.env.TRUST_PROXY !== undefined && process.env.TRUST_PROXY !== '' ? int(process.env.TRUST_PROXY, 1) : process.env.NODE_ENV === 'production' ? 1 : false,
  // comma separated list of allowed browser origins; empty = same-origin only (use the Vite proxy in dev)
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((s) => s.trim()).filter(Boolean),
  dataDir: process.env.DATA_DIR || path.join(root, 'storage'),
  maxUploadMb: int(process.env.MAX_UPLOAD_MB, 500),
  // pages are processed in parallel by worker threads
  workers: int(process.env.WORKERS, Math.max(1, Math.min(os.cpus().length - 1, 6))),
  // how many documents are converted at the same time (others wait in a queue)
  maxConcurrentJobs: int(process.env.MAX_CONCURRENT_JOBS, 2),
  pageTimeoutMs: int(process.env.PAGE_TIMEOUT_MS, 180_000),
  // results (and uploads) are deleted this long after the job finishes
  retentionMinutes: int(process.env.RETENTION_MINUTES, 60),
  rateLimitPerMinute: int(process.env.RATE_LIMIT_PER_MINUTE, 30),
  sofficePath: process.env.SOFFICE_PATH || '',
};

// Job manager: queue, concurrency limit, progress events, retention cleanup.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, rename, stat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { WorkerPool } from './pool.js';
import { sniff } from './filetype.js';
import { convertWithLibreOffice, libreOfficeAvailable } from './libreoffice.js';
import { convertPdf, normalizeOptions } from '../pipeline/convert-pdf.js';
import { convertImage } from '../pipeline/convert-image.js';
import { convertText } from '../pipeline/convert-text.js';
import { visionStatus } from '../pipeline/vision-ocr.js';
import { ensureLlamaServer } from './llama-server.js';

const PHASE_WEIGHT = { queued: 0, analyzing: 2, converting: 90, verifying: 94, building: 97, finalizing: 99, done: 100 };
const PAUSE_TTL = 24 * 60 * 60_000;

export class JobManager extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.waiting = [];
    this.running = 0;
    this.pool = null;
    this.timer = setInterval(() => this.#cleanup().catch((e) => logger.warn({ err: e.message }, 'cleanup failed')), 60_000);
    this.timer.unref();
  }

  get workerPool() {
    this.pool ||= new WorkerPool();
    return this.pool;
  }

  jobDir(id) {
    return path.join(config.dataDir, 'jobs', id);
  }

  async create({ tmpFile, originalName, size, options }) {
    const type = await sniff(tmpFile, originalName);
    if (!type) {
      await rm(tmpFile, { force: true });
      const err = new Error('Unsupported or corrupted file type');
      err.status = 415;
      throw err;
    }
    if (type.kind === 'office' && !libreOfficeAvailable()) {
      await rm(tmpFile, { force: true });
      const err = new Error('Office documents need LibreOffice on the server (not installed). PDF, images and text are supported.');
      err.status = 415;
      throw err;
    }
    const opts = normalizeOptions(options);
    if (opts.engine === 'ai' && !visionStatus().available) {
      await rm(tmpFile, { force: true });
      const err = new Error('AI reading is not configured on this server (set VISION_PROVIDER). Use the standard engine.');
      err.status = 400;
      throw err;
    }
    if (opts.format === 'doc' && !libreOfficeAvailable()) {
      await rm(tmpFile, { force: true });
      const err = new Error('The legacy .doc format needs LibreOffice on the server (not installed). Use .docx instead.');
      err.status = 400;
      throw err;
    }
    const id = randomBytes(16).toString('hex');
    const dir = this.jobDir(id);
    await mkdir(path.join(dir, 'work'), { recursive: true });
    const input = path.join(dir, `input${type.ext}`);
    await rename(tmpFile, input).catch(async () => {
      const { copyFile } = await import('node:fs/promises');
      await copyFile(tmpFile, input);
      await rm(tmpFile, { force: true });
    });
    const job = {
      id,
      name: originalName,
      size,
      kind: type.kind,
      options: opts,
      status: 'queued',
      phase: 'queued',
      progress: { done: 0, total: 0 },
      percent: 0,
      queuePosition: this.waiting.length + 1,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      // time spent converting, pauses not counted: activeMs so far + (now - resumedAt) while it runs
      activeMs: 0,
      resumedAt: null,
      pausedAt: null,
      error: null,
      report: null,
      hasPreview: false,
      output: null,
      _input: input,
      _cancel: false,
      _paused: false,
      _waiters: [],
    };
    this.jobs.set(id, job);
    this.waiting.push(job);
    this.#emit(job);
    this.#drain();
    return job;
  }

  get(id) {
    return this.jobs.get(id);
  }

  publicView(job) {
    const { report, ...rest } = job;
    for (const k of Object.keys(rest)) if (k.startsWith('_')) delete rest[k];
    return { ...rest, hasReport: !!report };
  }

  #emit(job) {
    this.emit('update', job.id, this.publicView(job));
  }

  #drain() {
    while (this.running < config.maxConcurrentJobs && this.waiting.length) {
      const job = this.waiting.shift();
      this.waiting.forEach((j, i) => {
        j.queuePosition = i + 1;
        this.#emit(j);
      });
      if (job._cancel || job._paused) continue;
      this.running++;
      job._running = true;
      this.#run(job).finally(() => {
        job._running = false;
        this.running--;
        this.#drain();
      });
    }
  }

  #progress(job, { phase, done = 0, total = 0 }) {
    job.phase = phase;
    job.progress = { done, total };
    const base = phase === 'converting' ? PHASE_WEIGHT.analyzing : PHASE_WEIGHT[phase] ?? 0;
    // one decimal: a long book moves by less than a percent per page
    job.percent = phase === 'converting' && total ? Math.min(90, Math.round((PHASE_WEIGHT.analyzing + (done / total) * (PHASE_WEIGHT.converting - 2)) * 10) / 10) : base;
    job.queuePosition = 0;
    const now = Date.now();
    if (!job._lastEmit || now - job._lastEmit > 250 || done === total) {
      job._lastEmit = now;
      this.#emit(job);
    }
  }

  async #run(job) {
    const dir = this.jobDir(job.id);
    const workDir = path.join(dir, 'work');
    const base = path.basename(job.name, path.extname(job.name)).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'document';
    const wantDoc = job.options.format === 'doc';
    const docxPath = path.join(dir, `${base}.docx`);
    job.status = 'processing';
    job.startedAt ||= Date.now();
    job.resumedAt = Date.now();
    await this.#persist(job); // a restart from here on brings the job back paused, with the pages done so far
    this.#progress(job, { phase: 'analyzing' });
    const ctx = {
      jobId: job.id,
      file: job._input,
      workDir,
      previewDir: path.join(dir, 'preview'),
      outPath: docxPath,
      options: job.options,
      title: base,
      pool: this.workerPool,
      onProgress: (p) => this.#progress(job, p),
      isCancelled: () => job._cancel,
      // resolves when the job may go on (at once unless it is paused); rejects when it is cancelled meanwhile
      waitIfPaused: () => (job._paused ? new Promise((resolve, reject) => job._waiters.push({ resolve, reject })) : null),
    };
    try {
      let report;
      if (job.options.engine === 'ai') await ensureLlamaServer().catch((err) => logger.warn({ err: err.message }, 'AI reader not available, using the standard OCR'));
      if (job.kind === 'pdf') report = await convertPdf(ctx);
      else if (job.kind === 'image') report = await convertImage(ctx);
      else if (job.kind === 'text') report = await convertText(ctx);
      else {
        this.#progress(job, { phase: 'converting', done: 0, total: 1 });
        const out = await convertWithLibreOffice(job._input, dir, wantDoc ? 'doc' : 'docx', job.id);
        const { size } = await stat(out);
        report = { pages: null, methods: { libreoffice: 1 }, quran: { found: 0, items: [] }, warnings: [], reviewPages: [], pageDetails: [], outputBytes: size, durationMs: Date.now() - job.startedAt };
        job._officeOut = out;
      }
      if (job._cancel) throw new Error('cancelled');

      let finalPath = job._officeOut || docxPath;
      if (wantDoc && job.kind !== 'office') {
        this.#progress(job, { phase: 'finalizing' });
        finalPath = await convertWithLibreOffice(docxPath, dir, 'doc', job.id);
      }
      const { size } = await stat(finalPath);
      job.hasPreview = job.kind !== 'office';
      job.output = { path: finalPath, name: path.basename(finalPath), size, format: path.extname(finalPath).slice(1) };
      job.report = report;
      job.status = 'done';
      job.percent = 100;
      job.phase = 'done';
    } catch (err) {
      if (err.message === 'cancelled' || job._cancel) {
        job.status = 'cancelled';
      } else {
        job.status = 'error';
        job.error = err.message;
        logger.error({ jobId: job.id, err: err.stack }, 'conversion failed');
      }
    } finally {
      if (job.resumedAt) job.activeMs += Date.now() - job.resumedAt;
      job.resumedAt = null;
      job.finishedAt = Date.now();
      job.queuePosition = 0;
      if (job.status === 'done') await this.#persist(job);
      this.workerPool.cancel(job.id);
      // privacy + disk: the source file and temporary images are not needed any more
      await rm(job._input, { force: true }).catch(() => {});
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      this.#emit(job);
    }
  }

  /**
   * Pause a conversion: no new page is started (the pages being read are finished) and the time stops counting. Its pages are
   * kept on disk, so it also goes on after a server restart.
   */
  async pause(id) {
    const job = this.jobs.get(id);
    if (!job || !['processing', 'queued'].includes(job.status)) return false;
    job._paused = true;
    if (job.status === 'queued') this.waiting = this.waiting.filter((j) => j !== job);
    if (job.resumedAt) job.activeMs += Date.now() - job.resumedAt;
    job.resumedAt = null;
    job.pausedAt = Date.now();
    job.status = 'paused';
    await this.#persist(job);
    this.#emit(job);
    return true;
  }

  /** Go on from where the conversion was paused (or where a server restart stopped it). */
  resume(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'paused') return false;
    job._paused = false;
    job.pausedAt = null;
    const waiters = job._waiters.splice(0);
    if (waiters.length || job._running) {
      job.status = 'processing';
      job.resumedAt = Date.now();
      for (const w of waiters) w.resolve();
    } else { // not started yet, or stopped by a restart: back into the queue, its saved pages are reused
      job.status = 'queued';
      this.waiting.push(job);
      job.queuePosition = this.waiting.length;
    }
    this.#emit(job);
    this.#drain();
    return true;
  }

  async cancelOrDelete(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job._cancel = true;
    this.workerPool.cancel(id);
    this.waiting = this.waiting.filter((j) => j !== job);
    for (const w of job._waiters?.splice(0) || []) w.reject(new Error('cancelled'));
    if (job.status === 'queued' || (job.status === 'paused' && !job._running)) {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      this.#emit(job);
    }
    if (job.status !== 'processing' && !job._running) await this.#remove(job);
    return true;
  }

  async #remove(job) {
    this.jobs.delete(job.id);
    await rm(this.jobDir(job.id), { recursive: true, force: true }).catch(() => {});
  }

  async #cleanup() {
    const ttl = config.retentionMinutes * 60_000;
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.finishedAt && now - job.finishedAt > ttl) await this.#remove(job);
      // a paused conversion keeps its source file and pages for a day
      else if (job.status === 'paused' && job.pausedAt && now - job.pausedAt > PAUSE_TTL && !job._running) await this.#remove(job);
    }
    // orphans from a previous run
    const root = path.join(config.dataDir, 'jobs');
    const dirs = await readdir(root).catch(() => []);
    for (const d of dirs) {
      if (this.jobs.has(d)) continue;
      const s = await stat(path.join(root, d)).catch(() => null);
      if (s && now - s.mtimeMs > ttl) await rm(path.join(root, d), { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Jobs are saved next to their files so a server restart (deploy, crash, nodemon) does not lose them: finished ones, and the
   * ones being converted (with their source file), which come back paused.
   */
  async #persist(job) {
    const data = { input: job._input };
    for (const [k, v] of Object.entries(job)) if (!k.startsWith('_')) data[k] = v;
    try {
      await writeFile(path.join(this.jobDir(job.id), 'job.json'), JSON.stringify(data));
    } catch (err) {
      logger.warn({ jobId: job.id, err: err.message }, 'could not persist job');
    }
  }

  /** Reload jobs from disk at startup: finished ones (downloads, previews and reports keep working) and interrupted ones (paused). */
  async restore() {
    const root = path.join(config.dataDir, 'jobs');
    const dirs = await readdir(root).catch(() => []);
    let restored = 0;
    for (const id of dirs) {
      try {
        const data = JSON.parse(await readFile(path.join(root, id, 'job.json'), 'utf8'));
        const { input, ...view } = data;
        if (data.status === 'done' && data.output) {
          await stat(data.output.path);
          this.jobs.set(data.id, { ...view, _cancel: false, _paused: false, _waiters: [] });
        } else if (['processing', 'paused', 'queued'].includes(data.status) && input) {
          await stat(input);
          this.jobs.set(data.id, {
            ...view, status: 'paused', resumedAt: null, pausedAt: data.pausedAt || Date.now(), queuePosition: 0,
            _input: input, _cancel: false, _paused: true, _waiters: [],
          });
        } else continue;
        restored++;
      } catch { /* not a job we can bring back (or its files are gone): ignore */ }
    }
    if (restored) logger.info({ restored }, 'restored jobs from disk');
  }

  stats() {
    return { running: this.running, queued: this.waiting.length, pool: this.pool?.stats ?? null };
  }

  async shutdown() {
    clearInterval(this.timer);
    await this.pool?.close();
  }
}

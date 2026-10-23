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

const PHASE_WEIGHT = { queued: 0, analyzing: 2, converting: 90, verifying: 94, building: 97, finalizing: 99, done: 100 };

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
      error: null,
      report: null,
      hasPreview: false,
      output: null,
      _input: input,
      _cancel: false,
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
    const { _input, _cancel, report, ...rest } = job;
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
      if (job._cancel) continue;
      this.running++;
      this.#run(job).finally(() => {
        this.running--;
        this.#drain();
      });
    }
  }

  #progress(job, { phase, done = 0, total = 0 }) {
    job.phase = phase;
    job.progress = { done, total };
    const base = phase === 'converting' ? PHASE_WEIGHT.analyzing : PHASE_WEIGHT[phase] ?? 0;
    job.percent = phase === 'converting' && total ? Math.min(90, Math.round(PHASE_WEIGHT.analyzing + (done / total) * (PHASE_WEIGHT.converting - 2))) : base;
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
    job.startedAt = Date.now();
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
    };
    try {
      let report;
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

  async cancelOrDelete(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job._cancel = true;
    this.workerPool.cancel(id);
    this.waiting = this.waiting.filter((j) => j !== job);
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      this.#emit(job);
    }
    if (job.status !== 'processing') await this.#remove(job);
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

  /** Finished jobs are saved next to their files so a server restart (deploy, crash, nodemon) does not lose them. */
  async #persist(job) {
    // eslint-disable-next-line no-unused-vars
    const { _input, _cancel, _lastEmit, _officeOut, ...data } = job;
    try {
      await writeFile(path.join(this.jobDir(job.id), 'job.json'), JSON.stringify(data));
    } catch (err) {
      logger.warn({ jobId: job.id, err: err.message }, 'could not persist job');
    }
  }

  /** Reload finished jobs from disk at startup (downloads, previews and reports keep working after a restart). */
  async restore() {
    const root = path.join(config.dataDir, 'jobs');
    const dirs = await readdir(root).catch(() => []);
    let restored = 0;
    for (const id of dirs) {
      try {
        const data = JSON.parse(await readFile(path.join(root, id, 'job.json'), 'utf8'));
        if (data.status !== 'done' || !data.output) continue;
        await stat(data.output.path);
        this.jobs.set(data.id, { ...data, _cancel: false });
        restored++;
      } catch { /* not a finished job (or files already deleted): ignore */ }
    }
    if (restored) logger.info({ restored }, 'restored finished jobs from disk');
  }

  stats() {
    return { running: this.running, queued: this.waiting.length, pool: this.pool?.stats ?? null };
  }

  async shutdown() {
    clearInterval(this.timer);
    await this.pool?.close();
  }
}

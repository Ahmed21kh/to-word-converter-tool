import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { ensureLlamaServer, stopLlamaServer } from './services/llama-server.js';

const { app, jobs } = await createApp();

// NOTE: Express 5 does not throw when listen() fails, it passes the error to the callback. Handle it
// explicitly, otherwise a busy port would log "listening" and then exit silently (nodemon: "clean exit").
const server = app.listen(config.port, process.env.HOST || undefined); // HOST=127.0.0.1: this machine only (desktop app)
server.once('listening', () => {
  logger.info({ port: config.port, workers: config.workers, maxConcurrentJobs: config.maxConcurrentJobs }, 'PDF to Word API listening');
});
server.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${config.port} is already in use (another copy of the API is probably running). Stop it, or start this one on another port, e.g.  PORT=4001 npm run dev`);
  } else {
    logger.error({ err: err.stack }, 'server failed to start');
  }
  process.exit(1);
});
// the local Qari-OCR model (VISION_PROVIDER=llamacpp) starts together with the API; the first job waits for it if needed
if (process.env.QARI_EAGER === '1') ensureLlamaServer().catch((err) => logger.error({ err: err.message }, 'AI reader not available (pages fall back to the standard OCR)'));
// long uploads / SSE connections
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 65_000;

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info({ signal }, 'shutting down');
  server.close();
  await jobs.shutdown().catch(() => {});
  stopLlamaServer();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// started by the desktop app (desktop/main.js): on Windows a kill skips the code above, so it asks over IPC; if the app dies, stop too
if (process.send) {
  process.on('message', (m) => { if (m === 'shutdown') shutdown('desktop app'); });
  process.on('disconnect', () => shutdown('desktop app gone'));
}
process.on('unhandledRejection', (err) => logger.error({ err: String(err?.stack || err) }, 'unhandled rejection'));

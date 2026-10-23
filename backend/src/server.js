import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';

const { app, jobs } = await createApp();

// NOTE: Express 5 does not throw when listen() fails, it passes the error to the callback. Handle it
// explicitly, otherwise a busy port would log "listening" and then exit silently (nodemon: "clean exit").
const server = app.listen(config.port);
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
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err: String(err?.stack || err) }, 'unhandled rejection'));

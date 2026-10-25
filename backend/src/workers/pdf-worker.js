// Worker thread: owns open pdf.js documents and an OCR engine; processes one task at a time.
import { parentPort } from 'node:worker_threads';
import { openPdf } from '../pipeline/page-extract.js';
import { processPage, probePage } from '../pipeline/process-page.js';
import { terminateOcr } from '../pipeline/ocr.js';

const docs = new Map();

async function getDoc(file) {
  if (!docs.has(file)) docs.set(file, openPdf(file));
  return docs.get(file);
}

async function handle(msg) {
  switch (msg.type) {
    case 'info': {
      const doc = await getDoc(msg.file);
      const first = await doc.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      return { numPages: doc.numPages, width: vp.width, height: vp.height };
    }
    case 'page': {
      const doc = await getDoc(msg.file);
      return processPage(doc, msg.n, msg.options, msg.workDir);
    }
    case 'probe': {
      const doc = await getDoc(msg.file);
      return probePage(doc, msg.n);
    }
    case 'release': {
      const p = docs.get(msg.file);
      docs.delete(msg.file);
      if (p) await (await p).destroy();
      return true;
    }
    case 'shutdown':
      await terminateOcr();
      return true;
    default:
      throw new Error(`unknown task ${msg.type}`);
  }
}

parentPort.on('message', async ({ id, msg }) => {
  try {
    parentPort.postMessage({ id, ok: true, result: await handle(msg) });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});

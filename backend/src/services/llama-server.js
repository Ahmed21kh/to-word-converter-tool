// Starts the local Qari-OCR server (VISION_PROVIDER=llamacpp) by itself, so nobody has to run scripts/start-qari.ps1.
// It uses the llama-server executable that ships with Ollama. A server that is already running (started by the script, or left over
// from a previous run of this API) is reused. A server started here is stopped when the API stops.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { visionStatus } from '../pipeline/vision-ocr.js';

const baseUrl = () => (process.env.LLAMA_URL || 'http://127.0.0.1:8081').split('/').filter((p, i, a) => p || i < a.length - 1).join('/');

async function healthy() {
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Folder of Ollama's own llama.cpp build: <ollama dir>/lib/ollama (found through LLAMA_SERVER_EXE or the PATH). */
function findServer() {
  if (process.env.LLAMA_SERVER_EXE && existsSync(process.env.LLAMA_SERVER_EXE)) return process.env.LLAMA_SERVER_EXE;
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama'));
  // the terminal that started this API may not know Ollama's folder (installed after it was opened): ask the running Ollama
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process ollama -ErrorAction SilentlyContinue | Select-Object -First 1).Path"], { encoding: 'utf8', timeout: 8000 }).trim();
      if (out) dirs.push(path.dirname(out));
    } catch { /* not running or no PowerShell */ }
  }
  for (const d of dirs) {
    for (const cand of [path.join(d, 'lib', 'ollama', exe), path.join(d, exe)]) if (existsSync(cand)) return cand;
  }
  return null;
}

/** Memory (MiB) of the biggest NVIDIA GPU, or null when there is none (or nvidia-smi is not available). */
function gpuMemoryMiB() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000 });
    const sizes = out.split(String.fromCharCode(10)).map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0);
    return sizes.length ? Math.max(...sizes) : null;
  } catch {
    return null;
  }
}

/**
 * How to run the model on THIS machine. The model, its settings and so the text it reads are the same everywhere; only the speed and the
 * memory differ: text lines read at once (slots) follow the GPU memory, and a machine without a usable NVIDIA GPU (or QARI_GPU=0) runs it
 * on the CPU, slower but with identical results. LLAMA_PARALLEL overrides the number of slots.
 */
export function runPlan(vram = gpuMemoryMiB(), env = process.env) {
  const gpu = env.QARI_GPU !== '0' && vram !== null && vram >= 3800;
  const auto = !gpu ? 1 : vram >= 6000 ? 4 : vram >= 4500 ? 2 : 1;
  const forced = Number(env.LLAMA_PARALLEL);
  return { gpu, parallel: forced > 0 ? forced : auto };
}

let child = null;
let pending = null;

async function start() {
  if (await healthy()) return true;
  const server = findServer();
  if (!server) throw new Error('llama-server was not found next to Ollama; set LLAMA_SERVER_EXE in .env or start the server with scripts/start-qari.ps1');
  const dir = process.env.QARI_DIR || 'E:\\ollama\\qari';
  const model = path.join(dir, 'model.gguf');
  const mmproj = path.join(dir, 'mmproj.gguf');
  if (!existsSync(model) || !existsSync(mmproj)) throw new Error(`Qari model files are missing in ${dir}: run scripts/start-qari.ps1 -Download (or set QARI_DIR)`);

  const { gpu, parallel } = runPlan();
  // the server unloads the model after this many idle seconds (VRAM and RAM are given back) and loads it again on the next request
  const idle = process.env.QARI_IDLE_SECONDS === undefined ? 120 : Number(process.env.QARI_IDLE_SECONDS);
  const port = new URL(baseUrl()).port || '8081';
  const lib = path.dirname(server);
  const cuda = path.join(lib, 'cuda_v12');
  const env = { ...process.env, PATH: `${cuda}${path.delimiter}${lib}${path.delimiter}${process.env.PATH || ''}` };
  if (existsSync(path.join(cuda, 'ggml-cuda.dll'))) env.GGML_BACKEND_PATH = path.join(cuda, 'ggml-cuda.dll');

  logger.info({ server, model, gpu, slots: parallel, idleSeconds: idle }, 'starting the Qari-OCR server');
  const proc = spawn(server, [
    '-m', model, '--mmproj', mmproj,
    '-ngl', gpu ? '99' : '0', ...(gpu ? [] : ['--no-mmproj-offload']),
    '-c', String(3072 * parallel), '-np', String(parallel),
    '-lm', 'none', // read the files instead of mapping them: ~4 GB less RAM
    ...(idle > 0 ? ['--sleep-idle-seconds', String(idle)] : []),
    '--host', '127.0.0.1', '--port', port,
  ], {
    cwd: lib, env, windowsHide: true, stdio: 'ignore',
  });
  child = proc;
  let exited = false;
  proc.once('exit', (code) => { exited = true; if (child === proc) child = null; logger.info({ code }, 'Qari-OCR server stopped'); });
  proc.once('error', (err) => { exited = true; logger.error({ err: String(err) }, 'could not start the Qari-OCR server'); });

  for (let i = 0; i < 180 && !exited; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await healthy()) { logger.info('Qari-OCR server is ready'); return true; }
  }
  throw new Error(exited ? 'the Qari-OCR server exited while starting (is the GPU busy or out of memory?)' : 'the Qari-OCR server did not become ready in 3 minutes');
}

/** Make sure the Qari-OCR server is up (no-op for other providers). Safe to call often; concurrent calls share one start. */
export function ensureLlamaServer() {
  if (visionStatus().provider !== 'llamacpp') return Promise.resolve(false);
  pending ||= start().finally(() => { pending = null; });
  return pending;
}

export function stopLlamaServer() {
  if (child) { child.kill(); child = null; }
}
process.once('exit', stopLlamaServer);

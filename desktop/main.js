// Desktop app: runs the converter's own server (backend/) on this machine and shows its interface in a window.
// The local AI reader (Qari-OCR through Ollama's llama-server) starts together with the app when it is installed; when it is
// not, the app offers once to install it (ai/setup-ai.ps1, the same script the installer runs: it looks first, then installs
// only what is missing).
const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const { fork, spawn } = require('node:child_process');

const PREFERRED_PORT = 4170; // not the dev server's 4100: both can run at once
const res = (...p) => (app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, '..', ...p));
const BACKEND = res('backend');
const FRONTEND = res('frontend', 'dist');
const AI_SCRIPT = app.isPackaged ? path.join(process.resourcesPath, 'ai', 'setup-ai.ps1') : path.join(__dirname, 'ai', 'setup-ai.ps1');
const AI_HOME = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'PdfToWord');
const AI_STATE = path.join(AI_HOME, 'ai.json');

let win = null;
let backend = null; // the API child process
let origin = null;
let quitting = false;

// ---- the AI reader: where it is (same places as setup-ai.ps1 and the API look in) --------------------------------------
const fileSize = (f) => { try { return fs.statSync(f).isFile() ? fs.statSync(f).size : 0; } catch { return 0; } };
const readState = () => { try { return JSON.parse(fs.readFileSync(AI_STATE, 'utf8')); } catch { return {}; } };
function writeState(patch) {
  fs.mkdirSync(AI_HOME, { recursive: true });
  fs.writeFileSync(AI_STATE, JSON.stringify({ ...readState(), ...patch }));
}
const hasModels = (dir) => !!dir && fileSize(path.join(dir, 'model.gguf')) > 1e9 && fileSize(path.join(dir, 'mmproj.gguf')) > 3e8;

function aiStatus() {
  const saved = readState();
  const exe = 'llama-server.exe';
  const servers = [saved.server, process.env.LLAMA_SERVER_EXE];
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama')];
  for (const d of dirs.filter(Boolean)) servers.push(path.join(d, 'lib', 'ollama', exe), path.join(d, exe));
  const server = servers.find((f) => f && fileSize(f) > 0) || null;
  const modelDirs = [saved.models, process.env.QARI_DIR, path.join(AI_HOME, 'qari')];
  if (server) { // a "qari" folder next to Ollama (E:\ollama\app -> E:\ollama\qari) or inside it
    const root = server.endsWith(path.join('lib', 'ollama', exe)) ? path.resolve(path.dirname(server), '..', '..') : path.dirname(server);
    modelDirs.push(path.join(path.dirname(root), 'qari'), path.join(root, 'qari'));
  }
  const models = modelDirs.find(hasModels) || null;
  return { server, models, ready: !!(server && models), declined: !!saved.declined };
}

// ---- the API ---------------------------------------------------------------------------------------------------------
function freePort(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => (port ? freePort(0).then(resolve) : resolve(0)));
    s.listen(port, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
}

function healthy(url) {
  return new Promise((resolve) => {
    const req = http.get(`${url}/api/health`, { timeout: 1500 }, (r) => { r.resume(); resolve(r.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

const logFile = () => path.join(app.getPath('userData'), 'logs', 'backend.log');

async function startBackend() {
  const port = await freePort(PREFERRED_PORT);
  const ai = aiStatus();
  fs.mkdirSync(path.dirname(logFile()), { recursive: true });
  const log = fs.openSync(logFile(), 'a');
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1', // Electron's own Node.js runs the API: nothing else to install
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: path.join(app.getPath('userData'), 'storage'),
    FRONTEND_DIST: FRONTEND,
    CORS_ORIGINS: `http://127.0.0.1:${port}`,
  };
  if (ai.ready) {
    // the AI starts with the app (and gives its memory back after 2 idle minutes; it reloads by itself on the next page)
    Object.assign(env, { VISION_PROVIDER: 'llamacpp', LLAMA_SERVER_EXE: ai.server, QARI_DIR: ai.models, QARI_EAGER: '1' });
  }
  const child = fork(path.join(BACKEND, 'src', 'server.js'), [], { cwd: BACKEND, env, stdio: ['ignore', log, log, 'ipc'], windowsHide: true });
  fs.closeSync(log);
  backend = child;
  let exited = false;
  child.once('exit', (code) => {
    exited = true;
    if (backend === child) backend = null;
    if (!quitting && code !== 0 && win) {
      dialog.showErrorBox('PDF to Word', `توقف الخادم الداخلي للبرنامج بشكل غير متوقع (الرمز ${code}).\nالتفاصيل في:\n${logFile()}`);
    }
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240 && !exited; i++) {
    if (await healthy(url)) return { url, ai };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the converter did not start (details in ${logFile()})`);
}

/** Ask the API to stop (it also stops the AI server it started); kill it if it does not within a few seconds. */
function stopBackend() {
  const child = backend;
  if (!child) return Promise.resolve();
  backend = null;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 8000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.send('shutdown'); } catch { child.kill(); }
  });
}

// ---- offering the AI reader when it is missing ------------------------------------------------------------------------
function runAiSetup() {
  return new Promise((resolve) => {
    // its own console window: the downloads show their progress there
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', AI_SCRIPT, '-Install'], { detached: true, stdio: 'ignore', windowsHide: false });
    p.once('exit', (code) => resolve(code === 0));
    p.once('error', () => resolve(false));
  });
}

async function offerAi(ai) {
  if (ai.ready || ai.declined || process.platform !== 'win32') return;
  const missing = [];
  if (!ai.server) missing.push('برنامج Ollama (نحو 1.5 جيجابايت)');
  if (!ai.models) missing.push('نموذج القراءة Qari-OCR (نحو 2.9 جيجابايت)');
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'قارئ الذكاء الاصطناعي',
    message: 'قارئ الذكاء الاصطناعي المحلي غير مثب\u0651ت على هذا الجهاز',
    detail: `ي\u064Fحس\u0651ن قراءة الصفحات الممسوحة كثير\u064Bا ويعمل على جهازك بلا إنترنت بعد التثبيت.\nسي\u064Fنز\u0651ل: ${missing.join('، ')}.\n\nيعمل البرنامج بدونه بالمحرك القياسي.`,
    buttons: ['تثبيت الآن', 'لاحق\u064Bا'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: 'لا تسألني مرة أخرى',
  });
  if (response !== 0) {
    if (checkboxChecked) writeState({ declined: true });
    return;
  }
  const ok = await runAiSetup();
  if (!ok || !aiStatus().ready || quitting) return;
  await stopBackend(); // start again, this time with the AI
  const started = await startBackend();
  origin = started.url;
  win?.loadURL(origin);
}

// ---- window ---------------------------------------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'PDF to Word',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#f8fafc',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  // links to other sites open in the browser; links to the API (downloads) download
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (origin && url.startsWith(origin)) win.webContents.downloadURL(url);
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (origin && url.startsWith(origin)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.loadFile(path.join(__dirname, 'loading.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    createWindow();
    try {
      const { url, ai } = await startBackend();
      origin = url;
      await win?.loadURL(origin);
      offerAi(ai).catch(() => {});
    } catch (err) {
      dialog.showErrorBox('PDF to Word', `تعذ\u0651ر تشغيل البرنامج.\n${err.message}`);
      app.quit();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    if (!backend) return;
    e.preventDefault();
    quitting = true;
    stopBackend().finally(() => app.quit());
  });
}

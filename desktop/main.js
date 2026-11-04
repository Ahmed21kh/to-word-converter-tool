// Desktop app: runs the converter's own server (backend/) on this machine and shows its interface in a window.
// The AI reader is Google Gemini by default: its key is asked for once and kept on this machine only (encrypted). The local
// reader (Qari-OCR through Ollama's llama-server) is optional: chosen from the "AI" menu it replaces Gemini, starts together
// with the app, and is offered for installation when missing (ai/setup-ai.ps1: it looks first, then installs only what is
// missing).
const { app, BrowserWindow, dialog, shell, Menu, ipcMain, safeStorage } = require('electron');
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

// ---- the Gemini key: Windows encrypts it for this user (DPAPI); it never leaves this machine except to Google -----------
function geminiKey() {
  const v = readState().geminiKey;
  if (!v || !v.startsWith('enc:')) return v || '';
  try { return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); } catch { return ''; }
}
function saveGeminiKey(key) {
  if (!key) return writeState({ geminiKey: '' });
  writeState({ geminiKey: safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(key).toString('base64')}` : key });
}

/** Google answers a wrong key with 400/401/403. No network, or a busy service, keeps the key unchecked. */
async function checkGeminiKey(key) {
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20_000) });
    if (r.ok) return { ok: true };
    return [400, 401, 403].includes(r.status) ? { ok: false } : { ok: true, unchecked: true };
  } catch {
    return { ok: true, unchecked: true };
  }
}

/** The reader the API is started with: the local one when chosen (and installed), else Gemini when there is a key, else none. */
function readerEnv(ai) {
  const off = { LOCAL_AI: '0', VISION_PROVIDER: '' };
  if (readState().localAi) {
    // the local reader starts with the app (and gives its memory back after 2 idle minutes; it reloads by itself on the next page)
    return ai.ready ? { LOCAL_AI: '1', LOCAL_AI_PROVIDER: 'llamacpp', LLAMA_SERVER_EXE: ai.server, QARI_DIR: ai.models, QARI_EAGER: '1' } : off;
  }
  const key = geminiKey();
  return key ? { LOCAL_AI: '0', VISION_PROVIDER: 'gemini', GEMINI_API_KEY: key } : off;
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
    ...readerEnv(ai),
  };
  const child = fork(path.join(BACKEND, 'src', 'server.js'), [], { cwd: BACKEND, env, stdio: ['ignore', log, log, 'ipc'], windowsHide: true });
  fs.closeSync(log);
  backend = child;
  let exited = false;
  child.once('exit', (code) => {
    exited = true;
    if (backend === child) backend = null;
    if (!quitting && !child.stopping && code !== 0 && win) {
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
  child.stopping = true; // stopped on purpose: no "stopped unexpectedly" message
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 8000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.send('shutdown'); } catch { child.kill(); }
  });
}

/** Start the API again (another AI reader) and show it. */
async function restartBackend() {
  await stopBackend();
  const started = await startBackend();
  origin = started.url;
  await win?.loadURL(origin);
  return started.ai;
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

async function offerAi(ai, { asked = false } = {}) {
  if (ai.ready || (ai.declined && !asked) || process.platform !== 'win32') return;
  const missing = [];
  if (!ai.server) missing.push('برنامج Ollama (نحو 1.5 جيجابايت)');
  if (!ai.models) missing.push('نموذج القراءة Qari-OCR (نحو 2.9 جيجابايت)');
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'قارئ الذكاء الاصطناعي',
    message: 'قارئ الذكاء الاصطناعي المحلي غير مثب\u0651ت على هذا الجهاز',
    detail: `يقرأ الصفحات الممسوحة على جهازك بلا إنترنت بعد التثبيت، بدل Gemini.\nسي\u064Fنز\u0651ل: ${missing.join('، ')}.\n\nحتى يكتمل تثبيته ي\u064Fستخدم المحرك القياسي.`,
    buttons: ['تثبيت الآن', 'لاحق\u064Bا'],
    defaultId: 0,
    cancelId: 1,
    ...(asked ? {} : { checkboxLabel: 'لا تسألني مرة أخرى' }),
  });
  if (response !== 0) {
    if (checkboxChecked) writeState({ declined: true });
    return;
  }
  const ok = await runAiSetup();
  if (!ok || !aiStatus().ready || quitting) return;
  await restartBackend(); // start again, this time with the AI
}

// ---- choosing the AI reader: the "AI" menu -------------------------------------------------------------------------
let keyWindow = null;

/** The Gemini key window; resolves when it closes. */
function askGeminiKey() {
  if (keyWindow) { keyWindow.focus(); return new Promise((resolve) => keyWindow.once('closed', resolve)); }
  return new Promise((resolve) => {
    keyWindow = new BrowserWindow({
      parent: win || undefined,
      modal: !!win,
      width: 560,
      height: 330,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      title: 'مفتاح Gemini',
      icon: path.join(__dirname, 'build', 'icon.png'),
      backgroundColor: '#f8fafc',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    keyWindow.setMenu(null);
    keyWindow.once('ready-to-show', () => keyWindow.show());
    keyWindow.webContents.on('will-navigate', (e) => e.preventDefault());
    keyWindow.on('closed', () => { keyWindow = null; resolve(); });
    keyWindow.loadFile(path.join(__dirname, 'key.html'));
  });
}

ipcMain.handle('gemini-key:info', () => ({ hasKey: !!geminiKey() }));
ipcMain.handle('gemini-key:save', async (_e, key) => {
  const k = String(key || '').trim();
  const r = await checkGeminiKey(k);
  if (r.ok) saveGeminiKey(k);
  return r;
});
ipcMain.handle('gemini-key:remove', () => saveGeminiKey(''));
ipcMain.on('gemini-key:close', () => keyWindow?.close());
ipcMain.on('gemini-key:studio', () => shell.openExternal('https://aistudio.google.com/apikey'));

/** Restarting stops a conversion that is running: asked first. */
async function confirmRestart() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'PDF to Word',
    message: 'سيُعاد تشغيل المحوّل الآن',
    detail: 'أي تحويل جارٍ سيتوقف.',
    buttons: ['متابعة', 'إلغاء'],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

async function chooseReader(local) {
  if (!!readState().localAi === local) return;
  if (!(await confirmRestart())) return buildMenu(); // the radio goes back to the reader in use
  writeState({ localAi: local });
  if (!local && !geminiKey()) await askGeminiKey();
  const ai = await restartBackend();
  buildMenu();
  if (local) await offerAi(ai, { asked: true });
}

async function changeGeminiKey() {
  const before = geminiKey();
  await askGeminiKey();
  // the key only matters while Gemini is the reader
  if (geminiKey() !== before && !readState().localAi) await restartBackend();
}

function buildMenu() {
  const local = !!readState().localAi;
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'الذكاء الاصطناعي',
    submenu: [
      { label: 'Google Gemini (عبر الإنترنت)', type: 'radio', checked: !local, click: () => chooseReader(false).catch(() => {}) },
      { label: 'القارئ المحلي Qari (بلا إنترنت)', type: 'radio', checked: local, click: () => chooseReader(true).catch(() => {}) },
      { type: 'separator' },
      { label: 'مفتاح Gemini...', click: () => changeGeminiKey().catch(() => {}) },
    ],
  }]));
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
    buildMenu();
    createWindow();
    try {
      const { url, ai } = await startBackend();
      origin = url;
      await win?.loadURL(origin);
      const saved = readState();
      if (saved.localAi) offerAi(ai).catch(() => {});
      else if (!geminiKey() && !saved.keyAsked) {
        // the first start: Gemini needs a key (asked once; later from the "AI" menu)
        writeState({ keyAsked: true });
        await askGeminiKey();
        if (geminiKey()) await restartBackend();
      }
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

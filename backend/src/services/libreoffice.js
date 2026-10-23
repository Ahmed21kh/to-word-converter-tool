// Optional LibreOffice integration (free): Office/OpenDocument/RTF -> docx, and docx -> legacy .doc.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';

const CANDIDATES = [
  config.sofficePath,
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  '/usr/bin/soffice',
  '/usr/bin/libreoffice',
  '/usr/local/bin/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
].filter(Boolean);

let detected;
export function sofficeBinary() {
  if (detected === undefined) detected = CANDIDATES.find((p) => existsSync(p)) || null;
  return detected;
}
export const libreOfficeAvailable = () => !!sofficeBinary();

let chain = Promise.resolve(); // LibreOffice conversions are serialised

/** @returns {Promise<string>} path of the converted file */
export function convertWithLibreOffice(inFile, outDir, targetExt, jobId, timeoutMs = 10 * 60 * 1000) {
  const run = async () => {
    const bin = sofficeBinary();
    if (!bin) throw new Error('LibreOffice is not installed on the server');
    await mkdir(outDir, { recursive: true });
    const profile = pathToFileURL(path.join(outDir, `.lo-profile-${jobId}`)).href;
    const filter = targetExt === 'doc' ? 'doc:MS Word 97' : targetExt;
    await new Promise((resolve, reject) => {
      const args = [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', filter, '--outdir', outDir, inFile];
      const p = spawn(bin, args, { stdio: 'ignore' });
      const t = setTimeout(() => {
        p.kill('SIGKILL');
        reject(new Error('LibreOffice conversion timed out'));
      }, timeoutMs);
      p.on('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
      p.on('exit', (code) => {
        clearTimeout(t);
        if (code === 0) resolve();
        else reject(new Error(`LibreOffice exited with code ${code}`));
      });
    });
    const base = path.basename(inFile, path.extname(inFile));
    const produced = (await readdir(outDir)).find((f) => f.toLowerCase() === `${base}.${targetExt}`.toLowerCase());
    if (!produced) throw new Error('LibreOffice produced no output');
    return path.join(outDir, produced);
  };
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

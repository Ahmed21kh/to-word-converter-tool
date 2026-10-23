// Copies the Arabic + English Tesseract models (npm packages, "best" quality, int8) into data/tessdata
// so OCR works fully offline and deterministically.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'data', 'tessdata');
mkdirSync(out, { recursive: true });
for (const lang of ['ara', 'eng']) {
  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
  } catch {
    console.warn(`[tessdata] package @tesseract.js-data/${lang} not installed - skipping`);
    continue;
  }
  const src = ['4.0.0_best_int', '4.0.0'].map((d) => path.join(pkgDir, d, `${lang}.traineddata.gz`)).find(existsSync);
  if (!src) {
    console.warn(`[tessdata] no traineddata for ${lang}`);
    continue;
  }
  copyFileSync(src, path.join(out, `${lang}.traineddata.gz`));
  console.log(`[tessdata] ${lang} <- ${path.relative(root, src)}`);
}

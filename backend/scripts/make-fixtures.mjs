// Generates realistic test PDFs (via headless Edge/Chrome) into test/fixtures.
//   node scripts/make-fixtures.mjs
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'test', 'fixtures');
mkdirSync(out, { recursive: true });

const quran = JSON.parse(readFileSync(path.join(here, '..', 'data', 'quran-uthmani.json'), 'utf8'));
const verse = (s, a) => quran.find((v) => v[0] === s && v[1] === a)[2];

// image that contains Arabic words (must survive untouched)
GlobalFonts.registerFromPath('C:\\Windows\\Fonts\\trado.ttf', 'TradArabic');
const cv = createCanvas(900, 220);
const cx = cv.getContext('2d');
cx.fillStyle = '#fff7e0';
cx.fillRect(0, 0, 900, 220);
cx.fillStyle = '#12355b';
cx.font = '84px TradArabic';
cx.direction = 'rtl';
cx.textAlign = 'center';
cx.fillText('بسم الله الرحمن الرحيم', 450, 120);
cx.font = '40px TradArabic';
cx.fillText('صورة تحتوي على كلمات عربية', 450, 190);
writeFileSync(path.join(out, 'arabic-banner.png'), cv.toBuffer('image/png'));

const para = 'الحمد لله رب العالمين، والصلاة والسلام على أشرف الأنبياء والمرسلين، نبينا محمد وعلى آله وصحبه أجمعين. أما بعد، فإن العلم النافع من أجل\u0651 الأعمال، وقد اهتم علماء الأمة بتدوينه ونشره في الآفاق، فكتبوا المجلدات وجمعوا الروايات.';

let pages = '';
for (let i = 1; i <= 3; i++) {
  pages += `
<section class="page">
  <h1>الفصل ${i}: أهمية العلم</h1>
  <p>${para}</p>
  <p>قال الله تعالى: \uFD3F${verse(2, 255)}\uFD3E [البقرة: 255]</p>
  <p>وقال سبحانه: \uFD3F${verse(112, 1)} ${verse(112, 2)} ${verse(112, 3)} ${verse(112, 4)}\uFD3E</p>
  <p>وفي الحديث: «طلب العلم فريضة على كل مسلم». رواه ابن ماجه برقم 224، وصححه الألباني. وقد ط\u064Fبع الكتاب في دار Dar Al-Salam سنة 2015م.</p>
  ${i === 1 ? '<p style="text-align:center"><img src="arabic-banner.png" width="520"></p>' : ''}
  ${i === 2 ? `<table><tr><th>الرقم</th><th>اسم السورة</th><th>عدد الآيات</th></tr>
    <tr><td>١</td><td>الفاتحة</td><td>٧</td></tr><tr><td>٢</td><td>البقرة</td><td>٢٨٦</td></tr>
    <tr><td>١١٢</td><td>الإخلاص</td><td>٤</td></tr></table>` : ''}
  <p>${para}</p>
</section>`;
}

const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 20mm; }
  body { font-family: 'Traditional Arabic', 'Arial'; font-size: 20pt; line-height: 1.7; }
  h1 { font-size: 26pt; text-align: center; }
  .page { break-after: page; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  td, th { border: 1px solid #444; padding: 6px; text-align: center; }
</style></head><body>${pages}</body></html>`;

const htmlPath = path.join(out, 'arabic-sample.html');
writeFileSync(htmlPath, html, 'utf8');

const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
if (!edge) throw new Error('Edge not found');
execFileSync(edge, [
  '--headless', '--disable-gpu', '--no-pdf-header-footer',
  `--print-to-pdf=${path.join(out, 'arabic-sample.pdf')}`,
  pathToFileURL(htmlPath).href,
], { stdio: 'inherit' });
console.log('written', out);

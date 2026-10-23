// Generates a large Arabic PDF (default 650 pages) for load testing, plus ground-truth verses.
//   node scripts/make-big-fixture.mjs [pages]
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'test', 'fixtures');
mkdirSync(out, { recursive: true });
const pages = Number(process.argv[2] || 650);
const quran = JSON.parse(readFileSync(path.join(here, '..', 'data', 'quran-uthmani.json'), 'utf8'));
const names = JSON.parse(readFileSync(path.join(here, '..', 'data', 'surah-names.json'), 'utf8'));

const para = [
  'الحمد لله رب العالمين، والصلاة والسلام على أشرف الأنبياء والمرسلين، نبينا محمد وعلى آله وصحبه أجمعين.',
  'العلم النافع من أجل الأعمال، وقد اهتم علماء الأمة بتدوينه ونشره في الآفاق، فكتبوا المجلدات وجمعوا الروايات وحققوا المسائل.',
  'ومن أهم ما ينبغي لطالب العلم أن يعتني بحفظ كتاب الله تعالى وتدبر معانيه، وأن يتخلق بأخلاق القرآن في سائر أحواله.',
];
const truth = [];
let body = '';
for (let i = 1; i <= pages; i++) {
  let k = (i * 97) % quran.length;
  while (quran[k][2].split(' ').length > 28) k = (k + 1) % quran.length;
  const [s, a, text] = quran[k];
  truth.push({ page: i, surah: s, ayah: a, text });
  body += `<section class="page"><h1>الباب ${i}: فوائد وأحكام</h1>
<p>${para[i % 3]} ${para[(i + 1) % 3]}</p>
<p>قال الله تعالى: \uFD3F${text}\uFD3E [${names[s - 1]}: ${a}]</p>
<p>${para[(i + 2) % 3]} وفي الحديث: «إنما الأعمال بالنيات». رقم الصفحة ${i}.</p></section>`;
}
const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 20mm; } body { font-family: 'Traditional Arabic'; font-size: 20pt; line-height: 1.7; }
h1 { font-size: 26pt; text-align: center; } .page { break-after: page; }</style></head><body>${body}</body></html>`;
const htmlPath = path.join(out, `arabic-${pages}.html`);
writeFileSync(htmlPath, html, 'utf8');
writeFileSync(path.join(out, `arabic-${pages}.truth.json`), JSON.stringify(truth));
const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
execFileSync(edge, ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${path.join(out, `arabic-${pages}.pdf`)}`, pathToFileURL(htmlPath).href], { stdio: 'inherit', timeout: 300000 });
console.log('done', pages, 'pages');

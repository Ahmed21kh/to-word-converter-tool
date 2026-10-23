// Generates the social preview image (1200x630) and PWA icons into public/.   npm run og
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fonts = path.join(root, 'node_modules', '@fontsource', 'cairo', 'files');
GlobalFonts.registerFromPath(path.join(fonts, 'cairo-arabic-800-normal.woff2'), 'CairoAr');
GlobalFonts.registerFromPath(path.join(fonts, 'cairo-latin-800-normal.woff2'), 'CairoLat');

function logo(ctx, x, y, size) {
  const k = size / 64;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.fillStyle = '#2f8478';
  ctx.beginPath();
  ctx.roundRect(0, 0, 64, 64, 14);
  ctx.fill();
  ctx.fillStyle = '#fffefb';
  ctx.beginPath();
  ctx.moveTo(18, 12);
  ctx.lineTo(38, 12);
  ctx.lineTo(48, 22);
  ctx.lineTo(48, 52);
  ctx.quadraticCurveTo(48, 54, 46, 54);
  ctx.lineTo(18, 54);
  ctx.quadraticCurveTo(16, 54, 16, 52);
  ctx.lineTo(16, 14);
  ctx.quadraticCurveTo(16, 12, 18, 12);
  ctx.fill();
  ctx.fillStyle = '#afddd4';
  ctx.beginPath();
  ctx.moveTo(38, 12);
  ctx.lineTo(38, 22);
  ctx.lineTo(48, 22);
  ctx.fill();
  ctx.strokeStyle = '#2f8478';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const [x1, x2, yy] of [[24, 40, 34], [24, 40, 40], [24, 34, 46]]) {
    ctx.beginPath();
    ctx.moveTo(x1, yy);
    ctx.lineTo(x2, yy);
    ctx.stroke();
  }
  ctx.restore();
}

// social preview image
{
  const c = createCanvas(1200, 630);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 1200, 630);
  g.addColorStop(0, '#1a4641');
  g.addColorStop(1, '#2f8478');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1200, 630);
  ctx.globalAlpha = 0.08;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  for (let x = 0; x < 1200; x += 100) {
    for (let y = 0; y < 630; y += 100) {
      ctx.beginPath();
      ctx.arc(x + 50, y + 50, 38, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  logo(ctx, 80, 80, 110);
  ctx.fillStyle = '#fffefb';
  ctx.textAlign = 'right';
  ctx.direction = 'rtl';
  ctx.font = '70px CairoAr';
  ctx.fillText('تحويل PDF العربي إلى Word', 1120, 300);
  ctx.font = '44px CairoAr';
  ctx.fillStyle = '#d6ece7';
  ctx.fillText('بلا حروف مقلوبة • مع التحقق من الآيات • +600 صفحة', 1120, 400);
  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
  ctx.font = '40px CairoLat';
  ctx.fillStyle = '#afddd4';
  ctx.fillText('Arabic PDF to Word  |  Quran-safe  |  OCR', 80, 560);
  writeFileSync(path.join(root, 'public', 'og-image.png'), c.toBuffer('image/png'));
}
// PWA icons
for (const size of [192, 512]) {
  const c = createCanvas(size, size);
  logo(c.getContext('2d'), 0, 0, size);
  writeFileSync(path.join(root, 'public', `icon-${size}.png`), c.toBuffer('image/png'));
}
console.log('generated og-image.png, icon-192.png, icon-512.png');

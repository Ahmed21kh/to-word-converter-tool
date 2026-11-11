// printMatch: a page number read by the shapes of its digits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { readPageDigits } from '../src/pipeline/page-digits.js';

/** A number as a book prints it in its head: small, between the dashes of the rule, with a speck of dust under it. */
function printed(text, font) {
  const c = createCanvas(220, 60);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 220, 60);
  ctx.fillStyle = '#000';
  ctx.fillRect(4, 30, 40, 4); // the dash before
  ctx.font = `bold 34px "${font}"`;
  ctx.fillText(text, 60, 44);
  ctx.fillRect(170, 30, 40, 4); // the dash after
  ctx.fillRect(150, 54, 2, 2); // dust at the foot of the line
  const px = ctx.getImageData(0, 0, 220, 60).data;
  const gray = new Uint8Array(220 * 60);
  for (let i = 0; i < gray.length; i++) gray[i] = px[i * 4];
  return [gray, 220, 60];
}

const fonts = GlobalFonts.families.map((f) => f.family);
const font = ['Simplified Arabic', 'Traditional Arabic', 'Arial'].find((f) => fonts.includes(f));

test('a page number is read by the shapes of its digits, Arabic-Indic or Western, with its zero', { skip: !font && 'no Arabic font' }, async () => {
  for (const [text, n, indic] of [['٥٦', 56, true], ['١٥', 15, true], ['٤٠', 40, true], ['١٢٨', 128, true], ['37', 37, false]]) {
    const r = await readPageDigits(...printed(text, font));
    assert.equal(r?.n, n, `${text} read as ${r?.text}`);
    assert.equal(r.indic, indic, text);
  }
});

test('a reference of two numbers is read whole: a volume and its page across a slash, a range across a dash', async () => {
  const sharp = (await import('sharp')).default;
  const { lineNumbers } = await import('../src/pipeline/page-digits.js');
  // cut from a scanned book's note: "( ١٢٥/١٠ )", "( ١٦٧ـ١٤٢ )" and "( ٦١/١ )" as the page shows them
  for (const [name, want] of [['volume', '١٢٥/١٠'], ['range', '١٤٢ـ١٦٧'], ['volume-short', '٦١/١']]) {
    const { data, info } = await sharp(fileURLToPath(new URL(`./fixtures/ref-number-${name}.png`, import.meta.url)))
      .greyscale().raw().toBuffer({ resolveWithObject: true });
    const found = await lineNumbers(data, info.width, info.height, { x0: 0, x1: info.width, y0: 0, y1: info.height });
    assert.deepEqual(found.map((n) => n.text), [want], name);
  }
});

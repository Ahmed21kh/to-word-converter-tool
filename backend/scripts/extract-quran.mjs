\uFEFF// One-off: extract only the Arabic Quran text from the quran-json package into data/quran-uthmani.json
import { readFileSync, writeFileSync } from 'node:fs';
const src = JSON.parse(readFileSync('node_modules/quran-json/dist/quran.json', 'utf8'));
const out = [];
for (const surah of src) for (const v of surah.verses) out.push([surah.id, v.id, v.text]);
writeFileSync('data/quran-uthmani.json', JSON.stringify(out));
console.log('verses:', out.length);

# backend/data

| File / folder | Purpose |
| --- | --- |
| `quran-uthmani.json` | The Quran text for verification: `[surah, ayah, text]` × 6236 (Hafs, Uthmani script, with diacritics). Source: the Noble Qur'an Encyclopedia (quranenc.com) through the `quran-json` dataset, **CC BY 4.0** (keep the attribution). Only the Arabic text is included. To use another authoritative text (e.g. Tanzil or the King Fahd Complex), replace this file keeping the same shape. |
| `surah-names.json` | The 114 Arabic surah names, used to check citations like `[البقرة: 255]`. |
| `tessdata/` | Tesseract models `ara.traineddata.gz` and `eng.traineddata.gz` (copied by `npm install`), so OCR needs no internet. |

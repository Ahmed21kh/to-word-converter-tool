# PDF to Word Converter (Arabic-first)

Converts **PDF** (main use), images and text files to **Word (.docx)** with a focus on what usually breaks with Arabic:
reversed letters, scrambled pages, lost diacritics and damaged Quran verses.

| Folder | What it is |
| --- | --- |
| [`backend/`](backend/README.md) | Node.js API + conversion pipeline (page workers, OCR, Quran verification, docx builder) |
| [`frontend/`](frontend/README.md) | React + Ant Design + Tailwind UI (Arabic default, English, light / dark / auto theme), pre-rendered for SEO |

## Quick start

```bash
npm run install:all        # installs backend + frontend (downloads nothing at run time; OCR models are bundled)
npm run dev                # API on :4000 (nodemon) + web on :5173 (Vite), one terminal
```

Open <http://localhost:5173>. Production:

```bash
npm run build              # frontend -> frontend/dist (10 pre-rendered pages, sitemap, robots)
npm start                  # API serves the built site too: http://localhost:4000
npm test                   # backend tests (Arabic utils, Quran guard, full pipeline)
```

Requirements: Node.js 20+ (developed on 24). Everything is free / open source. **Optional:** LibreOffice on the server enables
`.doc` output and Office/RTF input (the API reports this honestly at `/api/capabilities`).

## How the conversion works

```
upload ──> job queue ──> worker threads (one PDF page per task)
                             │
        glyph-level text extraction (pdf.js)  ── exact Unicode per glyph + exact position
        layout: bidi order, diacritics, columns, tables, paragraphs, images
        text layer unreliable? ──> OCR (Tesseract ara+eng, local models)
                             │
        Quran guard: match ﴿…﴾ against the Mushaf, repair letters/diacritics, check [surah: ayah]
                             │
        docx builder (one Word section per PDF page, RTL runs, complex-script fonts) + preview + report
```

Key decisions (and why):

* **Glyph-level extraction, not text chunks.** PDFs store Arabic as shaped glyphs in visual order, and fonts such as
  Traditional Arabic use ligature glyphs ("لله", "في"). Chunk-based extractors reverse or swap those letters. We read each glyph's
  Unicode and position, rebuild the logical order with a bidi pass, then normalise presentation forms back to real letters.
* **Diacritics are separate floating glyphs** in PDFs; each is attached to its base letter by position.
* **Images are never re-typed.** Pictures (and the words inside them) are cropped from the rendered page and embedded as-is.
* **OCR only when needed** (scanned page, or a text layer that fails quality checks), because a good text layer beats any OCR.
* **600+ pages:** pages run in parallel on a worker pool; the 650-page test file below converts in seconds.

## What was verified (on this machine)

* 650-page Arabic PDF (a different Quran verse on every page): converted in **~7.5 s** with 3 workers; **649 of 650 verses came out
  identical to the Mushaf text** and the last one was flagged for review in the report; peak server memory ≈ 0.8 GB.
* Unit + pipeline tests: 19 passing (`npm test`).
* Browser flow in Edge (upload → progress → preview → download, side menu, dark/light) with zero console errors.
* Downloads support `HEAD` and `Range` (resume, download managers).

## Honest limits

* **No tool can promise zero mistakes for every PDF.** Text-layer PDFs are very accurate; scanned pages depend on scan quality.
  The report lists pages to review and uncertain OCR words are highlighted in yellow.
* **No free OCR reads fully diacritised Uthmani script reliably.** For scanned Mushaf pages use the *Exact look* mode.
* Verse repair needs the verse to be wrapped in ﴿ ﴾ (or be a whole paragraph of Quran text). A verse that continues onto the next
  page is not joined across pages.
* The output was validated by parsing the `.docx` (python-docx) and by an in-app preview; it was **not opened in Microsoft Word**
  on the development machine (none installed). Open one converted file in Word once to confirm fonts and spacing to your taste.
* Borderless tables and multi-column layouts without clear gutters fall back to reading order.

## Credits

Quran text used for verification: Hafs, Uthmani script, from the Noble Qur'an Encyclopedia (quranenc.com) via the `quran-json`
dataset, CC BY 4.0. Please verify important verses against an approved printed Mushaf. Libraries: pdf.js, Tesseract (tesseract.js),
docx, sharp, @napi-rs/canvas, Express, React, Ant Design, Tailwind CSS.

---

## ملخص بالعربية

أداة لتحويل ملفات **PDF** (والصور والنصوص) إلى **Word** بدقة عالية للغة العربية: بلا حروف مقلوبة، وبترتيب صحيح للصفحات،
مع التحقق من **الآيات القرآنية** ومطابقتها بالمصحف، وإبقاء **الصور** (وما فيها من كلمات) كما هي، ودعم ملفات تتجاوز **600 صفحة**.

* التشغيل: `npm run install:all` ثم `npm run dev` وافتح `http://localhost:5173`.
* الواجهة بالعربية افتراضيًا مع الإنجليزية، ومظهر فاتح/داكن/تلقائي.
* بعد التحويل: **معاينة** للملف داخل الأداة ثم **تنزيل**، وتقرير يبيّن الصفحات التي تحتاج مراجعة.
* تنبيه صريح: لا توجد أداة تضمن خلوّ كل الملفات من الأخطاء؛ الصفحات الممسوحة ضوئيًا تعتمد على جودة المسح، والخط العثماني المشكَّل لا
  يقرؤه أي OCR مجاني بدقة تامة، ولذلك نوفّر وضع «مطابق للأصل».

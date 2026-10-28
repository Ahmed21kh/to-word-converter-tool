# PDF to Word Converter (Arabic-first)

Converts   PDF** (main use), images and text files to **Word (.docx)** with a focus on what usually breaks with Arabic:
reversed letters, scrambled pages, lost diacritics and damaged Quran verses.

| Folder | What it is |
| --- | --- |
| [`backend/`](backend/README.md) | Node.js API + conversion pipeline (page workers, OCR, Quran verification, docx builder) |
| [`frontend/`](frontend/README.md) | React + Ant Design + Tailwind UI (Arabic default, English, light / dark / auto theme), pre-rendered for SEO |

## Quick start

```bash
npm run install:all        # installs backend + frontend (downloads nothing at run time; OCR models are bundled)
npm run dev                # API on :4100 (nodemon) + web on :5173 (Vite), one terminal
```

Open <http://localhost:5173>. Production:

```bash
npm run build              # frontend -> frontend/dist (10 pre-rendered pages, sitemap, robots)
npm start                  # API serves the built site too: http://localhost:4100
npm test                   # backend tests (Arabic utils, Quran guard, full pipeline)
```

Requirements: Node.js 22+ (developed on 24; the PDF library needs Promise.withResolvers). Everything is free / open source. **Optional:** LibreOffice on the server enables
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
* **Scanned books:** frames/ornaments are cropped, heavy diacritics are removed before reading (letter accuracy on a real vowelled book went from 54% to 86%), the Arabic-only model is used, low-confidence words are highlighted, covers/calligraphy stay pictures, and recognised Quran verses are restored with full diacritics. For near-perfect results turn on the optional **AI reading** engine (see below).
* **600+ pages:** pages run in parallel on a worker pool; the 650-page test file below converts in seconds.

## Better accuracy on scanned pages: AI reading (optional)

Free OCR reads diacritised Arabic books at roughly 86% letter accuracy (about 60% of words fully right). A vision AI model reads the same pages far better. Enable it on the server:

```bash
# Anthropic API (official SDK). Page images are sent to Anthropic; billed per use.
VISION_PROVIDER=claude  ANTHROPIC_API_KEY=sk-ant-...  npm start
# or a local model with Ollama (free; needs a capable GPU for speed)
VISION_PROVIDER=ollama  VISION_MODEL=qwen2.5vl:7b  npm start
```

Then choose **Reading engine → AI** in the options. If the AI is unavailable, declines a page, or errors, that page automatically falls back to the free engine, so a page is never lost. The Quran guard still verifies the AI's text. The AI path is tested against a mock of the API; it has **not** been run against the real service from this repository (no key), so measure it on your own pages first.

### Free local AI (no payment, no data leaves the machine)

```powershell
# Windows (resumable; installs on the drive you choose)
powershell -ExecutionPolicy Bypass -File backend/scripts/setup-local-ai.ps1 -Model qwen2.5vl:7b -InstallDir E:\ollama
# Linux / macOS
curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen2.5vl:7b
```

Then measure it on your own page before relying on it: `node backend/scripts/ai-eval.mjs "book.pdf" 8 backend/test/fixtures/truth-page8.txt`
(prints letter accuracy and accuracy with diacritics). Sizing, honestly: the 7B model needs a GPU with about 8 GB of VRAM to be fast
(roughly tens of seconds per page); on a CPU-only machine use `qwen2.5vl:3b` and expect minutes per page. The download is about 7.5 GB in total.
A web deployment runs Ollama on the **server** (the visitors' devices need nothing).

#### Quran verses in AI-read text

The line reader cannot print the ornate brackets: it writes ﴿ ﴾ as `( )`, `*`, `؟`, `»` or a short junk word, confuses dotted letters
(ن/ت/ي, ع/غ, ر/ز), runs words together and misreads the small citation digits. The Quran guard therefore, for AI-read pages:

* finds a verse by its words between such delimiters (a letter-skeleton comparison tolerates the dot errors), grows it while the next
  printed word is the next word of the Mushaf, and turns the delimiters around it into ﴿ ﴾;
* leaves the book's own words alone: text with no bracket on either side, a hadith in « », a heading, and the author's words inside a
  quotation (`- يا مُحَمَّدُ -`, `- فَاسْتَمِعْ -`, kept between dashes);
* reads short quotations (`﴿وَٱلۡإِنجِيلَ﴾`, `﴿كُن فَيَكُونُ﴾`) only next to the verses the page is explaining, and takes the nearest
  place for a phrase the Quran repeats;
* sets the citation numbers from the verse found when the match is certain (`[آل عمران: ١١-١٢]` → `[آل عمران: ٢١-٢٦]`; a range
  starts at the first verse quoted since the previous citation); every change is listed in the report;
* puts back the ﷺ ligature. The reader cannot read it and writes a different junk word for it at every reading ("مَيْتٍ،", then
  "وَكَمْ،"), while a real word after "رسول الله" reads the same twice: a line that mentions the Prophet is read again enlarged and
  the word after the mention becomes ﷺ where the readings disagree (or ﷺ goes before it when the second reading shows the
  first one dropped the glyph). The ligature is kept as one character (U+FDFA), not spelled out.

Measured on 11 pages of *al-Rawd al-Unuf* (vol. 5): 86 quotations, all matched to the Mushaf, 16 misread citation numbers set right,
5 ﷺ restored; 64 s for the 11 pages on an 8 GB GPU. A text line that comes out much shorter than its ink is read again enlarged
(that brought back a verse start the reader had skipped).

#### What was tried for the free engine, and what did not work

Measured on one real vowelled book page (letter accuracy): plain Tesseract 54% → cropped + diacritics stripped + Arabic-only model **88%**.
Not helpful and therefore not shipped: line-by-line recognition (60%, touching lines are merged), the larger "float best" Tesseract model
(does not run in the WebAssembly engine), Hunspell dictionary correction (no gain: 88.2% before and after), and a PaddleOCR Arabic ONNX model
(did not produce usable text even on clean synthetic lines).
Native Tesseract 5.4 with the larger "best" Arabic model was also measured on the same page: 84.9% (the bundled fast model scores 86.0% with the native engine too), so the engine and model size are not the limit.

## Deploy: frontend on Vercel, API on Render

Both deploy from this GitHub repository; push first.

1. **API on Render**: New > Blueprint > this repository ([render.yaml](render.yaml)). When asked, set `CORS_ORIGINS` to the
   Vercel address (e.g. `https://your-site.vercel.app`, no trailing slash) and `PUBLIC_URL` to the Render address
   (e.g. `https://pdf2word-api.onrender.com`). Leave `VISION_PROVIDER` empty for the free OCR, or set `claude` and
   `ANTHROPIC_API_KEY` (the local Qari model cannot run on Render). Check `https://<api>/api/health`.
2. **Site on Vercel**: Add New > Project > this repository, **Root Directory `frontend`** (build settings come from
   [frontend/vercel.json](frontend/vercel.json)). Environment variables: `VITE_API_URL` = the Render address,
   `VITE_SITE_URL` = the Vercel address. Both are built into the pages, so redeploy after changing them.
3. Back on Render, make sure `CORS_ORIGINS` holds the final Vercel address (a custom domain too, comma separated).

Render's free plan has 512 MB and sleeps after 15 idle minutes (the first request then takes about a minute); keep
`WORKERS=1` there. For real use pick a 2 GB plan and `WORKERS=2`. Files live on the instance's own disk: a restart or a
redeploy loses unfinished jobs. If every visitor hits the rate limit together, the visitor's address is behind more
proxies than counted: set `TRUST_PROXY=2` (or 3).

## What was verified (on this machine)

* 650-page Arabic PDF (a different Quran verse on every page): converted in **~7.5 s** with 3 workers; **649 of 650 verses came out
  identical to the Mushaf text** and the last one was flagged for review in the report; peak server memory ≈ 0.8 GB.
* Unit + pipeline + AI-plumbing tests: 56 passing (`npm test`).
* Browser flow in Edge (upload → progress → preview → download, side menu, dark/light) with zero console errors.
* Downloads support `HEAD` and `Range` (resume, download managers).

## Honest limits

* **No tool can promise zero mistakes for every PDF.** Text-layer PDFs are very accurate; scanned pages depend on scan quality.
  The report lists pages to review and uncertain OCR words are highlighted in yellow.
* **No free OCR reads fully diacritised Uthmani script reliably.** For scanned Mushaf pages use the *Exact look* mode.
* Verse repair needs the verse to be wrapped in ﴿ ﴾ (or be a whole paragraph of Quran text); in AI-read text, in whatever the reader
  made of the brackets (see above). A verse that continues onto the next page is not joined across pages, and words the reader
  skipped inside a verse are not added back (a quotation may legitimately leave words out).
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

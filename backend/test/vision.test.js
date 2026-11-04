// AI reading: plumbing tested against a local mock of the Anthropic Messages API (no real key, no network).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/scan-sample.pdf', import.meta.url));

let server;
let mode = 'ok';
const seen = [];
const lineAnswers = []; // answers for per-line requests (logprobs asked)
const ANSWER = [
  '# الفصل الأول',
  'وقال سبحانه قل هو الله أحد الله الصمد لم يلد ولم يولد ولم يكن له كفوا أحد وهذا كلام عادي بعد الآية.',
].join('\n\n');

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/v1/chat/completions') { // llama.cpp server (OpenAI-compatible)
        const sent = JSON.parse(body);
        seen.push({ llama: sent });
        res.writeHead(200, { 'content-type': 'application/json' });
        const text = sent.logprobs ? (lineAnswers.shift() || '') : ANSWER;
        const content = [...text].map((ch) => {
          const bytes = [...Buffer.from(ch)];
          const lp = ch === 'ق' ? Math.log(0.3) : Math.log(0.99);
          const top = [{ token: ch, logprob: lp, bytes }];
          if (ch === 'ق') top.push({ token: 'ف', logprob: Math.log(0.6), bytes: [...Buffer.from('ف')] });
          return { token: ch, logprob: lp, bytes, top_logprobs: top };
        });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop', logprobs: sent.logprobs ? { content } : null }], usage: { prompt_tokens: 500, completion_tokens: content.length } }));
        return;
      }
      if (req.url.includes(':generateContent')) { // Gemini API
        const sent = JSON.parse(body);
        seen.push({ gemini: sent, url: req.url, key: req.headers['x-goog-api-key'] });
        if (mode === 'quota' && req.url.includes('/gemini-flash-latest:')) { // the free tier's daily limit of the larger model
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 20. Please retry in 12h31m27.9s.', status: 'RESOURCE_EXHAUSTED' } }));
          return;
        }
        if (mode === 'busy' && req.url.includes('/gemini-busy-model:')) { // Google's load: the model is overloaded
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand. Please try again later.', status: 'UNAVAILABLE' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        // 'recitation-page': the whole page is held back, a band of it (readInBands) is answered
        const band = sent.contents[0].parts.some((p) => /part \d+ of \d+/.test(p.text || ''));
        const held = mode === 'recitation' || (mode === 'recitation-page' && !band);
        const finishReason = held ? 'RECITATION' : 'STOP';
        const parts = held ? [] : [{ text: band ? `قطعة ${seen.length}` : ANSWER }];
        res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason }], usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 200 } }));
        return;
      }
      if (req.url === '/api/chat') { // Ollama
        const sent = JSON.parse(body);
        seen.push({ ollama: sent });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (sent.logprobs) { // line reading: every letter has a probability; ق is doubtful and could have been ف
          const text = lineAnswers.shift() || '';
          const logprobs = [...text].map((ch) => {
            const bytes = [...Buffer.from(ch)];
            const lp = ch === 'ق' ? Math.log(0.3) : Math.log(0.99);
            const top = [{ token: ch, logprob: lp, bytes }];
            if (ch === 'ق') top.push({ token: 'ف', logprob: Math.log(0.6), bytes: [...Buffer.from('ف')] });
            return { token: ch, logprob: lp, bytes, top_logprobs: top };
          });
          res.end(JSON.stringify({ message: { role: 'assistant', content: text }, logprobs, prompt_eval_count: 300, eval_count: logprobs.length }));
          return;
        }
        res.end(JSON.stringify({ message: { role: 'assistant', content: ANSWER }, prompt_eval_count: 900, eval_count: 120 }));
        return;
      }
      seen.push(JSON.parse(body));
      if (mode === 'unauthorized') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        return;
      }
      const message = {
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
        content: mode === 'refusal' ? [] : [{ type: 'text', text: mode === 'notext' ? '[[NO_TEXT]]' : ANSWER }],
        stop_reason: mode === 'refusal' ? 'refusal' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1234, output_tokens: 321 },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(message));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.VISION_PROVIDER = 'claude';
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  const { terminateOcr } = await import('../src/pipeline/ocr.js'); // the fallback test starts a Tesseract worker
  await terminateOcr();
});

test('transcription text becomes headings and paragraphs', async () => {
  const { parseTranscription } = await import('../src/pipeline/vision-ocr.js');
  const p = parseTranscription('```\n# عنوان\n\nسطر أول\nسطر ثان\n```');
  assert.deepEqual(p.paragraphs.map((x) => [x.text, x.heading]), [['عنوان', true], ['سطر أول سطر ثان', false]]);
  assert.equal(parseTranscription('[[NO_TEXT]]').noText, true);
});

test('AI reading is reported as available only when configured', async () => {
  const { visionStatus } = await import('../src/pipeline/vision-ocr.js');
  assert.equal(visionStatus().available, true);
  assert.equal(visionStatus().provider, 'claude');
  assert.equal(visionStatus().model, 'claude-opus-5-5');
});

test('the page image is sent to the model and the answer is parsed', async () => {
  const { readPageWithAi } = await import('../src/pipeline/vision-ocr.js');
  mode = 'ok';
  seen.length = 0;
  const jpeg = Buffer.from('/9j/4AAQSkZJRg==', 'base64'); // header bytes only: the mock does not decode it
  const r = await readPageWithAi(jpeg);
  assert.equal(r.paragraphs.length, 2);
  assert.equal(r.paragraphs[0].heading, true);
  const req = seen[0];
  assert.equal(req.model, 'claude-opus-5-5');
  const img = req.messages[0].content.find((b) => b.type === 'image');
  assert.equal(img.source.type, 'base64');
  assert.equal(img.source.media_type, 'image/jpeg');
  assert.match(req.system, /diacritic/i);
});

test('a refusal is surfaced so the caller can fall back', async () => {
  const { readPageWithAi } = await import('../src/pipeline/vision-ocr.js');
  mode = 'refusal';
  const r = await readPageWithAi(Buffer.from('x'));
  assert.equal(r.refused, true);
});

test('full page through the pipeline: AI text, then the Quran guard restores the verse with diacritics', { skip: !existsSync(fixture) }, async () => {
  const { openPdf } = await import('../src/pipeline/page-extract.js');
  const { processPage } = await import('../src/pipeline/process-page.js');
  const { runQuranGuard } = await import('../src/pipeline/convert-pdf.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p2w-ai-'));
  try {
    mode = 'ok';
    const doc = await openPdf(fixture);
    const opts = { mode: 'smart', ocr: 'auto', language: 'ar', engine: 'ai', highlightUncertain: true, defaultDir: 'rtl' };
    const page = await processPage(doc, 1, opts, dir);
    assert.equal(page.meta.method, 'ai');
    assert.equal(page.meta.aiTokens.input, 1234);
    assert.equal(page.model.flow, true);
    const summary = runQuranGuard([page], 'correct');
    assert.ok(summary.found >= 1, 'the verse inside the AI text must be detected');
    const text = page.model.blocks.map((b) => b.runs.map((r) => r.text).join('')).join(' ');
    // the source verse has no diacritics: it is verified and set apart, but no marks are added to it
    assert.ok(text.includes(String.fromCharCode(0xfd3f) + 'قل هو الله أحد'), 'verse bracketed, letters kept');
    const marks = new RegExp('[' + String.fromCharCode(0x64b) + '-' + String.fromCharCode(0x652) + ']');
    assert.ok(!marks.test(text), 'no diacritics added to a plain source');
    const verseRuns = page.model.blocks.flatMap((b) => b.runs).filter((r) => r.verse);
    assert.ok(verseRuns.length >= 1, 'the verse is marked so Word can print it heavier');
    assert.ok(text.includes('وهذا كلام عادي بعد الآية'), 'surrounding prose is untouched');

    // an API error must never lose the page: it falls back to the standard OCR
    mode = 'unauthorized';
    const fallback = await processPage(doc, 1, opts, dir);
    assert.notEqual(fallback.meta.method, 'ai');
    assert.ok(fallback.meta.warnings.some((w) => w.startsWith('ai-failed-used-standard-ocr')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('printMatch: a cover / title page is written as text in a box and the Word file has no picture at all', { skip: !existsSync(fixture) }, async () => {
  const { openPdf } = await import('../src/pipeline/page-extract.js');
  const { processPage } = await import('../src/pipeline/process-page.js');
  const { dropPictures } = await import('../src/pipeline/convert-pdf.js');
  const { buildDocx } = await import('../src/pipeline/docx-builder.js');
  const { default: JSZip } = await import('jszip');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p2w-card-'));
  try {
    mode = 'ok';
    const doc = await openPdf(fixture);
    const opts = { mode: 'smart', ocr: 'auto', language: 'ar', engine: 'ai', defaultDir: 'rtl', printMatch: true };
    const card = await processPage(doc, 1, { ...opts, asCard: true }, dir);
    assert.ok(card.meta.warnings.includes('front-matter-card'));
    const [box] = card.model.blocks;
    assert.equal(box.type, 'table');
    assert.ok(box.card);
    assert.ok(box.cells[0].paras.every((p) => p.align === 'center'));
    assert.ok(box.cells[0].paras.map((p) => p.runs.map((r) => r.text).join('')).join(' ').includes('الفصل الأول'));
    // a page of text: its header / footer (running title, page number) is read as text, never cut out as a picture
    const body = await processPage(doc, 1, opts, dir);
    assert.equal(body.meta.method, 'ai');
    assert.ok(body.model.blocks.every((b) => b.type !== 'image'));

    // a picture that is still there (an ornament, a page nothing could be read from) never reaches the Word file
    const pic = { model: { n: 2, width: 595, height: 842, margins: { top: 10, bottom: 10, left: 10, right: 10 }, method: 'image', blocks: [{ type: 'image', file: 'x.jpg', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }] }, meta: { n: 2, method: 'image', warnings: [] } };
    dropPictures([card, pic]);
    assert.equal(pic.model.blocks.length, 0);
    assert.equal(pic.meta.method, 'blank');
    assert.ok(pic.meta.warnings.includes('pictures-removed'));

    const buffer = await buildDocx([card.model, pic.model], { arabicFont: 'Traditional Arabic', latinFont: 'Times New Roman', pageDir: 'rtl', printMatch: true, detectHeadings: true });
    const zip = await JSZip.loadAsync(buffer);
    assert.equal(Object.keys(zip.files).filter((f) => f.startsWith('word/media/')).length, 0, 'no picture in the Word file');
    const xml = await zip.file('word/document.xml').async('string');
    assert.ok(xml.includes('<w:tbl>'), 'the cover text is inside a table');
    assert.ok(xml.includes('الفصل الأول'));
    assert.ok(!xml.includes('w:pStyle'), 'the cover title is not a heading of the book');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the free local provider (Ollama) sends the image and returns the same structure', async () => {
  const { readPageWithAi, visionStatus } = await import('../src/pipeline/vision-ocr.js');
  const saved = { p: process.env.VISION_PROVIDER, m: process.env.VISION_MODEL, u: process.env.OLLAMA_URL };
  process.env.VISION_PROVIDER = 'ollama';
  process.env.VISION_MODEL = 'qwen2.5vl:7b';
  process.env.OLLAMA_URL = process.env.ANTHROPIC_BASE_URL;
  process.env.VISION_MODE = 'page';
  try {
    assert.equal(visionStatus().external, false, 'a local model must not be reported as an external service');
    seen.length = 0;
    const r = await readPageWithAi(Buffer.from('/9j/4AAQSkZJRg==', 'base64'));
    assert.equal(r.paragraphs.length, 2);
    assert.equal(r.usage.output_tokens, 120);
    const sent = seen[0].ollama;
    assert.equal(sent.model, 'qwen2.5vl:7b');
    assert.equal(sent.stream, false);
    assert.equal(sent.messages[1].images.length, 1);
  } finally {
    delete process.env.VISION_MODE;
    for (const [k, v] of [['VISION_PROVIDER', saved.p], ['VISION_MODEL', saved.m], ['OLLAMA_URL', saved.u]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('a local model reads the page line by line and says which words it is unsure about', async () => {
  const sharp = (await import('sharp')).default;
  const { readPageWithAi } = await import('../src/pipeline/vision-ocr.js');
  const saved = { p: process.env.VISION_PROVIDER, m: process.env.VISION_MODEL, u: process.env.OLLAMA_URL };
  process.env.VISION_PROVIDER = 'ollama';
  process.env.VISION_MODEL = 'qwen2.5vl:7b';
  process.env.OLLAMA_URL = process.env.ANTHROPIC_BASE_URL;
  process.env.VISION_LINE_PARALLEL = '1'; // answers are queued in order
  try {
    // a page body with two text-like bars: a full line and a shorter one that starts a new paragraph
    const w = 800, h = 300;
    const px = Buffer.alloc(w * h, 255);
    const bar = (y0, y1, x0, x1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[y * w + x] = 0; };
    bar(40, 90, 100, 700);
    bar(160, 210, 100, 500);
    const jpeg = await sharp(px, { raw: { width: w, height: h, channels: 1 } }).jpeg({ quality: 95 }).toBuffer();
    lineAnswers.length = 0;
    lineAnswers.push('وقد جاء زيد', 'ثم ذهب');
    seen.length = 0;
    const r = await readPageWithAi(jpeg, { probs: true }); // probabilities: the "highlight uncertain words" option
    assert.equal(r.mode, 'lines');
    assert.equal(seen.length, 2, 'one request per line');
    assert.equal(seen[0].ollama.logprobs, true);
    assert.equal(r.paragraphs.length, 2, 'the shorter second line starts a paragraph');
    const first = r.paragraphs[0];
    assert.equal(first.text, 'وقد جاء زيد');
    const doubtful = first.runs.find((x) => x.lowConf);
    assert.equal(doubtful.text, 'وقد');
    assert.deepEqual(doubtful.alts, ['وفد'], 'the other possible spelling is offered, not applied');
    assert.ok(first.runs.some((x) => !x.lowConf && x.text.includes('جاء')));
  } finally {
    delete process.env.VISION_LINE_PARALLEL;
    for (const [k, v] of [['VISION_PROVIDER', saved.p], ['VISION_MODEL', saved.m], ['OLLAMA_URL', saved.u]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('Gemini reads the whole page through the official SDK; a held-back answer is a refusal', async () => {
  const { readPageWithAi, visionStatus } = await import('../src/pipeline/vision-ocr.js');
  const saved = { p: process.env.VISION_PROVIDER, k: process.env.GEMINI_API_KEY, u: process.env.GEMINI_BASE_URL };
  process.env.VISION_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'gemini-test-key';
  process.env.GEMINI_BASE_URL = process.env.ANTHROPIC_BASE_URL;
  try {
    assert.deepEqual(visionStatus(), { available: true, provider: 'gemini', model: 'gemini-flash-latest', external: true });
    mode = 'ok';
    seen.length = 0;
    const r = await readPageWithAi(Buffer.from('/9j/4AAQSkZJRg==', 'base64'));
    assert.equal(r.paragraphs.length, 2);
    assert.equal(r.paragraphs[0].heading, true);
    assert.equal(r.usage.input_tokens, 1500);
    assert.equal(seen.length, 1, 'one request for the whole page, not one per line');
    const { gemini: sent, url, key } = seen[0];
    assert.match(url, /models\/gemini-flash-latest:generateContent/);
    assert.equal(key, 'gemini-test-key');
    const img = sent.contents[0].parts.find((p) => p.inlineData);
    assert.equal(img.inlineData.mimeType, 'image/jpeg');
    assert.match(JSON.stringify(sent.systemInstruction), /diacritic/i);
    assert.match(JSON.stringify(sent.systemInstruction), /never reverse/i);
    assert.equal(sent.generationConfig.temperature, 0);
    assert.equal(sent.generationConfig.thinkingConfig.thinkingBudget, 0);

    mode = 'recitation';
    assert.equal((await readPageWithAi(Buffer.from('x'))).refused, true);

    // the daily quota is used up: no retries on that model, Flash-Lite reads the page, and the model is not asked again
    mode = 'quota';
    seen.length = 0;
    const q = await readPageWithAi(Buffer.from('/9j/4AAQSkZJRg==', 'base64'));
    assert.equal(q.paragraphs.length, 2);
    assert.equal(q.model, 'gemini-flash-lite-latest');
    assert.deepEqual(seen.map((s) => s.url.match(/models\/([^:]+):/)[1]), ['gemini-flash-latest', 'gemini-flash-lite-latest']);
    assert.ok(!seen[1].gemini.generationConfig.thinkingConfig.thinkingBudget, 'Flash-Lite does not take thinkingBudget 0');
    seen.length = 0;
    await readPageWithAi(Buffer.from('/9j/4AAQSkZJRg==', 'base64'));
    assert.equal(seen.length, 1, 'the used-up model is skipped');
  } finally {
    mode = 'ok';
    for (const [k, v] of [['VISION_PROVIDER', saved.p], ['GEMINI_API_KEY', saved.k], ['GEMINI_BASE_URL', saved.u]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('the wait Google asks for after a 429 is read from its message', async () => {
  const { geminiRetryMs } = await import('../src/pipeline/vision-ocr.js');
  assert.equal(geminiRetryMs('Please retry in 12h31m27.9s.'), (12 * 3600 + 31 * 60 + 27.9) * 1000);
  assert.equal(geminiRetryMs('Please retry in 41.2s.'), 41_200);
  assert.equal(geminiRetryMs('{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay": "45s"}'), 45_000);
  assert.equal(geminiRetryMs('quota exceeded'), null);
});

test('LOCAL_AI=1 switches to the local reader and turns the cloud provider off', async () => {
  const { visionStatus } = await import('../src/pipeline/vision-ocr.js');
  const saved = process.env.VISION_PROVIDER;
  process.env.VISION_PROVIDER = 'gemini';
  try {
    process.env.LOCAL_AI = '1';
    assert.equal(visionStatus().provider, 'llamacpp');
    assert.equal(visionStatus().external, false);
    process.env.LOCAL_AI_PROVIDER = 'ollama';
    assert.equal(visionStatus().provider, 'ollama');
    process.env.LOCAL_AI_PROVIDER = 'claude'; // not a local reader: nothing is used rather than the cloud
    assert.equal(visionStatus().available, false);
    process.env.LOCAL_AI = '0';
    assert.equal(visionStatus().provider, 'gemini');
  } finally {
    delete process.env.LOCAL_AI;
    delete process.env.LOCAL_AI_PROVIDER;
    process.env.VISION_PROVIDER = saved;
  }
});

test('the Qari-OCR provider (llama.cpp server) reads a page and a line with probabilities', async () => {
  const sharp = (await import('sharp')).default;
  const { readPageWithAi, visionStatus } = await import('../src/pipeline/vision-ocr.js');
  const saved = { p: process.env.VISION_PROVIDER, u: process.env.LLAMA_URL };
  process.env.VISION_PROVIDER = 'llamacpp';
  process.env.LLAMA_URL = process.env.ANTHROPIC_BASE_URL;
  process.env.VISION_LINE_PARALLEL = '1';
  try {
    assert.equal(visionStatus().available, true);
    assert.equal(visionStatus().external, false, 'local, nothing leaves the machine');
    seen.length = 0;
    process.env.VISION_MODE = 'page';
    const page = await readPageWithAi(Buffer.from('/9j/4AAQSkZJRg==', 'base64'));
    assert.equal(page.paragraphs.length, 2);
    const img = seen[0].llama.messages[0].content;
    assert.equal(img[0].type, 'image_url');
    assert.match(img[1].text, /plain text representation/, 'the instruction Qari was trained with');
    delete process.env.VISION_MODE;

    const w = 800, h = 200;
    const px = Buffer.alloc(w * h, 255);
    for (let y = 60; y < 110; y++) for (let x = 100; x < 700; x++) px[y * w + x] = 0;
    const jpeg = await sharp(px, { raw: { width: w, height: h, channels: 1 } }).jpeg({ quality: 95 }).toBuffer();
    lineAnswers.length = 0;
    lineAnswers.push('وقد جاء');
    const r = await readPageWithAi(jpeg, { probs: true });
    assert.equal(r.mode, 'lines');
    const doubtful = r.paragraphs[0].runs.find((x) => x.lowConf);
    assert.equal(doubtful.text, 'وقد');
    assert.deepEqual(doubtful.alts, ['وفد']);
  } finally {
    delete process.env.VISION_MODE;
    delete process.env.VISION_LINE_PARALLEL;
    for (const [k, v] of [['VISION_PROVIDER', saved.p], ['LLAMA_URL', saved.u]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('a calligraphic basmala the reader got wrong is written in full; a real phrase after "بسم الله" is kept', async () => {
  const { fixBasmala } = await import('../src/pipeline/vision-ocr.js');
  const fix = (text) => fixBasmala([{ text, heading: false, runs: [{ text, lowConf: true }] }])[0];
  const p = fix('بِسَمِّ اللهِ لِكَمِّ الْجَبَّةِ');
  assert.equal(p.text, 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ');
  assert.deepEqual(p.runs, [{ text: p.text, lowConf: false }]);
  assert.equal(fix('بسم الله الرحمن').text, 'بسم الله الرحمن الرحيم', 'a plain reading stays plain');
  for (const kept of ['بسم الله وبه نستعين', 'بسم الله الحمد لله', 'بسم الله لكم الحبة وكان الناس كثيرا جدا في']) assert.equal(fix(kept).text, kept);
});

test('a basmala drawn in calligraphy and misread from its first word is written in full; short headings are not', async () => {
  const { fixBasmala } = await import('../src/pipeline/vision-ocr.js');
  const fix = (text) => fixBasmala([{ text }])[0].text;
  assert.equal(fix('بِشَمَلَةٍ لِخَمَّالِ خَمَّتْكِ'), 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ');
  assert.equal(fix('لِشَمَلِ لِلَّذَا لِخَيَّلِ إِلَخَمَنِّي'), 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ');
  for (const kept of ['مقدمة المصحح', 'الحمد لله رب العالمين', 'باب ما جاء في البسملة', 'بسم الله والحمد لله']) assert.equal(fix(kept), kept);
});

/** Runs `fn` with the reader set to Gemini on the mock server, then puts the environment back. */
async function withGemini(fn, extra = {}) {
  const env = { VISION_PROVIDER: 'gemini', GEMINI_API_KEY: 'gemini-test-key', GEMINI_BASE_URL: process.env.ANTHROPIC_BASE_URL, ...extra };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    await fn();
  } finally {
    mode = 'ok';
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A page image of `lines` text lines (word-like blobs), decodable, so it can be cut into bands. */
async function linedPage(lines = 12) {
  const { default: sharp } = await import('sharp');
  const w = 800;
  const h = 100 + lines * 90;
  const px = new Uint8Array(w * h).fill(255);
  for (let l = 0; l < lines; l++) for (let y = 60 + l * 90; y < 100 + l * 90; y++) for (let x = 60; x < 740; x++) if (x % 37 < 28) px[y * w + x] = 20;
  return sharp(Buffer.from(px), { raw: { width: w, height: h, channels: 1 } }).jpeg({ quality: 92 }).toBuffer();
}

test('Gemini page reads send the safety settings and the media resolution; line reads keep the default resolution', async () => {
  const { readPageWithAi, readLineImage } = await import('../src/pipeline/vision-ocr.js');
  await withGemini(async () => {
    seen.length = 0;
    await readPageWithAi(Buffer.from('/9j/4AAQSkZJRg==', 'base64'));
    const sent = seen[0].gemini;
    assert.equal(sent.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_HIGH');
    assert.ok(sent.safetySettings.every((s) => s.threshold === 'BLOCK_NONE'));
    assert.equal(sent.safetySettings.length, 4);
    assert.match(JSON.stringify(sent.systemInstruction), /never continue or complete it from memory/);
    seen.length = 0;
    await readLineImage(new Uint8Array(200 * 40).fill(255), 200, 40);
    assert.equal(seen[0].gemini.generationConfig.mediaResolution, undefined);
  });
});

test('a page Gemini holds back as recitation is read again in bands', async () => {
  const { readPageWithAi } = await import('../src/pipeline/vision-ocr.js');
  await withGemini(async () => {
    mode = 'recitation-page';
    seen.length = 0;
    const r = await readPageWithAi(await linedPage(12));
    assert.equal(r.refused, undefined);
    assert.equal(r.via, 'gemini-bands');
    assert.deepEqual(r.tried, ['gemini:RECITATION']);
    assert.equal(r.bands, 2);
    assert.equal(seen.length, 3, 'the page, then its two bands');
    // a paragraph cut by the band boundary is one paragraph
    assert.deepEqual(r.paragraphs.map((p) => p.text), ['قطعة 2 قطعة 3']);
  });
});

test('an overloaded model (503) is asked again after a pause, then the next model reads the page', async () => {
  const { readPageWithAi, geminiTransient } = await import('../src/pipeline/vision-ocr.js');
  await withGemini(async () => {
    mode = 'busy';
    seen.length = 0;
    const r = await readPageWithAi(Buffer.from('/9j/4AAQSkZJRg==', 'base64'));
    assert.equal(r.paragraphs.length, 2);
    assert.equal(r.model, 'gemini-flash-lite-latest');
    const asked = seen.map((s) => s.url.match(/models\/([^:]+):/)[1]);
    assert.ok(asked.filter((m) => m === 'gemini-busy-model').length >= 3, 'the busy model is tried more than once');
    assert.equal(asked.at(-1), 'gemini-flash-lite-latest');
  }, { GEMINI_MODEL: 'gemini-busy-model', GEMINI_RETRY_PAUSE_MS: '20' });
  assert.equal(geminiTransient({ status: 503 }), true);
  assert.equal(geminiTransient({ status: 504 }), true);
  assert.equal(geminiTransient({ status: 400 }), false);
  assert.equal(geminiTransient(new Error('fetch failed')), true);
  assert.equal(geminiTransient(new Error('bad request body')), false);
});

test('VISION_FALLBACK=claude reads a page Gemini declined', async () => {
  const { readPageWithAi } = await import('../src/pipeline/vision-ocr.js');
  await withGemini(async () => {
    mode = 'recitation';
    seen.length = 0;
    const r = await readPageWithAi(Buffer.from('x'));
    assert.equal(r.via, 'claude');
    assert.equal(r.paragraphs.length, 2);
    assert.equal(seen.at(-1).model, 'claude-haiku-5-5');
    assert.ok(r.tried[0].startsWith('gemini:RECITATION'));
  }, { VISION_FALLBACK: 'claude' });
});

test('batch mode: pass 1 queues the read, pass 2 takes the answer without a request', async () => {
  const { readPageWithAi } = await import('../src/pipeline/vision-ocr.js');
  const { readdirSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p2w-batch-'));
  try {
    await withGemini(async () => {
      const jpeg = Buffer.from('/9j/4AAQSkZJRg==', 'base64');
      seen.length = 0;
      await assert.rejects(readPageWithAi(jpeg, { batch: { dir, collect: true } }), (err) => err.deferred === true);
      assert.equal(seen.length, 0, 'nothing is sent in pass 1');
      const [file] = readdirSync(path.join(dir, 'requests'));
      const { key, request } = JSON.parse(readFileSync(path.join(dir, 'requests', file), 'utf8'));
      assert.equal(request.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_HIGH');
      assert.match(request.systemInstruction.parts[0].text, /diacritic/);
      // what runBatch stores from Google's answer file
      mkdirSync(path.join(dir, 'answers'));
      writeFileSync(path.join(dir, 'answers', `${key}.json`), JSON.stringify({ candidates: [{ content: { parts: [{ text: ANSWER }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1700, candidatesTokenCount: 200 } }));
      const r = await readPageWithAi(jpeg, { batch: { dir } });
      assert.equal(seen.length, 0, 'the answer came from the batch');
      assert.equal(r.paragraphs.length, 2);
      assert.equal(r.usage.input_tokens, 1700);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runBatch sends the queued requests as one job, stores the answers, and resumes a job already sent', async () => {
  const { runBatch, queueRequest, batchAnswer } = await import('../src/pipeline/gemini-batch.js');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p2w-batch-'));
  try {
    await queueRequest(dir, 'a', { contents: [] });
    await queueRequest(dir, 'b', { contents: [] });
    let polls = 0;
    let created = 0;
    let lines = 0;
    const ai = {
      files: {
        upload: async ({ file }) => { lines = readFileSync(file, 'utf8').trim().split('\n').length; return { name: 'files/in' }; },
        download: async ({ downloadPath }) => writeFileSync(downloadPath, `${JSON.stringify({ key: 'a', response: { candidates: [] } })}\n${JSON.stringify({ key: 'b', error: { code: 500 } })}\n`),
        delete: async () => {},
      },
      batches: {
        create: async () => { created++; return { name: 'batches/1' }; },
        get: async () => (++polls < 2 ? { state: 'JOB_STATE_RUNNING' } : { state: 'JOB_STATE_SUCCEEDED', dest: { fileName: 'files/out' } }),
        cancel: async () => {},
      },
    };
    assert.deepEqual(await runBatch(ai, dir, 'gemini-flash-latest', { pollMs: 1 }), { state: 'JOB_STATE_SUCCEEDED', sent: 2, answered: 1, failed: 1 });
    assert.equal(lines, 2);
    assert.ok(await batchAnswer(dir, 'a'));
    assert.equal(await batchAnswer(dir, 'b'), null, 'a request the batch failed is read live');
    await runBatch(ai, dir, 'gemini-flash-latest', { pollMs: 1 });
    assert.equal(created, 1, 'a restart does not send the batch again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a word the reader could not read is highlighted', async () => {
  const { markIllegible, ILLEGIBLE } = await import('../src/pipeline/vision-ocr.js');
  const p = markIllegible({ text: `قال ${ILLEGIBLE} بن عمر`, heading: false });
  assert.deepEqual(p.runs, [{ text: 'قال ', lowConf: false }, { text: ILLEGIBLE, lowConf: true }, { text: ' بن عمر', lowConf: false }]);
  assert.equal(markIllegible({ text: 'سطر' }).runs, undefined);
});

test('a page read whole: the notes under the rule become footnotes, one per note', async () => {
  const { markFootnotes, parseTranscription } = await import('../src/pipeline/vision-ocr.js');
  const kinds = (ps) => ps.map((p) => [p.text.slice(0, 12), !!p.footnote]);
  // the reader wrote the "---" line it was asked for
  const asked = markFootnotes(parseTranscription('# مقدمة\n\nوتوسلاً بمحمد (١) المجتبى.\n\n---\n\n(١) التوسل هو التقرب.\n\n(٢) حديث أول ما كتب.').paragraphs);
  assert.deepEqual(kinds(asked), [['مقدمة', false], ['وتوسلاً بمحم', false], ['(١) التوسل ه', true], ['(٢) حديث أول', true]]);
  // no "---", two notes joined into one paragraph (page 10 of the book): the rule on the page marks them, the numbers split them
  const joined = markFootnotes([{ text: 'المتن (١) والمتن (٢).' }, { text: '(۱) التوسل هو التقرب للمتوسل. (۲) حديث «أول ما كتب القلم.. إلخ» ذكره.' }], { rule: true });
  assert.deepEqual(joined.map((p) => [p.text, !!p.footnote]), [
    ['المتن (١) والمتن (٢).', false], ['(۱) التوسل هو التقرب للمتوسل.', true], ['(۲) حديث «أول ما كتب القلم.. إلخ» ذكره.', true],
  ]);
  // a note carried over from the page before ("=") is a footnote too; a list in the text above the notes is not
  const list = markFootnotes([{ text: 'وهي:' }, { text: '(٣) الثالث.' }, { text: '(٤) الرابع.' }, { text: '= تتمة الهامش.' }, { text: '(١) هامش.' }], { rule: true });
  assert.deepEqual(kinds(list).map((k) => k[1]), [false, false, false, true, true]);
  // no rule on the page and no "---": numbered paragraphs stay text
  assert.ok(markFootnotes([{ text: 'المتن' }, { text: '(١) أولاً.' }]).every((p) => !p.footnote));
  // a "---" with text after it but no rule and no note number is an ornament, dropped
  assert.deepEqual(markFootnotes([{ text: 'أ' }, { text: '-----' }, { text: 'ب' }]).map((p) => p.text), ['أ', 'ب']);
});

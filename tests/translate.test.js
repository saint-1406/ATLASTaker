import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { androidEngine, browserEngine, directionOf, joinPieces, modelEngine, modelPaths, ortPaths, otherWay, pickEngine, splitText, translateWith } from '../src/translate.js';
import { createTranslateFiles, upstreamFor } from '../server/translate.js';

test('the direction follows the alphabet: Cyrillic goes to English, Latin to Russian', () => {
  assert.deepEqual(directionOf('Привет, мир'), { from: 'ru', to: 'en' });
  assert.deepEqual(directionOf('Hello, world'), { from: 'en', to: 'ru' });
  assert.deepEqual(directionOf('Это API для PDF и EPUB-файлов'), { from: 'ru', to: 'en' }, 'Latin names inside Russian text');
  assert.deepEqual(directionOf('The word «мир» means peace'), { from: 'en', to: 'ru' });
  assert.equal(directionOf('123 — 456!'), null);
  assert.deepEqual(otherWay({ from: 'ru', to: 'en' }), { from: 'en', to: 'ru' });
});

test('a passage is cut into paragraphs and sentences, and comes back with its line breaks', () => {
  assert.deepEqual(splitText('One. Two.'), [{ text: 'One. Two.', gap: '' }]);
  const pieces = splitText('First paragraph.\n\nSecond one.\nThird.\n');
  assert.deepEqual(pieces.map((p) => p.text), ['First paragraph.', 'Second one.', 'Third.']);
  assert.equal(joinPieces(pieces, ['Первый абзац.', 'Второй.', 'Третий.']), 'Первый абзац.\n\nВторой.\nТретий.');
  assert.deepEqual(splitText('   \n\n  '), []);
});

test('a long paragraph is cut after sentences, an endless sentence at spaces', () => {
  const sentence = 'Word '.repeat(30).trim() + '.';
  const paragraph = `${sentence} ${sentence} ${sentence}`;
  const pieces = splitText(paragraph, 200);
  assert.ok(pieces.length >= 2);
  assert.ok(pieces.every((p) => p.text.length <= 200));
  assert.equal(pieces.map((p) => p.text + p.gap).join(''), paragraph);
  const endless = 'слово '.repeat(200).trim();
  const cut = splitText(endless, 100);
  assert.ok(cut.every((p) => p.text.length <= 100));
  assert.equal(cut.map((p) => p.text).join(' '), endless);
});

test('Android: ML Kit is asked through the bridge and answers through receive()', async () => {
  const calls = [];
  const android = {
    translateState: (from, to) => (from === 'ru' ? 'ready' : 'download'),
    translatePrepare: (id, from, to) => calls.push(['prepare', id, from, to]),
    translate: (id, from, to, json) => calls.push(['translate', id, from, to, JSON.parse(json)]),
  };
  const engine = androidEngine(android);
  assert.equal(await engine.state('ru-en'), 'ready');
  assert.equal(await engine.state('en-ru'), 'download');
  const done = engine.translate('ru-en', ['Привет']);
  const [, id] = calls.at(-1);
  engine.receive({ id: 'nobody', ok: true, texts: ['x'] }); // an answer to nothing is dropped
  engine.receive({ id, ok: true, texts: ['Hello'] });
  assert.deepEqual(await done, ['Hello']);
  const failing = engine.prepare('en-ru');
  engine.receive({ id: calls.at(-1)[1], ok: false, code: 'download' });
  await assert.rejects(failing, (err) => err.code === 'download');
});

test('the browser translator: availability becomes ready / download / unavailable', async () => {
  assert.equal(browserEngine(undefined), null);
  const made = [];
  const Translator = {
    availability: async ({ sourceLanguage }) => ({ ru: 'available', en: 'downloadable' })[sourceLanguage] ?? 'unavailable',
    create: async (options) => {
      made.push(options.sourceLanguage);
      return { translate: async (text) => `[${options.targetLanguage}] ${text}` };
    },
  };
  const engine = browserEngine(Translator);
  assert.equal(await engine.state('ru-en'), 'ready');
  assert.equal(await engine.state('en-ru'), 'download');
  assert.equal(await translateWith(engine, 'ru-en', 'Один.\n\nДва.'), '[en] Один.\n\n[en] Два.');
  assert.deepEqual(made, ['ru'], 'one translator per direction');
  let asked = 0;
  const silent = browserEngine({ availability: () => (asked++, new Promise(() => {})), create: async () => ({}) }, { wait: 20 });
  assert.equal(await silent.state('ru-en'), 'unavailable', 'a browser that never answers is passed over');
  assert.equal(await silent.state('en-ru'), 'unavailable');
  assert.equal(asked, 1, 'and not asked again');
});

test('the model engine downloads only what is missing, with progress, then translates', async () => {
  const have = new Set();
  const translateApi = {
    status: async (paths) => ({ missing: paths.filter((p) => !have.has(p)), sizes: Object.fromEntries(paths.map((p) => [p, 100])) }),
    download: async (p, onBytes) => {
      onBytes(50);
      onBytes(100);
      have.add(p);
    },
  };
  const code = { ortVersion: '1.2.3', load: async () => async (text) => text.toUpperCase() };
  const engine = modelEngine({ translateApi, loadModelCode: async () => code });
  assert.equal(await engine.state('en-ru'), 'download');
  const progress = [];
  await engine.prepare('en-ru', (share) => progress.push(share));
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]), 'progress only grows');
  assert.equal(have.size, modelPaths('en-ru').length + ortPaths('1.2.3').length);
  assert.equal(await engine.state('en-ru'), 'ready');
  assert.equal(await translateWith(engine, 'en-ru', 'hi'), 'HI');
});

test('the first engine that knows the pair is picked', async () => {
  const none = { state: async () => 'unavailable' };
  const some = { state: async () => 'download' };
  assert.deepEqual(await pickEngine([null, none, some], 'ru-en'), { engine: some, state: 'download' });
  assert.equal(await pickEngine([none], 'ru-en'), null);
});

test('the server lets through only the translator’s own files', () => {
  assert.equal(upstreamFor('hf/Xenova/opus-mt-ru-en/config.json'), 'https://huggingface.co/Xenova/opus-mt-ru-en/resolve/main/config.json');
  assert.equal(
    upstreamFor('hf/Xenova/opus-mt-en-ru/onnx/decoder_model_merged_quantized.onnx'),
    'https://huggingface.co/Xenova/opus-mt-en-ru/resolve/main/onnx/decoder_model_merged_quantized.onnx',
  );
  assert.equal(
    upstreamFor('ort/1.31.0-dev.20260914-8d85527a0/ort-wasm-simd-threaded.asyncify.wasm'),
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.wasm',
  );
  for (const bad of ['hf/Xenova/opus-mt-de-en/config.json', 'hf/Xenova/opus-mt-ru-en/../../x', 'hf/Xenova/opus-mt-ru-en/onnx/decoder_model.onnx', 'ort/../x/ort-wasm-simd-threaded.asyncify.wasm', 'ort/1.2.3/evil.mjs', '']) {
    assert.equal(upstreamFor(bad), null, bad);
  }
  for (const p of [...modelPaths('ru-en'), ...modelPaths('en-ru'), ...ortPaths('1.31.0')]) assert.ok(upstreamFor(p), p);
});

/** A response stand-in that keeps what is written to it. */
function sink() {
  const chunks = [];
  const out = new Writable({
    write(chunk, _enc, done) {
      chunks.push(chunk);
      done();
    },
  });
  out.writeHead = (status, headers) => Object.assign(out, { status, headers });
  out.text = () => Buffer.concat(chunks).toString('utf8');
  return out;
}

test('a file is downloaded once into the data folder, streamed while it comes, then served from disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-translate-'));
  let fetched = 0;
  const fetchImpl = async (url, { method } = {}) => {
    if (method === 'HEAD') return new Response(null, { headers: { 'content-length': '7' } });
    fetched++;
    return new Response('{"a":1}', { headers: { 'content-length': '7' } });
  };
  try {
    const files = createTranslateFiles(dir, { fetchImpl });
    const rel = 'hf/Xenova/opus-mt-ru-en/config.json';
    assert.deepEqual(await files.status([rel, 'nope']), { missing: [rel], sizes: { [rel]: 7 } });
    const first = sink();
    await files.download(rel, first);
    await new Promise((resolve) => (first.writableFinished ? resolve() : first.on('finish', resolve)));
    assert.equal(first.text(), '{"a":1}');
    assert.equal(fs.readFileSync(path.join(dir, 'translate', 'hf', 'Xenova', 'opus-mt-ru-en', 'config.json'), 'utf8'), '{"a":1}');
    assert.deepEqual(await files.status([rel]), { missing: [], sizes: {} });
    const second = sink();
    await files.download(rel, second);
    assert.equal(second.text(), '{"a":1}');
    assert.equal(fetched, 1);
    await assert.rejects(files.download('hf/other/config.json', sink()), (err) => err.status === 404);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed download leaves nothing half-written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-translate-'));
  try {
    const files = createTranslateFiles(dir, { fetchImpl: async () => new Response('gone', { status: 404 }) });
    const rel = 'hf/Xenova/opus-mt-en-ru/tokenizer.json';
    await assert.rejects(files.download(rel, sink()), (err) => err.status === 502);
    assert.equal(await files.sizeOf(rel), 0);
    assert.equal(fs.existsSync(path.join(dir, 'translate', 'hf', 'Xenova', 'opus-mt-en-ru', 'tokenizer.json.part')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

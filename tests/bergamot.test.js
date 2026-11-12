import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import { BERGAMOT_CDN, BERGAMOT_FILES, BERGAMOT_WASM, bergamotModel, bergamotPaths, bergamotUpstream } from '../src/bergamotFiles.js';
import { androidFiles, bergamotEngine } from '../src/bergamot.js';
import { pickEngine } from '../src/translate.js';
import { createTranslateFiles, upstreamFor } from '../server/translate.js';

test('each direction has the WebAssembly and its model, lex and vocabulary', () => {
  for (const pair of ['ru-en', 'en-ru']) {
    const model = bergamotModel(pair);
    assert.ok(model.model.endsWith('.bin') && model.lex.includes('/lex.') && model.vocab.endsWith('.spm'), pair);
    assert.deepEqual(bergamotPaths(pair), [BERGAMOT_WASM, model.model, model.lex, model.vocab]);
  }
  assert.equal(bergamotModel('de-en'), null);
  assert.deepEqual(bergamotPaths('de-en'), []);
  for (const [rel, file] of Object.entries(BERGAMOT_FILES)) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/, rel);
    assert.ok(file.size > 100_000, rel);
    assert.equal(bergamotUpstream(rel), BERGAMOT_CDN + file.at);
    assert.equal(upstreamFor(rel), BERGAMOT_CDN + file.at, 'the server lets it through');
  }
  assert.equal(bergamotUpstream('bergamot/ru-en/2.1/other.bin'), null);
  assert.equal(upstreamFor('bergamot/../../secret'), null);
});

test('the Android app downloads exactly the same files (TranslateFiles.java)', () => {
  const java = fs.readFileSync(new URL('../android/app/src/main/java/io/github/saint1406/atlastaker/TranslateFiles.java', import.meta.url), 'utf8');
  const table = {};
  for (const [, rel, at, size, sha256] of java.matchAll(/files\.put\("([^"]+)", new String\[\] \{\s*"([^"]+)", "(\d+)",\s*"([0-9a-f]{64})"\}\);/g)) {
    table[rel] = { at, size: Number(size), sha256 };
  }
  assert.deepEqual(table, BERGAMOT_FILES);
  assert.ok(java.includes(`"${BERGAMOT_CDN}"`), 'and from the same place');
});

/** A response stand-in that keeps what is written to it. */
function sink() {
  const out = new Writable({ write: (_chunk, _enc, done) => done() });
  out.writeHead = () => out;
  return out;
}

test('the server keeps a model file only if it is the very one Firefox gets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bergamot-'));
  const rel = 'bergamot/en-ru/2.1/vocab.enru.spm';
  const target = path.join(dir, 'translate', ...rel.split('/'));
  try {
    const wrong = createTranslateFiles(dir, { fetchImpl: async () => new Response('not the vocabulary') });
    assert.deepEqual(await wrong.status([rel]), { missing: [rel], sizes: { [rel]: BERGAMOT_FILES[rel].size } }, 'its size is known without asking');
    await assert.rejects(wrong.download(rel, sink()), /checksum/);
    assert.ok(!fs.existsSync(target) && !fs.existsSync(`${target}.part`), 'nothing kept');

    // with the right bytes (a stand-in whose hash the table is told) it is kept
    const bytes = Buffer.from('the vocabulary');
    const saved = { ...BERGAMOT_FILES[rel] };
    BERGAMOT_FILES[rel].sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    try {
      const right = createTranslateFiles(dir, { fetchImpl: async () => new Response(bytes) });
      await right.download(rel, sink());
      assert.equal(fs.readFileSync(target, 'utf8'), 'the vocabulary');
    } finally {
      Object.assign(BERGAMOT_FILES[rel], saved);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the offline engine wants a download until its files are here, and says how far it got', async () => {
  const have = new Set();
  const files = {
    status: async (paths) => ({ missing: paths.filter((p) => !have.has(p)), sizes: {} }),
    download: async (rel, onBytes) => {
      onBytes(BERGAMOT_FILES[rel].size / 2);
      onBytes(BERGAMOT_FILES[rel].size);
      have.add(rel);
    },
  };
  const engine = bergamotEngine({ files, base: 'http://x/translate-files/', workerUrl: 'http://x/w.js' });
  assert.equal(await engine.state('ru-en'), 'download');
  assert.equal(await engine.state('de-en'), 'unavailable');
  const progress = [];
  await engine.prepare('ru-en', (share) => progress.push(share));
  assert.equal(await engine.state('ru-en'), 'ready');
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]), 'progress only grows');
  // the other direction shares the WebAssembly: only its model is left
  assert.equal((await files.status(bergamotPaths('en-ru'))).missing.length, 3);
});

test('Android’s downloads answer through the page’s translate events', async () => {
  const calls = [];
  const android = {
    translateFilesStatus: (json) => JSON.stringify({ missing: JSON.parse(json).slice(1) }),
    translateFileDownload: (id, rel) => calls.push({ id, rel }),
  };
  const files = androidFiles(android);
  assert.deepEqual((await files.status(['a', 'b'])).missing, ['b']);
  const seen = [];
  const done = files.download('b', (bytes) => seen.push(bytes));
  const { id } = calls[0];
  assert.equal(files.receive({ id, done: 10, total: 20 }), true);
  assert.equal(files.receive({ id, ok: true }), true);
  await done;
  assert.deepEqual(seen, [10]);
  assert.equal(files.receive({ id: '1', ok: true }), false, 'ML Kit’s answers are not its own');
  const failed = files.download('c');
  assert.equal(files.receive({ id: calls[1].id, ok: false, code: 'download' }), true);
  await assert.rejects(failed, (err) => err.code === 'download');
});

test('an engine ready on the device comes before one that would need a download', async () => {
  const later = { state: async () => 'download' };
  const ready = { state: async () => 'ready' };
  const none = { state: async () => 'unavailable' };
  assert.deepEqual(await pickEngine([later, none, ready], 'ru-en'), { engine: ready, state: 'ready' });
  assert.deepEqual(await pickEngine([none, later], 'ru-en'), { engine: later, state: 'download' });
});

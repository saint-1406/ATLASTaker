// Apocrypha on the device: the checks before sharing (src/apocrypha/checks.js) and the client that
// talks to Drive and the catalogue (src/apocrypha/client.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFile, detectLanguage, formatSize, kindOf, languageOf, MAX_SHARE, normalizeLang, sha256Hex, ShareCheckError } from '../src/apocrypha/checks.js';
import { ApocryphaError, createApocrypha } from '../src/apocrypha/client.js';
import { detectFormat } from '../src/reader/formats.js';

const enc = (s) => new TextEncoder().encode(s);

test('apocrypha checks: the format by the bytes, not the name', () => {
  assert.equal(checkFile('book.txt', enc('%PDF-1.7 …'), detectFormat), 'pdf');
  assert.equal(checkFile('notes.md', enc('# Заголовок\n\nтекст'), detectFormat), 'md');
  assert.throws(() => checkFile('old.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), detectFormat), (e) => e instanceof ShareCheckError && e.code === 'format');
  assert.throws(() => checkFile('x.pdf', new Uint8Array(), detectFormat), (e) => e.code === 'empty');
  const big = { length: MAX_SHARE + 1 };
  assert.throws(() => checkFile('x.pdf', big, detectFormat), (e) => e.code === 'size');
  assert.equal(kindOf('cbz'), 'comic');
  assert.equal(kindOf('fb2'), 'book');
  assert.equal(kindOf('pdf'), 'document');
});

test('apocrypha checks: SHA-256', async () => {
  assert.equal(await sha256Hex(enc('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('apocrypha checks: the language', () => {
  assert.equal(detectLanguage('Мастер и Маргарита. Никогда не разговаривайте с неизвестными. Однажды весною, в час небывало жаркого заката'), 'ru');
  assert.equal(detectLanguage('Реве та стогне Дніпр широкий, сердитий вітер завива, додолу верби гне високі, горами хвилі підійма. Її пісні'), 'uk');
  assert.equal(detectLanguage('It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness'), 'en');
  assert.equal(detectLanguage('Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte, fand er sich in seinem Bett zu einem ungeheueren Ungeziefer verwandelt.'), 'de');
  assert.equal(detectLanguage('En un lugar de la Mancha, de cuyo nombre no quiero acordarme, no ha mucho tiempo que vivía un hidalgo de los de lanza en astillero'), 'es');
  assert.equal(detectLanguage('Longtemps, je me suis couché de bonne heure. Parfois, à peine ma bougie éteinte, mes yeux se fermaient si vite que je n’avais pas le temps'), 'fr');
  assert.equal(detectLanguage('吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。'), 'ja');
  assert.equal(detectLanguage('12345 —'), 'und');
  assert.equal(normalizeLang('ru-RU'), 'ru');
  assert.equal(normalizeLang('RUS'), 'ru');
  assert.equal(normalizeLang('en_GB'), 'en');
  assert.equal(normalizeLang(''), '');
  assert.equal(languageOf({ meta: 'en', text: 'Однажды весною, в час небывало жаркого заката' }), 'en', "the book's own record first");
  assert.equal(languageOf({ text: '', title: 'Преступление и наказание' }), 'ru', 'the title when there is no text');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(12 * 1024 * 1024), '12 MB');
});

/** Drive and the catalogue, as far as the client goes. */
function fakeServices() {
  const log = [];
  const drive = { files: {}, folders: {}, public: new Set() };
  let n = 0;
  const reply = (status, body, headers = {}) => new Response(body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers });
  async function fetchImpl(href, init = {}) {
    const url = new URL(href);
    const method = init.method ?? 'GET';
    log.push(`${method} ${url.hostname === 'cat.test' ? url.pathname : url.pathname.replace(/^\/drive\/v3/, 'drive')}`);
    if (url.hostname === 'cat.test') {
      if (url.pathname === '/v1/files' && method === 'POST') {
        assert.equal(init.headers.Authorization, 'Bearer TOKEN');
        const body = JSON.parse(init.body);
        if (!drive.public.has(body.driveId)) return reply(400, { error: 'not-public' });
        if (body.sha256 === 'dup') return reply(409, { error: 'duplicate', item: { id: 'old' } });
        return reply(201, { item: { id: 'new', driveId: body.driveId } });
      }
      if (url.pathname === '/v1/files/new' && method === 'DELETE') return reply(200, { ok: true, driveId: 'f1' });
      if (url.pathname === '/v1/files/abc/download') return reply(200, enc('abc'), { 'content-length': '3' });
      if (url.pathname === '/v1/files') return reply(200, { items: [], total: 0, page: Number(url.searchParams.get('page')), q: url.searchParams.get('q') });
      return reply(404, { error: 'not-found' });
    }
    if (url.pathname === '/drive/v3/files' && method === 'GET') return reply(200, { files: Object.values(drive.folders) });
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(init.body);
      drive.folders[meta.name] = { id: 'folder1' };
      return reply(200, { id: 'folder1' });
    }
    if (url.pathname === '/upload/drive/v3/files') {
      const id = `f${++n}`;
      drive.files[id] = true;
      return reply(200, { id });
    }
    const perm = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(url.pathname);
    if (perm) {
      assert.deepEqual(JSON.parse(init.body), { role: 'reader', type: 'anyone' });
      drive.public.add(perm[1]);
      return reply(200, { id: 'anyoneWithLink' });
    }
    const del = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (del && method === 'DELETE') {
      delete drive.files[del[1]];
      return reply(204, {});
    }
    return reply(404, {});
  }
  return { log, drive, fetchImpl };
}

test('apocrypha client: share, take back, download', async () => {
  const s = fakeServices();
  const api = createApocrypha({ base: 'https://cat.test', getToken: async () => 'TOKEN', fetchImpl: s.fetchImpl });
  const item = await api.publish({ name: 'Книга.pdf', bytes: enc('%PDF-1.7'), meta: { sha256: 'a'.repeat(64), size: 8, format: 'pdf' } });
  assert.equal(item.id, 'new');
  assert.ok(s.drive.files.f1, 'the copy is on Drive');
  assert.ok(s.drive.public.has('f1'), 'open to anyone with the link');

  // the second share finds the folder made by the first
  await assert.rejects(api.publish({ name: 'Та же.pdf', bytes: enc('%PDF-1.7'), meta: { sha256: 'dup', size: 8, format: 'pdf' } }), (e) => e instanceof ApocryphaError && e.code === 'duplicate' && e.item.id === 'old');
  assert.equal(s.log.filter((l) => l === 'POST drive/files').length, 1, 'one folder');
  assert.equal(s.drive.files.f2, undefined, 'a refused copy does not stay on Drive');

  await api.unpublish('new');
  assert.equal(s.drive.files.f1, undefined, "taking it back removes the Drive copy");

  const bytes = await api.download({ id: 'abc', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
  assert.deepEqual(bytes, enc('abc'));
  await assert.rejects(api.download({ id: 'abc', sha256: 'f'.repeat(64) }), (e) => e.code === 'mismatch');

  const found = await api.search({ q: 'булгаков', page: 2 });
  assert.equal(found.q, 'булгаков');
  assert.equal(found.page, 2);
});

test('apocrypha client: no network', async () => {
  const api = createApocrypha({ base: 'https://cat.test', getToken: async () => 'T', fetchImpl: async () => Promise.reject(new TypeError('Failed to fetch')) });
  await assert.rejects(api.search({}), (e) => e.code === 'offline');
});

test('apocrypha on Windows: the token, and an account that has to sign in once more', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createSync } = await import('../server/sync.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-apo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'sync'));
  fs.writeFileSync(path.join(dir, 'sync', 'account.json'), JSON.stringify({ email: 'a@example.com', refreshToken: 'R' }));
  let scope = 'openid email https://www.googleapis.com/auth/drive.appdata';
  const fetchImpl = async () => new Response(JSON.stringify({ access_token: 'ACCESS', expires_in: 3600, scope }), { status: 200 });
  const sync = createSync({ dataDir: dir, store: null, library: null, fetchImpl });
  await assert.rejects(sync.accessToken(), (e) => e.message === 'needs-consent' && e.status === 409, 'signed in before sharing existed');
  scope += ' https://www.googleapis.com/auth/drive.file';
  assert.equal((await sync.accessToken({ force: true })).token, 'ACCESS');
});

// The Apocrypha catalogue (apocrypha/src/worker.js) against SQLite standing in for D1 and a pretend
// Google: tokens, Drive files, who owns what and what is open to anyone.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle, looksLike, searchText, LIMITS } from '../apocrypha/src/worker.js';

const SCHEMA = fs.readFileSync(new URL('../apocrypha/schema.sql', import.meta.url), 'utf8');
const CLIENT = '276842939452-ocdg8ps2ftc3ijjjns8e7ktt62b5ckms.apps.googleusercontent.com';

/** D1's API over node:sqlite. */
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return {
    raw: db,
    prepare(sql) {
      const st = db.prepare(sql);
      let args = [];
      const out = {
        bind: (...a) => {
          args = a;
          return out;
        },
        first: async () => st.get(...args) ?? null,
        all: async () => ({ results: st.all(...args) }),
        run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }),
      };
      return out;
    },
  };
}

const PDF = new TextEncoder().encode('%PDF-1.7\n% a book\n');
const sha = (n) => n.toString(16).padStart(64, '0');

/** Google as the Worker sees it. users: token → { owner, email, azp }; files: driveId → { owner, bytes, sha256, public }. */
function fakeGoogle() {
  const users = {
    'tok-alice-0000': { owner: 'perm-alice', email: 'alice@example.com', azp: CLIENT },
    'tok-admin-0000': { owner: 'perm-admin', email: 'en.safarov@gmail.com', azp: CLIENT },
    'tok-other-0000': { owner: 'perm-other', email: 'x@example.com', azp: 'some-other-app' },
  };
  const files = {};
  const calls = [];
  const reply = (status, body, headers = {}) => new Response(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers });
  async function fetchImpl(href, init = {}) {
    const url = new URL(href);
    calls.push(url.pathname);
    const bearer = String(init.headers?.Authorization ?? '').replace('Bearer ', '');
    if (url.hostname === 'oauth2.googleapis.com') {
      const u = users[url.searchParams.get('access_token')];
      return u ? reply(200, { azp: u.azp, aud: u.azp, email: u.email, email_verified: 'true', scope: 'https://www.googleapis.com/auth/drive.file' }) : reply(400, { error: 'invalid_token' });
    }
    if (url.pathname === '/drive/v3/about') return users[bearer] ? reply(200, { user: { permissionId: users[bearer].owner } }) : reply(401, {});
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const file = files[decodeURIComponent(m[1])];
      const byKey = url.searchParams.get('key') === 'KEY';
      if (!file || (byKey && !bearer && !file.public) || (bearer && users[bearer]?.owner !== file.owner)) return reply(404, { error: { message: 'File not found' } });
      if (url.searchParams.get('alt') === 'media') {
        const range = /bytes=0-(\d+)/.exec(init.headers?.Range ?? '');
        return reply(range ? 206 : 200, range ? file.bytes.subarray(0, Number(range[1]) + 1) : file.bytes, { 'content-length': String(file.bytes.length) });
      }
      return reply(200, { id: m[1], size: String(file.bytes.length), sha256Checksum: file.sha256, ownedByMe: true, trashed: false });
    }
    return reply(404, {});
  }
  return { users, files, calls, fetchImpl };
}

function setup() {
  const env = { DB: fakeD1(), GOOGLE_API_KEY: 'KEY', GOOGLE_CLIENT_IDS: CLIENT, ADMIN_EMAIL: 'en.safarov@gmail.com', IP_SALT: 's' };
  const google = fakeGoogle();
  let clock = 1_800_000_000_000;
  let ip = '1.1.1.1';
  const call = async (method, path, { token, body, from } = {}) => {
    const headers = { 'cf-connecting-ip': from ?? ip };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await handle(new Request(`https://apocrypha.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, { fetchImpl: google.fetchImpl, now: clock });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
  };
  const putFile = (driveId, { owner = 'perm-alice', bytes = PDF, n = 1, open = true } = {}) => {
    google.files[driveId] = { owner, bytes, sha256: sha(n), public: open };
    return { driveId, sha256: sha(n), size: bytes.length, format: 'pdf', kind: 'book', lang: 'ru', title: 'Мастер и Маргарита', author: 'Михаил Булгаков' };
  };
  return { env, google, call, putFile, tick: (ms) => (clock += ms), setIp: (v) => (ip = v) };
}

test('apocrypha: share, find, download, take back', async () => {
  const s = setup();
  const share = s.putFile('drive-file-0001');
  const made = await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: { ...share, description: 'Роман' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.item.id;
  assert.equal(made.body.item.driveId, 'drive-file-0001');

  // found by a word of the author, ё or not, any case
  for (const q of ['булгаков', 'МАСТЕР', 'маргарита булгаков']) {
    const found = await s.call('GET', `/v1/files?q=${encodeURIComponent(q)}`);
    assert.equal(found.body.total, 1, q);
    assert.equal(found.body.items[0].title, 'Мастер и Маргарита');
    assert.equal(found.body.items[0].driveId, undefined, 'the Drive id is not public');
  }
  assert.equal((await s.call('GET', '/v1/files?q=толстой')).body.total, 0);
  assert.equal((await s.call('GET', '/v1/files?lang=en')).body.total, 0);
  assert.equal((await s.call('GET', '/v1/files?lang=ru&kind=book&format=pdf')).body.total, 1);
  assert.deepEqual((await s.call('GET', '/v1/langs')).body.langs, [{ lang: 'ru', count: 1 }]);
  assert.equal((await s.call('GET', `/v1/lookup?sha256=${sha(1)}`)).body.item.id, id);

  const got = await s.call('GET', `/v1/files/${id}/download`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, PDF);
  assert.equal(got.headers.get('x-apocrypha-sha256'), sha(1));
  assert.equal((await s.call('GET', `/v1/files/${id}`)).body.item.downloads, 1);

  // only its owner takes it back
  assert.equal((await s.call('DELETE', `/v1/files/${id}`, { token: 'tok-admin-0000' })).body.driveId, null, "the app's owner may remove it, but has no Drive file to clean up");
  const again = await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: share });
  assert.equal(again.status, 201, 'shared again once removed');
  const id2 = again.body.item.id;
  s.google.users['tok-bob-00000'] = { owner: 'perm-bob', email: 'bob@example.com', azp: CLIENT };
  assert.equal((await s.call('DELETE', `/v1/files/${id2}`, { token: 'tok-bob-00000' })).status, 403);
  const gone = await s.call('DELETE', `/v1/files/${id2}`, { token: 'tok-alice-0000' });
  assert.deepEqual(gone.body, { ok: true, driveId: 'drive-file-0001' });
  assert.equal((await s.call('GET', '/v1/files')).body.total, 0);
});

test('apocrypha: what the catalogue refuses', async () => {
  const s = setup();
  const ok = s.putFile('drive-file-0001');
  assert.equal((await s.call('POST', '/v1/files', { body: ok })).status, 401, 'no token');
  assert.equal((await s.call('POST', '/v1/files', { token: 'tok-unknown-000', body: ok })).status, 401, 'a token Google does not know');
  assert.equal((await s.call('POST', '/v1/files', { token: 'tok-other-0000', body: ok })).status, 403, 'a token given to another app');

  const theirs = s.putFile('drive-file-0002', { owner: 'perm-other', n: 2 });
  assert.equal((await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: theirs })).body.error, 'not-owner');
  const closed = s.putFile('drive-file-0003', { n: 3, open: false });
  assert.equal((await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: closed })).body.error, 'not-public');
  const lying = s.putFile('drive-file-0004', { n: 4 });
  assert.equal((await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: { ...lying, sha256: sha(99) } })).body.error, 'mismatch');
  assert.equal((await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: { ...lying, size: 999 } })).body.error, 'mismatch');
  const fake = s.putFile('drive-file-0005', { n: 5, bytes: new TextEncoder().encode('MZ\u0000\u0000 a program') });
  assert.equal((await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: fake })).body.error, 'bad-format');
  assert.equal((await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: { ...ok, format: 'exe' } })).body.error, 'bad-format');
  assert.equal((await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: { ...ok, size: 60 * 1024 * 1024 } })).body.error, 'too-big');
  assert.equal((await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: { ...ok, title: '  ' } })).body.error, 'bad-request');
  assert.equal((await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: { ...ok, cover: 'javascript:alert(1)' } })).body.error, 'bad-request');

  // one copy of each file: the second gets the first back (from another address: the tries above used up this one's hour)
  s.setIp('4.4.4.4');
  const first = await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: ok });
  assert.equal(first.status, 201);
  const copy = s.putFile('drive-file-0006', { n: 1 });
  const dup = await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: copy });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.item.id, first.body.item.id);
});

test('apocrypha: complaints and hiding', async () => {
  const s = setup();
  const { body } = await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: s.putFile('drive-file-0001') });
  const id = body.item.id;
  assert.equal((await s.call('POST', `/v1/files/${id}/report`, { body: { reason: 'nonsense' } })).status, 400);
  await s.call('POST', `/v1/files/${id}/report`, { body: { reason: 'rights', note: 'это мой перевод' } });
  await s.call('POST', `/v1/files/${id}/report`, { body: { reason: 'rights' } }); // the same address again: counted once
  await s.call('POST', `/v1/files/${id}/report`, { body: { reason: 'spam' }, from: '2.2.2.2' });

  assert.equal((await s.call('GET', '/v1/admin/reports', { token: 'tok-alice-0000' })).status, 403);
  const reports = await s.call('GET', '/v1/admin/reports', { token: 'tok-admin-0000' });
  assert.equal(reports.body.items.length, 1);
  assert.equal(reports.body.items[0].reports, 2);
  assert.deepEqual(reports.body.items[0].complaints.map((c) => c.reason).sort(), ['rights', 'spam']);

  assert.equal((await s.call('POST', `/v1/admin/files/${id}`, { token: 'tok-admin-0000', body: { hidden: true } })).status, 200);
  assert.equal((await s.call('GET', '/v1/files')).body.total, 0, 'hidden from the list');
  assert.equal((await s.call('GET', `/v1/files/${id}/download`)).status, 404);
  assert.equal((await s.call('GET', `/v1/lookup?sha256=${sha(1)}`)).body.hidden, true);
  const mine = await s.call('GET', '/v1/mine', { token: 'tok-alice-0000' });
  assert.equal(mine.body.items[0].hidden, 1, 'its owner sees it is hidden');
  assert.equal(mine.body.admin, false);
  assert.equal((await s.call('GET', '/v1/mine', { token: 'tok-admin-0000' })).body.admin, true);

  await s.call('POST', `/v1/admin/files/${id}`, { token: 'tok-admin-0000', body: { hidden: false } });
  assert.equal((await s.call('GET', '/v1/files')).body.total, 1);
});

test('apocrypha: a file gone from Drive leaves the list', async () => {
  const s = setup();
  const { body } = await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: s.putFile('drive-file-0001') });
  delete s.google.files['drive-file-0001'];
  assert.equal((await s.call('GET', `/v1/files/${body.item.id}/download`)).status, 410);
  assert.equal((await s.call('GET', '/v1/files')).body.total, 0);
});

test('apocrypha: too many requests from one address', async () => {
  const s = setup();
  const [max] = LIMITS.report;
  const { body } = await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: s.putFile('drive-file-0001') });
  let last;
  for (let i = 0; i <= max; i++) last = await s.call('POST', `/v1/files/${body.item.id}/report`, { body: { reason: 'spam' } });
  assert.equal(last.status, 429);
  assert.equal((await s.call('POST', `/v1/files/${body.item.id}/report`, { body: { reason: 'spam' }, from: '3.3.3.3' })).status, 200, 'another address is fine');
  s.tick(LIMITS.report[1] * 1000);
  assert.equal((await s.call('POST', `/v1/files/${body.item.id}/report`, { body: { reason: 'spam' } })).status, 200, 'and so is the next hour');
});

test('apocrypha: pages, sorting, odd searches', async () => {
  const s = setup();
  for (let i = 1; i <= 30; i++) {
    s.tick(1000);
    s.setIp(`10.0.0.${i}`); // the publish limit is per address
    const r = await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: { ...s.putFile(`drive-file-${String(i).padStart(4, '0')}`, { n: i }), title: `Том ${i} 100%_книга` } });
    assert.equal(r.status, 201);
  }
  const page1 = await s.call('GET', '/v1/files');
  assert.equal(page1.body.total, 30);
  assert.equal(page1.body.items.length, 24);
  assert.equal(page1.body.pages, 2);
  assert.equal(page1.body.items[0].title, 'Том 30 100%_книга', 'newest first');
  assert.equal((await s.call('GET', '/v1/files?page=2')).body.items.length, 6);
  assert.equal((await s.call('GET', `/v1/files?q=${encodeURIComponent('%')}`)).body.total, 30, 'a lone % searches for nothing in particular');
  assert.equal((await s.call('GET', `/v1/files?q=${encodeURIComponent("' OR 1=1 --")}`)).body.total, 0);
  assert.equal((await s.call('POST', '/v1/files', { token: 'tok-alice-0000', body: s.putFile('drive-file-0099', { n: 99 }), from: '9.9.9.9' })).body.error, 'day-limit');
});

test('apocrypha: the second look at the first bytes', () => {
  const b = (s) => new TextEncoder().encode(s);
  assert.ok(looksLike('pdf', b('%PDF-1.4')));
  assert.ok(!looksLike('pdf', b('PK\u0003\u0004')));
  assert.ok(looksLike('epub', b('PK\u0003\u0004....')));
  assert.ok(looksLike('rtf', b('{\\rtf1\\ansi')));
  assert.ok(looksLike('txt', b('Просто текст')));
  assert.ok(!looksLike('txt', b('MZ\u0000\u0000')));
  assert.equal(searchText('Ёжик в Тумане!', 'Козлов'), 'ежик в тумане козлов');
});

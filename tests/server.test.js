import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireLock, BUILD, createAtlasServer, VERSION } from '../server/server.js';

test('hello names the code the server runs, so the launcher can spot a stale one', async (t) => {
  const { app } = await start(t);
  const hello = await (await fetch(`${app.url}api/hello`)).json();
  assert.deepEqual(hello, { app: 'atlas-notetaker', version: VERSION, build: BUILD });
  assert.match(BUILD, /^[0-9a-f]{12}$/);
});

async function start(t) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'atlas-server-'));
  const app = await createAtlasServer({ dataDir, port: 0 });
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const call = (method, route, body, headers = {}) =>
    fetch(`${app.url}api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Atlas-Token': app.token, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, call, dataDir };
}

function rawGet(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('the page carries the token and the API refuses calls without it', async (t) => {
  const { app, call } = await start(t);
  const html = await (await fetch(app.url)).text();
  assert.ok(html.includes(app.token));
  assert.equal((await fetch(`${app.url}api/notes`)).status, 403);
  assert.equal((await call('GET', 'notes')).status, 200);
});

test('a foreign origin is refused even with the token', async (t) => {
  const { call } = await start(t);
  assert.equal((await call('GET', 'notes', undefined, { Origin: 'https://evil.example' })).status, 403);
});

test('a rebound host name is refused', async (t) => {
  const { app } = await start(t);
  assert.equal(await rawGet(app.port, '/', `evil.example:${app.port}`), 421);
  assert.equal(await rawGet(app.port, '/', `127.0.0.1:${app.port}`), 200);
});

test('static files cannot escape dist', async (t) => {
  const { app } = await start(t);
  assert.equal((await fetch(`${app.url}dist/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${app.url}server/store.js`)).status, 404);
});

test('a note goes through its whole life over HTTP', async (t) => {
  const { call, dataDir } = await start(t);
  const created = await (await call('POST', 'notes', { content: '# Экспедиция' })).json();
  assert.match(created.id, /^n-/);

  assert.equal((await call('PUT', `notes/${created.id}`, { content: '# Экспедиция\n\nлагерь' })).status, 200);
  assert.equal((await call('PATCH', `notes/${created.id}/meta`, { cursor: { anchor: 3, head: 3 }, scroll: 40 })).status, 204);

  const [note] = await (await call('GET', 'notes')).json();
  assert.equal(note.content, '# Экспедиция\n\nлагерь');
  assert.deepEqual(note.cursor, { anchor: 3, head: 3 });

  assert.equal((await call('POST', `notes/${created.id}/trash`)).status, 204);
  assert.deepEqual(await (await call('GET', 'notes')).json(), []);
  assert.equal(readdirSync(path.join(dataDir, 'notes', '.trash')).length, 1);
  assert.equal((await call('PUT', `notes/${created.id}`, { content: 'поздно' })).status, 409);
});

test('flush stores text and cursor in one request', async (t) => {
  const { call } = await start(t);
  const { id } = await (await call('POST', 'notes', { content: '' })).json();
  assert.equal((await call('POST', 'flush', { id, content: 'последнее слово', meta: { cursor: { anchor: 9, head: 9 } } })).status, 204);
  const [note] = await (await call('GET', 'notes')).json();
  assert.equal(note.content, 'последнее слово');
  assert.deepEqual(note.cursor, { anchor: 9, head: 9 });
});

test('bad ids and bodies get client errors, not crashes', async (t) => {
  const { app, call } = await start(t);
  assert.equal((await call('PUT', 'notes/..%2F..%2Fevil', { content: 'x' })).status, 400);
  const res = await fetch(`${app.url}api/state`, { method: 'PATCH', headers: { 'X-Atlas-Token': 'nope' }, body: '{' });
  assert.equal(res.status, 403);
});

test('a picture is stored, served back and kept to safe names', async (t) => {
  const { app } = await start(t);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const upload = await fetch(`${app.url}api/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Atlas-Token': app.token }, body: png });
  assert.equal(upload.status, 201);
  const { name } = await upload.json();
  assert.match(name, /^a-[a-z0-9]+\.png$/);

  const served = await fetch(`${app.url}note-assets/${name}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);

  assert.equal((await fetch(`${app.url}note-assets/..%2F..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${app.url}api/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).status, 403);
  const notImage = await fetch(`${app.url}api/assets`, { method: 'POST', headers: { 'Content-Type': 'text/html', 'X-Atlas-Token': app.token }, body: '<b>' });
  assert.equal(notImage.status, 415);
});

test('unsaved text the page did not put back lands in the backups folder', async (t) => {
  const { app, call } = await start(t);
  const res = await call('POST', 'drafts', { title: 'План', content: 'черновик', at: Date.now(), label: 'не восстановлено' });
  assert.equal(res.status, 201);
  const { name } = await res.json();
  assert.deepEqual(readdirSync(app.backups.draftsDir), [name]);
  const bare = await fetch(`${app.url}api/drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"content":"x"}' });
  assert.equal(bare.status, 403);
  assert.equal((await call('POST', 'drafts', { title: 'без текста' })).status, 400);
});

test('a server started on existing notes copies them first', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'atlas-server-'));
  const first = await createAtlasServer({ dataDir, port: 0 });
  await first.store.create('# Было до обновления');
  await first.close();
  writeFileSync(path.join(dataDir, 'backups', 'last.json'), JSON.stringify({ version: '0.0.1', build: 'old', at: Date.now() }));
  const second = await createAtlasServer({ dataDir, port: 0 });
  t.after(async () => {
    await second.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const [copy] = readdirSync(second.backups.dir).filter((name) => name.endsWith('до обновления'));
  assert.ok(copy, 'a copy before the update');
  assert.equal(readdirSync(path.join(second.backups.dir, copy)).filter((name) => name.endsWith('.md')).length, 1);
});

test('only one server may own a notes folder; a dead owner\'s lock is taken over', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'server.lock');

  writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() })); // no such process
  const release = await acquireLock(file);
  await assert.rejects(acquireLock(file), { code: 'ATLAS_RUNNING' });
  release();
  assert.equal(existsSync(file), false);
});

test('the library keeps a document, its card and the reader\'s place', async (t) => {
  const { app, call, dataDir } = await start(t);
  const bytes = Buffer.from('%PDF-1.7 not really a book');
  const upload = (query, body = bytes, headers = {}) =>
    fetch(`${app.url}api/library?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Atlas-Token': app.token, ...headers }, body });

  assert.equal((await upload('name=a.pdf&format=pdf', bytes, { 'X-Atlas-Token': 'wrong' })).status, 403);
  assert.equal((await upload('name=a.exe&format=exe')).status, 415);
  const res = await upload(`name=${encodeURIComponent('Книга: том/1.pdf')}&format=pdf`);
  assert.equal(res.status, 201);
  const doc = await res.json();
  assert.match(doc.id, /^d-[a-z0-9]+$/);
  assert.equal(doc.name, 'Книга том 1.pdf');
  assert.equal(doc.size, bytes.length);
  assert.ok(existsSync(path.join(dataDir, 'library', `${doc.id}.pdf`)));

  const cover = 'data:image/jpeg;base64,/9j/4AAQ';
  const patched = await (await call('PATCH', `library/${doc.id}`, { title: 'Книга', cover, position: { page: 3, frac: 0.5 }, progress: 0.25, notesId: 'n-abc123', evil: 1, cover2: 'x' })).json();
  assert.equal(patched.title, 'Книга');
  assert.equal(patched.cover, cover);
  assert.deepEqual(patched.position, { page: 3, frac: 0.5 });
  assert.equal(patched.evil, undefined);
  const refused = await (await call('PATCH', `library/${doc.id}`, { cover: 'javascript:alert(1)', progress: 7, notesId: '../x' })).json();
  assert.equal(refused.cover, cover, 'a cover that is not a picture is ignored');
  assert.equal(refused.progress, 0.25);
  assert.equal(refused.notesId, 'n-abc123');

  const list = await (await call('GET', 'library')).json();
  assert.deepEqual(list.map((d) => d.id), [doc.id]);
  const file = await fetch(`${app.url}api/library/${doc.id}/file`, { headers: { 'X-Atlas-Token': app.token } });
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  assert.equal((await fetch(`${app.url}api/library/${doc.id}/file`)).status, 403, 'the file needs the token too');
  assert.equal((await call('GET', 'library/d-nosuch1/file')).status, 404);
  assert.equal((await call('GET', 'library/..%2F..%2Fatlas.json/file')).status, 404);

  assert.equal((await call('POST', `library/${doc.id}/trash`)).status, 204);
  assert.deepEqual(await (await call('GET', 'library')).json(), []);
  assert.equal(readdirSync(path.join(dataDir, 'library', '.trash')).length, 1, 'a removed document waits in .trash');
});

test('the library\'s cards survive a restart', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'atlas-server-'));
  const first = await createAtlasServer({ dataDir, port: 0 });
  const doc = await first.library.add(Buffer.from('# hi'), { name: 'hi.md', format: 'md' });
  first.library.update(doc.id, { title: 'Привет', position: { at: 4, frac: 0 } });
  await first.close();
  const second = await createAtlasServer({ dataDir, port: 0 });
  t.after(async () => {
    await second.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const [card] = second.library.list();
  assert.equal(card.title, 'Привет');
  assert.deepEqual(card.position, { at: 4, frac: 0 });
});

test('the page may start the pdf.js worker from a blob: URL, and nothing else changes', async (t) => {
  const { app } = await start(t);
  const csp = (await fetch(app.url)).headers.get('content-security-policy');
  assert.match(csp, /worker-src blob:/);
  assert.match(csp, /script-src 'self'(;|$)/);
});

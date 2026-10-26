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

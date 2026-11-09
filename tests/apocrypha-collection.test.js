import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createCollection, pickBooks, toItem } from '../src/apocrypha/collection.js';

const BASE = 'https://raw.example/books/main/';
const book = new TextEncoder().encode('PK fake epub bytes');
const sha = crypto.createHash('sha256').update(book).digest('hex');
const catalog = {
  version: 1,
  books: [
    { id: 'pg-11', title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', language: 'en', format: 'epub', size: book.length, sha256: sha, path: 'books/pg-11.epub', cover: 'covers/pg-11.jpg', source: 'Project Gutenberg', rights: 'Public domain in the USA.' },
    { id: 'pg-2554', title: 'Crime and Punishment', author: 'Fyodor Dostoyevsky', language: 'en', format: 'epub', size: 10, sha256: 'f'.repeat(64), path: 'books/pg-2554.epub' },
    { id: 'x', title: 'Ёжик в тумане', author: 'Сергей Козлов', language: 'ru', format: 'epub', size: 10, path: 'books/x.epub' },
    { id: 'bad', title: 'Escapes', path: '../secrets.txt' },
  ],
};

function fakeFetch(files) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = files[url];
    if (body === undefined) return new Response('no', { status: 404 });
    return new Response(typeof body === 'string' ? body : body, { status: 200, headers: { 'content-length': String(body.length ?? 0) } });
  };
  return { fetchImpl, calls };
}

const memory = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) };
};

test('collection: an entry out of its folders (a path with ..) is left out', () => {
  assert.equal(toItem(catalog.books[3], BASE), null);
  const alice = toItem(catalog.books[0], BASE);
  assert.equal(alice.url, `${BASE}books/pg-11.epub`);
  assert.equal(alice.coverUrl, `${BASE}covers/pg-11.jpg`);
  assert.equal(alice.source, 'collection');
});

test('collection: a search finds words in title and author, ё as е, and by language', () => {
  const items = catalog.books.map((b) => toItem(b, BASE)).filter(Boolean);
  assert.deepEqual(pickBooks(items, { q: 'carroll alice' }).map((i) => i.title), ["Alice's Adventures in Wonderland"]);
  assert.deepEqual(pickBooks(items, { q: 'ежик' }).map((i) => i.author), ['Сергей Козлов']);
  assert.equal(pickBooks(items, { lang: 'en' }).length, 2);
});

test('collection: the list is read once, kept, and shown from the copy when GitHub is out of reach', async () => {
  const storage = memory();
  const { fetchImpl, calls } = fakeFetch({ [`${BASE}catalog.json`]: JSON.stringify(catalog) });
  const one = createCollection({ base: BASE, fetchImpl, storage });
  assert.equal((await one.search()).total, 3);
  await one.search({ q: 'crime' });
  assert.equal(calls.length, 1);
  const offline = createCollection({ base: BASE, fetchImpl: async () => { throw new TypeError('offline'); }, storage });
  assert.equal((await offline.search()).total, 3);
  assert.deepEqual(await offline.langs(), ['en', 'ru']);
});

test('collection: a download is checked against its SHA-256', async () => {
  const { fetchImpl } = fakeFetch({ [`${BASE}catalog.json`]: JSON.stringify(catalog), [`${BASE}books/pg-11.epub`]: book, [`${BASE}books/pg-2554.epub`]: book });
  const c = createCollection({ base: BASE, fetchImpl, storage: memory() });
  // in title order: Alice, then Crime and Punishment (whose SHA-256 in the list is wrong)
  const [alice, crime] = (await c.search()).items.filter((i) => i.lang === 'en');
  const seen = [];
  const bytes = await c.download(alice, (got, total) => seen.push([got, total]));
  assert.deepEqual([...bytes], [...book]);
  assert.ok(seen.length);
  await assert.rejects(c.download(crime), (err) => err.code === 'mismatch');
});

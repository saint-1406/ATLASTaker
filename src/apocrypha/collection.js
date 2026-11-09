// Apocrypha's collection: books in the public domain kept in a public GitHub repository (one file
// per book, as it came, and catalog.json listing them). Nothing in between: the app reads the list
// and the files straight from GitHub's raw files, which answer any page. The list is kept on the
// device too, so it shows offline; a download is checked against the SHA-256 in the list.
// scripts/books-catalog.mjs makes the repository's contents from a folder of books.

import { sha256Hex } from './checks.js';
import { ApocryphaError } from './client.js';

/** The repository the collection lives in, and its branch. */
export const COLLECTION_REPO = 'saint-1406/atlas-books';
export const COLLECTION_URL = `https://raw.githubusercontent.com/${COLLECTION_REPO}/main/`;
const CACHE_KEY = 'atlas.apocrypha.collection';
const PER_PAGE = 40;

const fold = (s) =>
  String(s ?? '')
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ё/g, 'е');

/** An entry of catalog.json as the screen shows it; null for one that does not hold together. */
export function toItem(book, base = COLLECTION_URL) {
  if (!book || typeof book.path !== 'string' || !/^books\/[\w.-]+$/.test(book.path) || typeof book.title !== 'string') return null;
  return {
    id: `c:${book.id ?? book.path}`,
    source: 'collection',
    title: book.title.slice(0, 300),
    author: typeof book.author === 'string' ? book.author.slice(0, 300) : '',
    lang: typeof book.language === 'string' ? book.language.slice(0, 12) : 'und',
    format: typeof book.format === 'string' ? book.format : 'epub',
    kind: 'book',
    size: Number(book.size) || 0,
    sha256: typeof book.sha256 === 'string' && /^[0-9a-f]{64}$/.test(book.sha256) ? book.sha256 : '',
    cover: typeof book.cover === 'string' && /^covers\/[\w.-]+$/.test(book.cover),
    coverUrl: typeof book.cover === 'string' && /^covers\/[\w.-]+$/.test(book.cover) ? base + book.cover : '',
    url: base + book.path,
    origin: typeof book.source === 'string' ? book.source.slice(0, 80) : '',
    originUrl: typeof book.sourceUrl === 'string' && /^https:\/\//.test(book.sourceUrl) ? book.sourceUrl : '',
    rights: typeof book.rights === 'string' ? book.rights.slice(0, 120) : '',
    year: Number(book.year) || 0,
  };
}

/** The books of the collection matching a search, kind and language; newest-first is by title here. */
export function pickBooks(items, { q = '', lang = '', kind = '' } = {}) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  return items
    .filter((item) => (!lang || item.lang === lang) && (!kind || item.kind === kind))
    .filter((item) => {
      if (!words.length) return true;
      const text = fold(`${item.title} ${item.author}`);
      return words.every((w) => text.includes(w));
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function createCollection({ base = COLLECTION_URL, fetchImpl = (...args) => fetch(...args), storage = globalThis.localStorage } = {}) {
  let items = null;
  let loading = null;

  function cached() {
    try {
      const saved = JSON.parse(storage?.getItem(CACHE_KEY) ?? 'null');
      return Array.isArray(saved?.books) ? saved : null;
    } catch {
      return null;
    }
  }

  const fill = (catalog) => (items = (catalog.books ?? []).map((book) => toItem(book, base)).filter(Boolean));

  /** The list: once from GitHub (then kept), or the copy kept from last time when offline. */
  function load() {
    if (items) return Promise.resolve(items);
    loading ??= (async () => {
      try {
        const res = await fetchImpl(`${base}catalog.json`, { cache: 'no-cache' });
        if (!res.ok) throw new ApocryphaError(`http-${res.status}`, { status: res.status });
        const catalog = await res.json();
        fill(catalog);
        try {
          storage?.setItem(CACHE_KEY, JSON.stringify(catalog));
        } catch {
          // too big for the store, or a private window: next time it comes from GitHub again
        }
        return items;
      } catch (err) {
        const saved = cached();
        if (saved) return fill(saved);
        throw err instanceof ApocryphaError ? err : new ApocryphaError('offline');
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  return {
    base,
    load,
    /** { items, total }: all the matching books at once (the collection is small enough). */
    async search(filters = {}) {
      const found = pickBooks(await load(), filters);
      return { items: found, total: found.length, perPage: PER_PAGE };
    },
    /** The languages the collection has books in. */
    async langs() {
      return [...new Set((await load()).map((item) => item.lang))];
    },
    /** The file's bytes, checked against the SHA-256 in the list. onBytes(received, total). */
    async download(item, onBytes) {
      let res;
      try {
        res = await fetchImpl(item.url);
      } catch {
        throw new ApocryphaError('offline');
      }
      if (!res.ok) throw new ApocryphaError(res.status === 404 ? 'not-found' : `http-${res.status}`, { status: res.status });
      const total = Number(res.headers.get('content-length')) || item.size || 0;
      const chunks = [];
      let received = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onBytes?.(received, total);
      }
      const bytes = new Uint8Array(received);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      if (item.sha256 && (await sha256Hex(bytes)) !== item.sha256) throw new ApocryphaError('mismatch');
      return bytes;
    },
  };
}

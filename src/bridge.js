// How the page reaches its notes. Served by server/server.js, it talks to that server's API and the
// notes are .md files on disk. Opened any other way (the single-file browser build) the same
// interface is backed by the browser's IndexedDB, or localStorage where that is missing.

import { t } from './i18n.js';

const token = document.querySelector('meta[name="atlas-token"]')?.content ?? '';
const onServer = location.protocol.startsWith('http') && token !== '' && !token.startsWith('__');

// Errors say what went wrong: `offline` — the server is gone; `status` — it answered with an error
// (403 after a restart, since every run has a new token).
async function call(method, route, body, { keepalive = false } = {}) {
  let res;
  try {
    res = await fetch(`/api/${route}`, {
      method,
      keepalive,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Atlas-Token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw Object.assign(new Error(t('errors.offline')), { offline: true, cause: err });
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw Object.assign(new Error(`${method} /api/${route} → ${res.status}${detail.error ? `: ${detail.error}` : ''}`), { status: res.status });
  }
  return res.status === 204 ? null : res.json();
}

const enc = encodeURIComponent;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const newAssetName = (type) => `a-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}.${IMAGE_TYPES[type]}`;

async function fetchOk(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw Object.assign(new Error(t('errors.offline')), { offline: true, cause: err });
  }
  if (!res.ok) throw Object.assign(new Error(`${url} → ${res.status}`), { status: res.status });
  return res;
}

function serverApi() {
  return {
    kind: 'server',
    list: () => call('GET', 'notes'),
    create: (content = '') => call('POST', 'notes', { content }),
    write: (id, content) => call('PUT', `notes/${enc(id)}`, { content }),
    setMeta: (id, meta) => call('PATCH', `notes/${enc(id)}/meta`, meta),
    trash: (id) => call('POST', `notes/${enc(id)}/trash`),
    getState: () => call('GET', 'state'),
    setState: (patch) => call('PATCH', 'state', patch),
    ping: () => call('POST', 'ping'),
    openNotesFolder: () => call('POST', 'open-folder'),
    openBackupsFolder: () => call('POST', 'open-backups'),
    /** Puts text aside as a file in backups/несохранённое: { title, content, at, label }. */
    keepDraft: (draft) => call('POST', 'drafts', draft),
    /** Stores a picture next to the notes (notes/assets) and returns its file name. */
    async saveAsset(blob) {
      if (!IMAGE_TYPES[blob.type]) throw new Error(t('image.wrongType'));
      const res = await fetchOk('/api/assets', { method: 'POST', headers: { 'Content-Type': blob.type, 'X-Atlas-Token': token }, body: blob });
      return (await res.json()).name;
    },
    assetUrl: async (name) => `/note-assets/${enc(name)}`,
    async readAsset(name) {
      return new Uint8Array(await (await fetchOk(`/note-assets/${enc(name)}`)).arrayBuffer());
    },
    // The window is closing. keepalive lets a request outlive the page but caps its body at 64 KB
    // (bytes, and Cyrillic takes two per letter); a longer note goes out as a plain request, which the
    // local server usually receives before the page is gone. The rescue copy covers the rest.
    flushOnExit(id, content, meta) {
      const body = { id, content, meta };
      const bytes = new Blob([JSON.stringify(body)]).size;
      call('POST', 'flush', body, { keepalive: bytes < 60_000 }).catch(() => {});
    },
  };
}

const request = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const finished = (t) =>
  new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });

// The browser build (one HTML file, no server): notes live in this browser's IndexedDB, which holds
// far more than localStorage and is kept unless the user clears the browser's data. Deleted notes go
// to a trash store instead of disappearing.
function browserApi() {
  const opened = new Promise((resolve, reject) => {
    // v2 added pictures; each store is created only if missing, so existing notes stay put
    const r = indexedDB.open('atlas-notetaker', 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      const has = (name) => db.objectStoreNames.contains(name);
      if (!has('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!has('trash')) db.createObjectStore('trash', { autoIncrement: true });
      if (!has('state')) db.createObjectStore('state');
      if (!has('assets')) db.createObjectStore('assets');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict us under storage pressure
  const store = async (name, mode = 'readonly') => (await opened).transaction(name, mode).objectStore(name);
  const newId = () => `n-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const assetUrls = new Map(); // name → object URL, made once per window

  return {
    kind: 'browser',
    async saveAsset(blob) {
      if (!IMAGE_TYPES[blob.type]) throw new Error(t('image.wrongType'));
      const name = newAssetName(blob.type);
      await request((await store('assets', 'readwrite')).put(blob, name));
      return name;
    },
    async assetUrl(name) {
      if (!assetUrls.has(name)) {
        const blob = await request((await store('assets')).get(name));
        if (!blob) return null;
        assetUrls.set(name, URL.createObjectURL(blob));
      }
      return assetUrls.get(name);
    },
    async readAsset(name) {
      const blob = await request((await store('assets')).get(name));
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    },
    async list() {
      return request((await store('notes')).getAll());
    },
    async create(content = '') {
      const now = Date.now();
      const note = { id: newId(), content: String(content), created: now, updated: now, cursor: null, scroll: 0 };
      await request((await store('notes', 'readwrite')).put(note));
      return note;
    },
    async write(id, content) {
      const notes = await store('notes', 'readwrite');
      const note = await request(notes.get(id));
      if (!note) throw Object.assign(new Error(t('errors.noNote', id)), { status: 404 });
      note.content = content;
      note.updated = Date.now();
      await request(notes.put(note));
      return { updated: note.updated };
    },
    async setMeta(id, meta) {
      const notes = await store('notes', 'readwrite');
      const note = await request(notes.get(id));
      if (!note) return;
      if (meta?.cursor) note.cursor = meta.cursor;
      if (Number.isFinite(meta?.scroll)) note.scroll = meta.scroll;
      await request(notes.put(note));
    },
    async trash(id) {
      const t = (await opened).transaction(['notes', 'trash'], 'readwrite');
      const note = await request(t.objectStore('notes').get(id));
      if (note) {
        t.objectStore('trash').add({ ...note, deletedAt: Date.now() });
        t.objectStore('notes').delete(id);
      }
      await finished(t);
    },
    // text put aside instead of restored goes to the trash store too, so it is never simply gone
    async keepDraft({ title, content, at, label }) {
      await request((await store('trash', 'readwrite')).add({ title, content, updated: at, label, draft: true, deletedAt: Date.now() }));
    },
    async getState() {
      return (await request((await store('state')).get('state'))) ?? {};
    },
    async setState(patch) {
      const states = await store('state', 'readwrite');
      const state = { ...((await request(states.get('state'))) ?? {}), ...patch };
      await request(states.put(state, 'state'));
      return state;
    },
    // The page is closing: start the writes; the rescue copy (localStorage, synchronous) covers the rest.
    flushOnExit(id, content, meta) {
      if (typeof content === 'string') this.write(id, content).catch(() => {});
      if (meta) this.setMeta(id, meta).catch(() => {});
    },
  };
}

function localApi() {
  const KEY = 'atlas-notetaker:web:v1';
  let db;
  try {
    db = JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    db = {};
  }
  db.notes ??= {};
  db.state ??= {};
  const persist = () => localStorage.setItem(KEY, JSON.stringify(db));
  const newId = () => `n-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const note = (id) => {
    const n = db.notes[id];
    if (!n) throw new Error(t('errors.noNote', id));
    return n;
  };
  const applyMeta = (n, meta) => {
    if (meta?.cursor) n.cursor = meta.cursor;
    if (Number.isFinite(meta?.scroll)) n.scroll = meta.scroll;
  };
  return {
    kind: 'local',
    async list() {
      return Object.entries(db.notes).map(([id, n]) => ({ id, ...n }));
    },
    async create(content = '') {
      const now = Date.now();
      const id = newId();
      db.notes[id] = { content, created: now, updated: now, cursor: null, scroll: 0 };
      persist();
      return { id, ...db.notes[id] };
    },
    async write(id, content) {
      const n = note(id);
      n.content = content;
      n.updated = Date.now();
      persist();
      return { updated: n.updated };
    },
    async setMeta(id, meta) {
      applyMeta(note(id), meta);
      persist();
    },
    async trash(id) {
      delete db.notes[id];
      persist();
    },
    async keepDraft(draft) {
      (db.drafts ??= []).push({ ...draft, keptAt: Date.now() });
      persist();
    },
    async getState() {
      return { ...db.state };
    },
    async setState(patch) {
      Object.assign(db.state, patch);
      persist();
      return { ...db.state };
    },
    flushOnExit(id, content, meta) {
      const n = db.notes[id];
      if (!n) return;
      if (typeof content === 'string') {
        n.content = content;
        n.updated = Date.now();
      }
      applyMeta(n, meta);
      persist();
    },
  };
}

/**
 * A copy of text that has not reached the disk yet, kept in this browser until a save confirms it.
 * If the server dies or a save fails, the next start of ATLAS finds the copy and offers it back.
 */
export const rescue = (() => {
  const KEY = 'atlas-notetaker:rescue:v1';
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) ?? {};
    } catch {
      return {};
    }
  };
  const write = (all) => {
    try {
      if (Object.keys(all).length) localStorage.setItem(KEY, JSON.stringify(all));
      else localStorage.removeItem(KEY);
    } catch {
      // storage full or blocked: the server copy is all we have
    }
  };
  return {
    put(id, content) {
      write({ ...read(), [id]: { content, at: Date.now() } });
    },
    /** Forgets the copy; with `content`, only if the copy still holds exactly that text. */
    drop(id, content) {
      const all = read();
      if (!all[id] || (content !== undefined && all[id].content !== content)) return;
      delete all[id];
      write(all);
    },
    all: read,
  };
})();

function pickApi() {
  if (onServer) return serverApi();
  return typeof indexedDB === 'object' && indexedDB ? browserApi() : localApi();
}

export const api = {
  ...pickApi(),
  copy: (text) => navigator.clipboard.writeText(text),
  readClipboard: () => navigator.clipboard.readText(),
  openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
  /** Hands the user a file: `data` is text (saved as Markdown) or bytes with their own `type`. */
  download(filename, data, type = 'text/markdown;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
};

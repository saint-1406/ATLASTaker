// How the page reaches its notes. Served by server/server.js, it talks to that server's API and the
// notes are .md files on disk. Opened any other way (index.html straight from the folder) the same
// interface is backed by localStorage, so the UI still works.

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
    throw Object.assign(new Error('Сервер ATLAS не отвечает'), { offline: true, cause: err });
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw Object.assign(new Error(`${method} /api/${route} → ${res.status}${detail.error ? `: ${detail.error}` : ''}`), { status: res.status });
  }
  return res.status === 204 ? null : res.json();
}

const enc = encodeURIComponent;

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
    if (!n) throw new Error(`нет заметки ${id}`);
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
 * If the server dies or a save fails, the next start of ATLAS finds the copy and puts the text back.
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

export const api = {
  ...(onServer ? serverApi() : localApi()),
  copy: (text) => navigator.clipboard.writeText(text),
  readClipboard: () => navigator.clipboard.readText(),
  openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
  download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
};

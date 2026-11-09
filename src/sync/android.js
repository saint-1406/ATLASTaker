// Sync on Android: the rounds run here in the page (src/sync/engine.js), against the notes and
// library in the WebView's IndexedDB. Signing in is the phone's own Google sheet: the app's native
// side (MainActivity.java, AtlasAndroid.syncAuthorize) asks Google for access to the app's Drive folder
// and hands the page an access token through window.__atlasSync.token(...).
// What is kept, in the IndexedDB "state" store under "sync": { signedIn, email, base, lastSync, hashes }.

import { createDrive } from './drive.js';
import { emptyBase, hashBytes, syncOnce } from './engine.js';
import { settingsOf, SETTING_KEYS } from './merge.js';
import { validBookmarks, validEdits, validMarks, validTexts } from '../marks.js';

const DOC_FORMATS = ['pdf', 'epub', 'fb2', 'docx', 'odt', 'rtf', 'md', 'txt', 'html', 'cbz', 'img'];
const text = (max) => (v) => typeof v === 'string' && v.length <= max;
const num = (v) => Number.isFinite(v);
// what a card from Drive may hold, as the Windows side checks it (server/library.js)
const CARD_RULES = {
  name: text(200),
  format: (v) => DOC_FORMATS.includes(v),
  added: num,
  title: text(300),
  author: text(300),
  cover: (v) => v === null || (typeof v === 'string' && v.length <= 400_000 && /^data:image\/(png|jpeg|webp);base64,/.test(v)),
  position: (v) => v === null || (typeof v === 'object' && !Array.isArray(v) && JSON.stringify(v).length <= 2000),
  progress: (v) => num(v) && v >= 0 && v <= 1,
  opened: (v) => v === null || (num(v) && v >= 0),
  notesId: (v) => v === null || (typeof v === 'string' && /^n-[a-z0-9]{6,40}$/.test(v)),
  scale: (v) => v === null || (num(v) && v >= 0.5 && v <= 4),
  marks: (v) => v === null || validMarks(v),
  bookmarks: (v) => v === null || validBookmarks(v),
  texts: (v) => v === null || validTexts(v),
  edits: (v) => v === null || validEdits(v),
  shelf: (v) => v === null || text(60)(v),
  series: (v) => v === null || text(120)(v),
  seriesNo: (v) => v === null || (num(v) && v >= 0 && v <= 99999),
  finished: (v) => v === null || typeof v === 'boolean',
  trashed: (v) => v === null || (num(v) && v >= 0),
};
/** Only the fields that pass: a card from another device can't put anything odd into the library. */
const cleanCard = (data) => Object.fromEntries(Object.entries(data ?? {}).filter(([key, value]) => CARD_RULES[key]?.(value)));

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

/** `opened`: the browser API's IndexedDB (a promise of the database). `library`: api.library. */
export function createAndroidSync({ android, opened, library }) {
  const waiting = new Map(); // request id → { resolve, reject }
  let nextId = 0;
  let access = null; // { token, until }
  let saved = null;
  let running = null;
  let lastError = '';
  let needsLogin = false;
  let signingIn = false;

  window.__atlasSync = {
    /** The native side's answer: { id, token } or { id, error: 'needs-login' | 'cancelled' | … }. */
    token(answer) {
      const w = waiting.get(answer?.id);
      if (!w) return;
      waiting.delete(answer.id);
      if (answer.token) w.resolve(answer.token);
      else w.reject(Object.assign(new Error(answer.error || 'failed'), { auth: answer.error === 'needs-login', code: answer.error }));
    },
  };

  /** share: with access to the files the app makes on the Drive too (Apocrypha). */
  function authorize(interactive, { share = false } = {}) {
    const id = `s${++nextId}`;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      if (share) android.shareAuthorize(id, interactive);
      else android.syncAuthorize(id, interactive);
    });
  }
  let shareAccess = null; // { token, until }: sync's token does not reach the shared files

  const store = async (name, mode = 'readonly') => (await opened).transaction(name, mode).objectStore(name);
  async function load() {
    saved ??= (await request((await store('state')).get('sync'))) ?? {};
    return saved;
  }
  async function keep(patch) {
    saved = { ...(await load()), ...patch };
    await request((await store('state', 'readwrite')).put(saved, 'sync'));
  }

  async function getToken(force = false) {
    if (!force && access && access.until > Date.now() + 60_000) return access.token;
    // Drive said no to this token: the phone forgets it, or Google would hand the same one back
    if (force && access?.token) android.syncClearToken?.(access.token);
    try {
      const token = await authorize(false);
      access = { token, until: Date.now() + 50 * 60_000 };
      needsLogin = false;
      return token;
    } catch (err) {
      if (err.auth) needsLogin = true;
      throw err;
    }
  }
  const drive = createDrive({ getToken });

  async function emailOf(token) {
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token}` } });
      return res.ok ? ((await res.json()).email ?? '') : '';
    } catch {
      return '';
    }
  }

  // ---------- the notes and library in IndexedDB, as the engine sees them ----------
  const local = {
    notes: async () => request((await store('notes')).getAll()),
    async putNote({ id, content, created, updated }) {
      const notes = await store('notes', 'readwrite');
      const old = await request(notes.get(id));
      await request(notes.put({ cursor: null, scroll: 0, ...old, id, content, created, updated }));
    },
    async createNote(content) {
      const now = Date.now();
      const note = { id: `n-${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, content, created: now, updated: now, cursor: null, scroll: 0 };
      await request((await store('notes', 'readwrite')).put(note));
      return note;
    },
    async setNoteFolder(id, folder) {
      const notes = await store('notes', 'readwrite');
      const note = await request(notes.get(id));
      if (note) await request(notes.put({ ...note, folder }));
    },
    async setNoteTrashed(id, trashed) {
      const notes = await store('notes', 'readwrite');
      const note = await request(notes.get(id));
      if (note) await request(notes.put({ ...note, trashed: trashed || 0 }));
    },
    settings: async () => settingsOf((await request((await store('state')).get('state'))) ?? {}),
    async putSettings(entries) {
      const states = await store('state', 'readwrite');
      const state = (await request(states.get('state'))) ?? {};
      const settingsAt = { ...(state.settingsAt ?? {}) };
      for (const [key, entry] of Object.entries(entries ?? {})) {
        if (!SETTING_KEYS.includes(key) || !num(entry?.at)) continue;
        state[key] = entry.value;
        settingsAt[key] = entry.at;
      }
      await request(states.put({ ...state, settingsAt }, 'state'));
    },
    async trashNote(id) {
      const t = (await opened).transaction(['notes', 'trash'], 'readwrite');
      const note = await request(t.objectStore('notes').get(id));
      if (note) {
        t.objectStore('trash').add({ ...note, deletedAt: Date.now(), bySync: true });
        t.objectStore('notes').delete(id);
      }
      await finished(t);
    },
    docs: async () => request((await store('docs')).getAll()),
    async fileHash(doc) {
      const hashes = (await load()).hashes ?? {};
      const known = hashes[doc.id];
      if (known && known.size === doc.size) return { hash: known.hash, time: known.time };
      const blob = await request((await store('docFiles')).get(doc.id));
      if (!blob) return { hash: '', time: 0 };
      const entry = { size: doc.size, hash: await hashBytes(await blob.arrayBuffer()), time: Date.now() };
      await keep({ hashes: { ...hashes, [doc.id]: entry } });
      return { hash: entry.hash, time: entry.time };
    },
    async docBytes(id) {
      const blob = await request((await store('docFiles')).get(id));
      return new Uint8Array(await blob.arrayBuffer());
    },
    async putDoc(id, data, bytes) {
      const clean = cleanCard(data);
      const t = (await opened).transaction(['docs', 'docFiles'], 'readwrite');
      const docs = t.objectStore('docs');
      const old = await request(docs.get(id));
      if (!old && !(clean.name && clean.format)) {
        t.abort();
        throw new Error(`card ${id}: no name or format`);
      }
      const doc = { size: 0, ...old, ...clean, id };
      if (bytes) {
        doc.size = bytes.length;
        t.objectStore('docFiles').put(new Blob([bytes]), id);
      }
      docs.put(doc);
      await finished(t);
      if (bytes) {
        const hashes = (await load()).hashes ?? {};
        await keep({ hashes: { ...hashes, [id]: { size: doc.size, hash: await hashBytes(bytes), time: Date.now() } } });
      }
    },
    removeDoc: (id) => library.remove(id),
    assets: async () => (await request((await store('assets')).getAllKeys())).map(String),
    async assetBytes(name) {
      const blob = await request((await store('assets')).get(name));
      return new Uint8Array(await blob.arrayBuffer());
    },
    async putAsset(name, bytes) {
      const type = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[name.split('.').pop()] ?? '';
      await request((await store('assets', 'readwrite')).put(new Blob([bytes], { type }), name));
    },
  };

  // an edited PDF keeps its size now and then: its remembered hash goes
  const replace = library.replace;
  library.replace = async (id, bytes) => {
    const hashes = { ...((await load()).hashes ?? {}) };
    delete hashes[id];
    await keep({ hashes });
    return replace.call(library, id, bytes);
  };

  return {
    async status() {
      const s = await load();
      return { available: true, signedIn: Boolean(s.signedIn), email: s.email ?? '', lastSync: s.lastSync ?? 0, running: Boolean(running), signingIn, needsLogin, error: lastError };
    },
    async signIn() {
      signingIn = true;
      try {
        const token = await authorize(true);
        access = { token, until: Date.now() + 50 * 60_000 };
        const email = await emailOf(token);
        const s = await load();
        // another account: start from nothing
        await keep(s.email && email && s.email !== email ? { signedIn: true, email, base: emptyBase(), lastSync: 0 } : { signedIn: true, email });
        needsLogin = false;
        lastError = '';
      } catch (err) {
        if (err.code !== 'cancelled') lastError = err.message;
      } finally {
        signingIn = false;
      }
      return {};
    },
    async cancel() {},
    /**
     * An access token for Apocrypha: { ok, token } or { ok: false, error }. The first time it shows
     * Google's sheet, asking for the files the app makes on the Drive.
     */
    async token(force = false) {
      if (!android.shareAuthorize) return { ok: false, error: 'needs-update' };
      if (!force && shareAccess && shareAccess.until > Date.now() + 60_000) return { ok: true, token: shareAccess.token };
      if (force && shareAccess?.token) android.syncClearToken?.(shareAccess.token);
      try {
        const token = await authorize(true, { share: true });
        shareAccess = { token, until: Date.now() + 50 * 60_000 };
        return { ok: true, token };
      } catch (err) {
        return { ok: false, error: err.code === 'cancelled' ? 'cancelled' : err.auth ? 'auth' : err.message };
      }
    },
    async signOut() {
      // Google forgets the app's access (signing in again asks for an account) and the phone its token
      const token = access?.token ?? (await authorize(false).catch(() => ''));
      access = null;
      needsLogin = false;
      lastError = '';
      await keep({ signedIn: false });
      if (token) android.syncSignOut?.(token);
    },
    run({ skipDocs = [] } = {}) {
      running ??= (async () => {
        try {
          const s = await load();
          if (!s.signedIn) return { ok: false, auth: true, error: 'not signed in' };
          const result = await syncOnce({ local, drive, base: s.base ?? emptyBase(), skipDocs });
          const { base, ...summary } = result;
          await keep({ base, lastSync: Date.now() });
          lastError = '';
          return { ok: true, ...summary, lastSync: saved.lastSync };
        } catch (err) {
          lastError = err.message;
          return { ok: false, error: err.message, auth: Boolean(err.auth), offline: Boolean(err.offline) };
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}

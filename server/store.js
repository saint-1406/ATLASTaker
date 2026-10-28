// Notes live as plain markdown files (<id>.md) so they outlive the app; timestamps, cursor positions
// and UI state sit next to them in atlas.json. Writes are atomic (temp file + rename) and serialised
// per note, and a newer write always beats an older one that is still in flight.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const ID_RE = /^n-[a-z0-9]{6,40}$/;
export const ASSET_RE = /^a-[a-z0-9]{6,40}\.(png|jpg|gif|webp)$/;
export const ASSET_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const META_FILE = 'atlas.json';
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const STATE_RULES = {
  skin: (v) => v === 'minimal' || v === 'atlas',
  theme: (v) => ['dark', 'light', 'sepia', 'dusk', 'night', 'contrast', 'system'].includes(v),
  accent: (v) => ['lime', 'cyan', 'orange', 'violet'].includes(v),
  lang: (v) => v === 'ru' || v === 'en',
  sidebar: (v) => typeof v === 'boolean',
  fontScale: (v) => typeof v === 'number' && v >= 0.7 && v <= 1.8,
  lastOpen: (v) => v === null || (typeof v === 'string' && ID_RE.test(v)),
  welcomed: (v) => typeof v === 'boolean',
  lastBackup: (v) => Number.isFinite(v) && v > 0,
  // how the reader shows a book (src/skins.js)
  readMode: (v) => v === 'scroll' || v === 'pages',
  readTurn: (v) => ['flip', 'slide', 'stack', 'fade', 'none'].includes(v),
  readFont: (v) => v === 'serif' || v === 'sans',
  readLeading: (v) => ['tight', 'normal', 'loose'].includes(v),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const tmpName = (file) => `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Windows: antivirus or the search indexer can hold a file for a moment, so renames get a few retries.
async function renameRetrying(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (!RETRYABLE.has(err.code) || attempt >= 6) throw err;
      await sleep(30 * (attempt + 1));
    }
  }
}

export async function atomicWrite(file, data, stillWanted = () => true) {
  const tmp = tmpName(file);
  await fsp.writeFile(tmp, data, 'utf8');
  if (!stillWanted()) {
    await fsp.rm(tmp, { force: true });
    return false;
  }
  try {
    await renameRetrying(tmp, file);
    return true;
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

function atomicWriteSync(file, data) {
  const tmp = tmpName(file);
  fs.writeFileSync(tmp, data, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (!RETRYABLE.has(err.code) || attempt >= 6) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(30 * (attempt + 1));
    }
  }
}

function readMeta(file) {
  const empty = { version: 1, notes: {}, state: {} };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return empty;
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      notes: parsed?.notes && typeof parsed.notes === 'object' ? parsed.notes : {},
      state: parsed?.state && typeof parsed.state === 'object' ? parsed.state : {},
    };
  } catch (err) {
    // Keep the damaged file for a human to look at; the notes themselves are untouched .md files.
    const aside = `${file}.broken-${Date.now()}`;
    fs.renameSync(file, aside);
    console.error(`atlas.json не читается (${err.message}); отложен в ${aside}`);
    return empty;
  }
}

function cleanCursor(c) {
  if (!c || !Number.isInteger(c.anchor) || !Number.isInteger(c.head)) return undefined;
  return { anchor: Math.max(0, c.anchor), head: Math.max(0, c.head) };
}

export function createStore(dir) {
  const trashDir = path.join(dir, '.trash');
  const assetsDir = path.join(dir, 'assets'); // pictures, referenced from the notes as assets/<name>
  fs.mkdirSync(trashDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  const metaPath = path.join(dir, META_FILE);
  const meta = readMeta(metaPath);
  const seq = new Map(); // id → number of the latest write; older ones give way
  const chains = new Map(); // key → promise chain serialising work on one file
  const trashed = new Set();
  let metaVersion = 0;
  let metaTimer = null;

  const fileOf = (id) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw httpError(400, 'Недопустимый id заметки');
    return path.join(dir, `${id}.md`);
  };
  const noteMeta = (id) => (meta.notes[id] ??= { created: Date.now(), updated: Date.now() });
  const bump = (id) => {
    const n = (seq.get(id) ?? 0) + 1;
    seq.set(id, n);
    return n;
  };

  function serial(key, task) {
    const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
    chains.set(key, next);
    const cleanup = () => {
      if (chains.get(key) === next) chains.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  function scheduleMeta() {
    metaVersion++;
    clearTimeout(metaTimer);
    metaTimer = setTimeout(() => {
      metaTimer = null;
      const version = metaVersion;
      const snapshot = JSON.stringify(meta, null, 1);
      serial(':meta', () => atomicWrite(metaPath, snapshot, () => version === metaVersion)).catch((err) =>
        console.error('atlas.json:', err.message),
      );
    }, 300);
  }

  function applyMeta(id, patch) {
    const m = noteMeta(id);
    const cursor = cleanCursor(patch?.cursor);
    if (cursor) m.cursor = cursor;
    if (Number.isFinite(patch?.scroll)) m.scroll = Math.max(0, Math.round(patch.scroll));
  }

  return {
    dir,

    async list() {
      const names = await fsp.readdir(dir);
      const out = [];
      await Promise.all(
        names.map(async (name) => {
          if (!name.endsWith('.md')) return;
          const id = name.slice(0, -3);
          if (!ID_RE.test(id)) return;
          const file = path.join(dir, name);
          try {
            const [content, stat] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
            const m = meta.notes[id] ?? {};
            out.push({
              id,
              content,
              created: m.created ?? Math.round(stat.birthtimeMs || stat.mtimeMs),
              updated: m.updated ?? Math.round(stat.mtimeMs),
              cursor: m.cursor ?? null,
              scroll: m.scroll ?? 0,
            });
          } catch (err) {
            console.error(`Не удалось прочитать ${name}: ${err.message}`);
          }
        }),
      );
      return out.sort((a, b) => a.created - b.created);
    },

    async create(content = '') {
      const text = typeof content === 'string' ? content : '';
      const id = `n-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
      const now = Date.now();
      meta.notes[id] = { created: now, updated: now };
      await atomicWrite(fileOf(id), text);
      scheduleMeta();
      return { id, content: text, created: now, updated: now, cursor: null, scroll: 0 };
    },

    async write(id, content) {
      const file = fileOf(id);
      if (typeof content !== 'string') throw httpError(400, 'content должен быть строкой');
      if (trashed.has(id)) throw httpError(409, 'Заметка уже в архиве');
      const n = bump(id);
      await serial(id, () => (seq.get(id) === n ? atomicWrite(file, content, () => seq.get(id) === n) : false));
      const m = noteMeta(id);
      m.updated = Date.now();
      scheduleMeta();
      return { updated: m.updated };
    },

    async setMeta(id, patch) {
      fileOf(id);
      if (trashed.has(id)) return;
      applyMeta(id, patch);
      scheduleMeta();
    },

    async trash(id) {
      const file = fileOf(id);
      bump(id);
      trashed.add(id);
      try {
        await serial(id, async () => {
          try {
            await renameRetrying(file, path.join(trashDir, `${id}-${Date.now()}.md`));
          } catch (err) {
            if (err.code !== 'ENOENT') throw err;
          }
        });
      } catch (err) {
        trashed.delete(id); // the file is still in place, so it must stay writable
        throw err;
      }
      delete meta.notes[id];
      if (meta.state.lastOpen === id) meta.state.lastOpen = null;
      scheduleMeta();
    },

    /** Saves a picture under a fresh name and returns the name. */
    async saveAsset(bytes, type) {
      const ext = ASSET_TYPES[type];
      if (!ext) throw httpError(415, 'нужна картинка PNG, JPEG, GIF или WebP');
      if (!bytes?.length) throw httpError(400, 'пустая картинка');
      const name = `a-${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}.${ext}`;
      await atomicWrite(path.join(assetsDir, name), bytes);
      return name;
    },

    assetFile(name) {
      if (typeof name !== 'string' || !ASSET_RE.test(name)) throw httpError(404, 'нет такой картинки');
      return path.join(assetsDir, name);
    },

    getState() {
      return { ...meta.state };
    },

    setState(patch) {
      if (patch && typeof patch === 'object') {
        for (const [key, value] of Object.entries(patch)) {
          if (STATE_RULES[key]?.(value)) meta.state[key] = value;
        }
        scheduleMeta();
      }
      return { ...meta.state };
    },

    /** Writes atlas.json right now (shutdown path). */
    flush() {
      clearTimeout(metaTimer);
      metaTimer = null;
      metaVersion++;
      atomicWriteSync(metaPath, JSON.stringify(meta, null, 1));
    },

    /** Resolves once every queued write has landed. */
    async idle() {
      while (chains.size) await Promise.allSettled([...chains.values()]);
    },
  };
}

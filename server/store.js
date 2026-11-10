// Notes live as plain markdown files (<id>.md) so they outlive the app; timestamps, cursor positions
// and UI state sit next to them in atlas.json. Writes are atomic (temp file + rename) and serialised
// per note, and a newer write always beats an older one that is still in flight.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { settingsOf, SETTING_KEYS, stampSettings } from '../src/sync/merge.js';
import { versionsToKeep } from '../src/versionRules.js';

export const ID_RE = /^n-[a-z0-9]{6,40}$/;
export const ASSET_RE = /^a-[a-z0-9]{6,40}\.(png|jpg|gif|webp)$/;
export const ASSET_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const META_FILE = 'atlas.json';
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const VERSION_RE = /^(\d{12,14})-(\d{1,9})\.md$/; // <time>-<characters>.md
// { 'YYYY-MM-DD': number } for at most a little over a year
const dayLog = (v, min) =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 400 && Object.entries(v).every(([k, n]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(n) && n >= min && n <= 1e7);
const base64ish = (s) => typeof s === 'string' && s.length > 0 && s.length <= 200 && /^[A-Za-z0-9+/]+=*$/.test(s);
const STATE_RULES = {
  skin: (v) => v === 'cozy' || v === 'minimal' || v === 'atlas',
  theme: (v) => ['cream', 'dark', 'light', 'sepia', 'dusk', 'night', 'contrast', 'system'].includes(v),
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
  readSpeed: (v) => typeof v === 'number' && v >= 0.5 && v <= 2,
  readFont: (v) => v === 'serif' || v === 'sans',
  readLeading: (v) => ['tight', 'normal', 'loose'].includes(v),
  // reading themes and their changes: the page checks every field (normalizeReadLook), here only the size
  readLook: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(v).length < 8000,
  // the person's picture (a small square JPEG, src/home.js shrinkPicture) and name
  avatar: (v) => v === null || (typeof v === 'string' && v.length <= 200_000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(v)),
  profileName: (v) => typeof v === 'string' && v.length <= 60,
  // the notes' folders, in order (src/noteFolders.js); notes name theirs in their meta (folder)
  noteFolders: (v) => Array.isArray(v) && v.length <= 60 && v.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 60),
  // the library's sections, in order (src/shelves.js); books name theirs on their cards
  shelves: (v) => Array.isArray(v) && v.length <= 60 && v.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 60),
  // the look the app has been moved to once (0.13: the cosy design)
  lookVersion: (v) => Number.isInteger(v) && v >= 0 && v < 100,
  // minutes read per day, for the main page's goal: { 'YYYY-MM-DD': minutes }, a few weeks kept
  readDays: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 60 && Object.values(v).every((m) => Number.isFinite(m) && m >= 0 && m < 1440),
  readGoal: (v) => Number.isInteger(v) && v >= 5 && v <= 600,
  // writing (0.17): the statistics strip over a note, the formatting bar and its tools (src/formatBar.js),
  // what focus mode dims (src/focusDim.js)
  statsBar: (v) => typeof v === 'boolean',
  formatBar: (v) => v === 'touch' || v === 'always' || v === 'off',
  formatTools: (v) => Array.isArray(v) && v.length <= 40 && v.every((s) => typeof s === 'string' && /^[a-z0-9]{1,16}$/.test(s)),
  focusDim: (v) => v === 'paragraph' || v === 'sentence' || v === 'off',
  // Markdown's marks hidden (the note as it reads, src/livePreview.js) or shown as typed
  markup: (v) => v === 'hide' || v === 'show',
  editorMode: (v) => v === 'visual' || v === 'source',
  // characters written and the text's growth, per day (src/writing.js)
  writeDays: (v) => dayLog(v, 0),
  growDays: (v) => dayLog(v, -1e7),
  // the PIN that locks the app on this device (src/lock.js): a salted PBKDF2 hash, never the PIN itself
  pinLock: (v) =>
    v === null ||
    (Boolean(v) && typeof v === 'object' && base64ish(v.salt) && base64ish(v.hash) && Number.isInteger(v.iter) && v.iter >= 10_000 && v.iter <= 5_000_000 && Number.isInteger(v.len) && v.len >= 4 && v.len <= 8 && [0, 60, 300, 900].includes(v.after)),
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
  const versionsDir = path.join(dir, '.versions'); // earlier versions of each note: .versions\<id>\<time>-<chars>.md
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
    if (typeof patch?.folder === 'string') {
      const folder = patch.folder.replace(/\s+/g, ' ').trim().slice(0, 60);
      if (folder) m.folder = folder;
      else delete m.folder;
    }
    // in the trash since then (the file stays where it is, so a note comes back whole); 0 takes it out
    if (Number.isFinite(patch?.trashed) && patch.trashed >= 0) {
      if (patch.trashed > 0) m.trashed = Math.round(patch.trashed);
      else delete m.trashed;
    }
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
              folder: m.folder ?? '',
              trashed: m.trashed ?? 0,
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

    /** A note as it came from another device (sync): created or overwritten, with its own times. */
    async putSynced(id, content, { created, updated } = {}) {
      const file = fileOf(id);
      if (typeof content !== 'string') throw httpError(400, 'content должен быть строкой');
      trashed.delete(id);
      const n = bump(id);
      await serial(id, () => (seq.get(id) === n ? atomicWrite(file, content, () => seq.get(id) === n) : false));
      const m = noteMeta(id);
      if (Number.isFinite(created)) m.created = created;
      m.updated = Number.isFinite(updated) ? updated : Date.now();
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
      // deleted for good: its earlier versions go with it
      await fsp.rm(path.join(versionsDir, id), { recursive: true, force: true }).catch(() => {});
    },

    // ---------- earlier versions of a note (src/versionRules.js) ----------

    /** The note's versions, newest first: [{ at, chars }]. */
    async versions(id) {
      fileOf(id);
      const names = await fsp.readdir(path.join(versionsDir, id)).catch(() => []);
      return names
        .map((name) => VERSION_RE.exec(name))
        .filter(Boolean)
        .map((m) => ({ at: Number(m[1]), chars: Number(m[2]) }))
        .sort((a, b) => b.at - a.at);
    },

    /** The text of one version. */
    async readVersion(id, at) {
      fileOf(id);
      const found = (await this.versions(id)).find((v) => v.at === Number(at));
      if (!found) throw httpError(404, 'нет такой версии');
      return fsp.readFile(path.join(versionsDir, id, `${found.at}-${found.chars}.md`), 'utf8');
    },

    /** Keeps the note's text as a version; those the rules no longer keep are removed. */
    async addVersion(id, content) {
      fileOf(id);
      if (typeof content !== 'string') throw httpError(400, 'нужен текст версии');
      const folder = path.join(versionsDir, id);
      await fsp.mkdir(folder, { recursive: true });
      // the same text as the newest version: that one stands for it
      const newest = (await this.versions(id))[0];
      if (newest?.chars === content.length && (await fsp.readFile(path.join(folder, `${newest.at}-${newest.chars}.md`), 'utf8').catch(() => null)) === content) return newest;
      const at = Date.now();
      await atomicWrite(path.join(folder, `${at}-${content.length}.md`), content);
      const all = await this.versions(id);
      const keep = new Set(versionsToKeep(all.map((v) => v.at), at));
      for (const v of all) if (!keep.has(v.at)) await fsp.rm(path.join(folder, `${v.at}-${v.chars}.md`), { force: true });
      return { at, chars: content.length };
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

    /** Names of all pictures (sync). */
    async assetNames() {
      return (await fsp.readdir(assetsDir)).filter((name) => ASSET_RE.test(name));
    },

    /** A picture from another device, under its own name (sync). */
    async putAsset(name, bytes) {
      if (typeof name !== 'string' || !ASSET_RE.test(name)) throw httpError(400, 'недопустимое имя картинки');
      await atomicWrite(path.join(assetsDir, name), bytes);
    },

    assetFile(name) {
      if (typeof name !== 'string' || !ASSET_RE.test(name)) throw httpError(404, 'нет такой картинки');
      return path.join(assetsDir, name);
    },

    getState() {
      return { ...meta.state };
    },

    /**
     * Changes the state. Each setting the person changes keeps when (settingsAt), so sync knows which
     * device set it last; `$quiet: true` marks a change that is not their choice (a default, a move).
     */
    setState(patch) {
      if (patch && typeof patch === 'object') {
        const accepted = Object.fromEntries(Object.entries(patch).filter(([key, value]) => STATE_RULES[key]?.(value)));
        const at = stampSettings(meta.state, accepted, { quiet: patch.$quiet === true });
        Object.assign(meta.state, accepted);
        if (Object.keys(at).length) meta.state.settingsAt = at;
        scheduleMeta();
      }
      return { ...meta.state };
    },

    /** The settings as sync sees them: { values, at }. */
    settings() {
      return settingsOf(meta.state);
    },

    /** Settings from another device (sync), each with the time it was set there. */
    putSettings(entries) {
      const at = { ...(meta.state.settingsAt ?? {}) };
      for (const [key, entry] of Object.entries(entries ?? {})) {
        if (!SETTING_KEYS.includes(key) || !Number.isFinite(entry?.at)) continue;
        // a value this version does not know is left alone, but its time is kept: it is not asked for again
        if (STATE_RULES[key]?.(entry.value)) meta.state[key] = entry.value;
        at[key] = entry.at;
      }
      meta.state.settingsAt = at;
      scheduleMeta();
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

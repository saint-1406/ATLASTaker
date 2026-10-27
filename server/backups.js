// Copies of the notes folder in <data>/backups: one each time ATLAS starts on new code (an update)
// and one a day, so neither an update nor a bad day costs more than the newest copy. A copy holds the
// .md files and atlas.json as they were; pictures are hard links, since ATLAS never rewrites them.
// Unsaved text that the page found at start and that was not put back goes to backups/несохранённое.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const DRAFTS_DIR = 'несохранённое';
const DAY = 24 * 60 * 60 * 1000;
const MARK_FILE = 'last.json';
const ABOUT_FILE = 'backup.json';

const pad = (n) => String(n).padStart(2, '0');

/** "2026-10-27 17-30" in local time: sorts by date and is a valid Windows file name. */
export function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

/** A note title as part of a file name: no characters Windows refuses, not too long. */
export function safeName(text, fallback = 'заметка') {
  const name = String(text ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '');
  return name || fallback;
}

function freePath(base, ext = '') {
  let file = `${base}${ext}`;
  for (let i = 2; fs.existsSync(file); i++) file = `${base} (${i})${ext}`;
  return file;
}

export function createBackups(dataDir, { version, build, keep = 20, keepDrafts = 50, now = Date.now } = {}) {
  const dir = path.join(dataDir, 'backups');
  const notesDir = path.join(dataDir, 'notes');
  const draftsDir = path.join(dir, DRAFTS_DIR);
  const markFile = path.join(dir, MARK_FILE);
  let lastAt = 0;
  let queue = Promise.resolve();
  const serial = (task) => (queue = queue.catch(() => {}).then(task));

  async function readMark() {
    try {
      return JSON.parse(await fsp.readFile(markFile, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Copies the notes folder; null when there is nothing to copy yet. */
  async function snapshot(reason, from) {
    const names = await fsp.readdir(notesDir).catch(() => []);
    const notes = names.filter((name) => name.endsWith('.md'));
    if (!notes.length) return null;
    const at = now();
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.tmp-${crypto.randomBytes(4).toString('hex')}`);
    try {
      await fsp.mkdir(path.join(tmp, 'assets'), { recursive: true });
      for (const name of [...notes, 'atlas.json']) {
        await fsp.copyFile(path.join(notesDir, name), path.join(tmp, name)).catch((err) => {
          if (err.code !== 'ENOENT') throw err; // a note trashed meanwhile is simply not in this copy
        });
      }
      for (const name of await fsp.readdir(path.join(notesDir, 'assets')).catch(() => [])) {
        const source = path.join(notesDir, 'assets', name);
        const target = path.join(tmp, 'assets', name);
        await fsp.link(source, target).catch(() => fsp.copyFile(source, target));
      }
      const about = { reason, at, from: { version: from?.version ?? null, build: from?.build ?? null }, to: { version, build }, notes: notes.length };
      await fsp.writeFile(path.join(tmp, ABOUT_FILE), JSON.stringify(about, null, 1));
      const target = freePath(path.join(dir, `${stamp(at)} ${reason}`));
      await fsp.rename(tmp, target);
      lastAt = at;
      await prune();
      return target;
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  /** Copies beyond the newest `keep` go; folders ATLAS did not make (no backup.json) are left alone. */
  async function prune() {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const copies = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(dir, e.name, ABOUT_FILE)))
      .map((e) => e.name)
      .sort();
    for (const name of copies.slice(0, Math.max(0, copies.length - keep))) {
      await fsp.rm(path.join(dir, name), { recursive: true, force: true });
    }
  }

  async function pruneDrafts() {
    const files = (await fsp.readdir(draftsDir)).filter((name) => name.endsWith('.md')).sort();
    for (const name of files.slice(0, Math.max(0, files.length - keepDrafts))) {
      await fsp.rm(path.join(draftsDir, name), { force: true });
    }
  }

  async function mark() {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(markFile, JSON.stringify({ version, build, at: lastAt }));
  }

  return {
    dir,
    draftsDir,

    /** On start: a copy when the code changed since the last run (an update), else when a day has passed. */
    atStart: () =>
      serial(async () => {
        const last = await readMark();
        lastAt = last?.at ?? 0;
        for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (e.isDirectory() && e.name.startsWith('.tmp-')) await fsp.rm(path.join(dir, e.name), { recursive: true, force: true });
        }
        let made = null;
        if (last?.build !== build) made = await snapshot('до обновления', last);
        else if (now() - lastAt >= DAY) made = await snapshot('ежедневная', last);
        await mark();
        return made;
      }),

    /** For a server that stays up for days: the daily copy without a restart. */
    daily: () =>
      serial(async () => {
        if (now() - lastAt < DAY) return null;
        const made = await snapshot('ежедневная', { version, build });
        if (made) await mark();
        return made;
      }),

    /** Keeps a piece of text as its own .md file and returns the file name. */
    async keepDraft({ title, content, at, label } = {}) {
      if (typeof content !== 'string') throw Object.assign(new Error('content должен быть строкой'), { status: 400 });
      await fsp.mkdir(draftsDir, { recursive: true });
      const when = Number.isFinite(at) && at > 0 ? at : now();
      const tail = label ? ` (${safeName(label, '')})` : '';
      const file = freePath(path.join(draftsDir, `${stamp(when)} ${safeName(title)}${tail}`), '.md');
      await fsp.writeFile(file, content, 'utf8');
      await pruneDrafts();
      return path.basename(file);
    },
  };
}

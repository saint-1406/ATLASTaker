// The library on disk: each document as it came, <data>/library/<id>.<format>, and its card (title,
// author, a small cover picture, where the reader stopped) in library.json next to them. A removed
// document goes to library/.trash; quotes taken from it stay in the notes.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, ID_RE } from './store.js';

export const DOC_ID_RE = /^d-[a-z0-9]{6,40}$/;
export const DOC_FORMATS = ['pdf', 'epub', 'fb2', 'docx', 'md', 'txt', 'html'];
export const MAX_DOC = 300 * 1024 * 1024;
const COVER_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

const text = (max) => (v) => typeof v === 'string' && v.length <= max;
/** What the page may change on a card, and what each value may be. */
const RULES = {
  title: text(300),
  author: text(300),
  cover: (v) => v === null || (typeof v === 'string' && v.length <= 400_000 && COVER_RE.test(v)),
  position: (v) => v === null || (typeof v === 'object' && !Array.isArray(v) && JSON.stringify(v).length <= 2000),
  progress: (v) => Number.isFinite(v) && v >= 0 && v <= 1,
  opened: (v) => Number.isFinite(v) && v > 0,
  notesId: (v) => v === null || (typeof v === 'string' && ID_RE.test(v)),
  scale: (v) => Number.isFinite(v) && v >= 0.5 && v <= 4,
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const cleanName = (name) =>
  String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

export function createLibrary(dataDir) {
  const dir = path.join(dataDir, 'library');
  const trashDir = path.join(dir, '.trash');
  const metaPath = path.join(dir, 'library.json');
  fs.mkdirSync(trashDir, { recursive: true });
  const docs = read();
  let chain = Promise.resolve();
  let timer = null;

  function read() {
    let raw;
    try {
      raw = fs.readFileSync(metaPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed?.docs && typeof parsed.docs === 'object' ? parsed.docs : {};
    } catch (err) {
      // the documents themselves are untouched files; only the cards are lost
      const aside = `${metaPath}.broken-${Date.now()}`;
      fs.renameSync(metaPath, aside);
      console.error(`library.json не читается (${err.message}); отложен в ${aside}`);
      return {};
    }
  }

  const writeNow = () => {
    const snapshot = JSON.stringify({ version: 1, docs }, null, 1);
    chain = chain.then(() => atomicWrite(metaPath, snapshot)).catch((err) => console.error('library.json:', err.message));
  };

  // the reader saves its place every few seconds: writes are gathered, one file write at a time
  function save() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      writeNow();
    }, 250);
  }

  const fileOf = (doc) => path.join(dir, `${doc.id}.${doc.format}`);
  function get(id) {
    if (typeof id !== 'string' || !DOC_ID_RE.test(id) || !Object.hasOwn(docs, id)) throw httpError(404, 'нет такого документа');
    return docs[id];
  }

  return {
    dir,

    list: () => Object.values(docs),

    async add(bytes, { name, format }) {
      if (!DOC_FORMATS.includes(format)) throw httpError(415, 'такой формат библиотека не читает');
      if (!bytes?.length) throw httpError(400, 'пустой файл');
      const now = Date.now();
      const doc = {
        id: `d-${now.toString(36)}${crypto.randomBytes(4).toString('hex')}`,
        name: cleanName(name) || 'document',
        format,
        title: '',
        author: '',
        cover: null,
        size: bytes.length,
        added: now,
        opened: 0,
        progress: 0,
        position: null,
        notesId: null,
        scale: 1,
      };
      await atomicWrite(fileOf(doc), bytes);
      docs[doc.id] = doc;
      save();
      return doc;
    },

    file: (id) => fileOf(get(id)),

    update(id, patch) {
      const doc = get(id);
      if (patch && typeof patch === 'object') {
        for (const [key, value] of Object.entries(patch)) if (RULES[key]?.(value)) doc[key] = value;
      }
      save();
      return doc;
    },

    async remove(id) {
      const doc = get(id);
      try {
        await fsp.rename(fileOf(doc), path.join(trashDir, `${doc.id}-${Date.now()}.${doc.format}`));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      delete docs[id];
      save();
    },

    /** Writes library.json now if a write is waiting (shutdown), and waits for it. */
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        writeNow();
      }
      await chain;
    },
  };
}

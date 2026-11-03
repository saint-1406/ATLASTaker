// The library on disk: each document as it came, <data>/library/<id>.<format>, and its card (title,
// author, a small cover picture, where the reader stopped) in library.json next to them. A removed
// document goes to library/.trash; quotes taken from it stay in the notes.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, ID_RE } from './store.js';
import { validBookmarks, validEdits, validMarks, validTexts } from '../src/marks.js';

export const DOC_ID_RE = /^d-[a-z0-9]{6,40}$/;
export const DOC_FORMATS = ['pdf', 'epub', 'fb2', 'docx', 'odt', 'rtf', 'md', 'txt', 'html', 'cbz', 'img'];
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
  marks: (v) => validMarks(v) && JSON.stringify(v).length <= 4_000_000,
  bookmarks: (v) => validBookmarks(v) && JSON.stringify(v).length <= 1_000_000,
  texts: (v) => validTexts(v) && JSON.stringify(v).length <= 4_000_000,
  edits: (v) => validEdits(v) && JSON.stringify(v).length <= 4_000_000,
  // the section of the library the document sits in ('' — none) and whether it was read to the end
  shelf: text(60),
  finished: (v) => typeof v === 'boolean',
  // in the trash since then (null or 0: on the shelf); the file stays, so the document comes back whole
  trashed: (v) => v === null || (Number.isFinite(v) && v >= 0),
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
        marks: [],
        bookmarks: [],
        texts: [],
        edits: [],
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

    /** A new version of a document's file (an edited PDF); the old one waits in .trash. */
    async replace(id, bytes) {
      const doc = get(id);
      if (!bytes?.length) throw httpError(400, 'пустой файл');
      if (bytes.length > MAX_DOC) throw httpError(413, 'файл слишком большой');
      try {
        await fsp.copyFile(fileOf(doc), path.join(trashDir, `${doc.id}-${Date.now()}.${doc.format}`));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      await atomicWrite(fileOf(doc), bytes);
      doc.size = bytes.length;
      save();
      return doc;
    },

    /** A card (and, when given, the file) as it came from another device (sync); the old file waits in .trash. */
    async putSynced(id, data, bytes) {
      if (typeof id !== 'string' || !DOC_ID_RE.test(id)) throw httpError(400, 'недопустимый id документа');
      const known = Object.hasOwn(docs, id) ? docs[id] : null;
      const format = known?.format ?? data?.format;
      if (!DOC_FORMATS.includes(format)) throw httpError(415, 'такой формат библиотека не читает');
      // an empty file is still a file: another device has it, and it is kept as it came
      if (!known && !bytes) throw httpError(400, 'нет файла документа');
      const doc = known ?? { id, format, name: 'document', title: '', author: '', cover: null, size: 0, added: Date.now(), opened: 0, progress: 0, position: null, notesId: null, scale: 1, marks: [], bookmarks: [], texts: [], edits: [] };
      if (bytes) {
        if (known) {
          await fsp.copyFile(fileOf(doc), path.join(trashDir, `${id}-${Date.now()}.${format}`)).catch((err) => {
            if (err.code !== 'ENOENT') throw err;
          });
        }
        await atomicWrite(fileOf(doc), bytes);
        doc.size = bytes.length;
      }
      if (data && typeof data === 'object') {
        for (const [key, value] of Object.entries(data)) if (RULES[key]?.(value)) doc[key] = value;
        if (typeof data.name === 'string' && data.name) doc.name = cleanName(data.name) || doc.name;
        if (Number.isFinite(data.added) && data.added > 0) doc.added = data.added;
      }
      docs[id] = doc;
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

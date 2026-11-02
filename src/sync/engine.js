// One round of syncing: read what Drive has, put it together with what this device has (merge.js),
// write the result to both sides. The same code runs on Windows (in the local server, server/sync.js)
// and on Android (in the page, src/sync/android.js); each gives it a `local` side:
//
//   notes()                         → [{ id, content, created, updated, folder }]
//   putNote({ id, content, created, updated })   creates or overwrites a note as it came from Drive
//   createNote(content)             → { id, created, updated }   a fresh note (the other half of a conflict)
//   trashNote(id)
//   setNoteFolder(id, folder)       moves a note to a folder ('' for none) as Drive has it
//   docs()                          → library cards (with id, format)
//   fileHash(doc)                   → { hash, time }   hashBytes() of the document's file, cached as it likes
//   docBytes(id)                    → Uint8Array
//   putDoc(id, data, bytes | null)  creates or updates a card (cardData fields), and its file when given
//   removeDoc(id)
//   assets()                        → [name]   pictures in notes
//   assetBytes(name) / putAsset(name, bytes)
//
// On Drive (appDataFolder):
//   index.json           { version, notes: { id: { hash, created, updated } | { deleted } },
//                          docs: { id: { card, file, fileTime, format } | { deleted } }, assets: [name],
//                          folders: { id: folder } }   — the notes' folders; none listed: in no folder
//   note-<id>.md         a note's text
//   card-<id>.json       a document's card: title, author, cover, place, marks, bookmarks…
//   doc-<id>.<format>    the document itself
//   asset-<name>         a picture from a note
// Files are written before the index that points at them, so a sync cut short leaves Drive readable,
// and the next round simply does the rest.

import { cardData, cardSigs, fingerprint, mergeCard, mergeFolder, planDocs, planNotes, sig, stableJson } from './merge.js';

export const INDEX = 'index.json';
const MIME = { md: 'text/markdown; charset=UTF-8', json: 'application/json; charset=UTF-8' };

/** SHA-256 of bytes as hex: the same in Node and in a browser. */
export async function hashBytes(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const emptyBase = () => ({ notes: {}, docs: {}, assets: [], folders: {} });
const emptyIndex = () => ({ version: 1, notes: {}, docs: {}, assets: [], folders: null });

function cleanIndex(raw) {
  const out = emptyIndex();
  if (raw && typeof raw === 'object') {
    if (raw.notes && typeof raw.notes === 'object') out.notes = raw.notes;
    if (raw.docs && typeof raw.docs === 'object') out.docs = raw.docs;
    if (Array.isArray(raw.assets)) out.assets = raw.assets.filter((n) => typeof n === 'string');
    // an index written by a version without folders has none at all: that says nothing about them
    if (raw.folders && typeof raw.folders === 'object' && !Array.isArray(raw.folders)) {
      out.folders = Object.fromEntries(Object.entries(raw.folders).filter(([, v]) => typeof v === 'string' && v));
    }
  }
  return out;
}

/**
 * Runs one sync. `base` is what the previous round left (emptyBase() the first time); the result
 * carries the next one, to be kept by the caller. `skipDocs`: ids of documents open right now — they
 * wait for the next round. Returns { base, pulled, trashed, conflicts, docsChanged, skippedDocs, sent,
 * received }; skippedDocs: [{ id, title, error }], documents this device would not take this time.
 */
export async function syncOnce({ local, drive, base: oldBase, skipDocs = [], now = Date.now() }) {
  const base = { ...emptyBase(), ...(oldBase ?? {}) };
  const result = { pulled: [], trashed: [], conflicts: [], docsChanged: false, skippedDocs: [], sent: 0, received: 0 };

  // what is on Drive; of two files with one name (two devices at the same moment) the newer counts
  const files = (await drive.list()).sort((a, b) => String(a.modifiedTime).localeCompare(String(b.modifiedTime)));
  const byName = new Map();
  const extra = [];
  for (const f of files) {
    if (byName.has(f.name)) extra.push(byName.get(f.name));
    byName.set(f.name, f);
  }
  let index = emptyIndex();
  if (byName.has(INDEX)) {
    try {
      index = cleanIndex(JSON.parse(await drive.text(byName.get(INDEX).id)));
    } catch (err) {
      if (err.status || err.offline) throw err;
      // a damaged index: everything here goes up again, nothing is deleted
    }
  }
  const before = stableJson(index);
  const next = { notes: { ...index.notes }, docs: { ...index.docs }, assets: [...index.assets] };
  const nextBase = emptyBase();

  async function upload(name, data, type) {
    const id = await drive.put(name, data, { id: byName.get(name)?.id ?? '', type });
    byName.set(name, { id, name });
    result.sent++;
  }
  async function download(name, asText) {
    const f = byName.get(name);
    if (!f) return null;
    result.received++;
    return asText ? drive.text(f.id) : drive.bytes(f.id);
  }
  async function drop(name) {
    const f = byName.get(name);
    if (!f) return;
    byName.delete(name);
    await drive.remove(f.id);
  }

  // ---- notes ----
  const notes = new Map((await local.notes()).map((n) => [n.id, { ...n, hash: fingerprint(n.content) }]));
  const sendNote = async (note) => {
    await upload(`note-${note.id}.md`, note.content, MIME.md);
    next.notes[note.id] = { hash: note.hash, created: note.created, updated: note.updated };
    nextBase.notes[note.id] = note.hash;
  };
  const takeNote = async (id) => {
    const r = index.notes[id];
    const content = await download(`note-${id}.md`, true);
    if (content === null) return false;
    const hash = fingerprint(content);
    await local.putNote({ id, content, created: r.created ?? now, updated: r.updated ?? now });
    next.notes[id] = { ...r, hash };
    nextBase.notes[id] = hash;
    result.pulled.push(id);
    return true;
  };
  const copyOf = async (content, folder = '') => {
    const fresh = await local.createNote(content);
    if (folder) {
      await local.setNoteFolder(fresh.id, folder);
      fresh.folder = folder;
      notes.set(fresh.id, { ...fresh, content });
    }
    await sendNote({ ...fresh, content, hash: fingerprint(content) });
    return fresh.id;
  };

  for (const step of planNotes(Object.fromEntries(notes), index.notes, base.notes)) {
    const { id } = step;
    const mine = notes.get(id);
    switch (step.op) {
      case 'same':
        nextBase.notes[id] = step.hash;
        break;
      case 'pull':
        // the text is missing on Drive (cut short mid-way): ours goes up, or the note waits
        if (!(await takeNote(id)) && mine) await sendNote(mine);
        break;
      case 'push':
        await sendNote(mine);
        break;
      case 'trash':
        await local.trashNote(id);
        result.trashed.push(id);
        break;
      case 'delete':
        next.notes[id] = { deleted: now };
        await drop(`note-${id}.md`);
        break;
      case 'conflict': {
        const theirs = await download(`note-${id}.md`, true);
        if (theirs === null) {
          await sendNote(mine);
          break;
        }
        if (step.keep === 'local') {
          await sendNote(mine);
          result.conflicts.push({ id, copy: await copyOf(theirs, index.folders?.[id] ?? '') });
        } else {
          result.conflicts.push({ id, copy: await copyOf(mine.content, mine.folder ?? '') });
          await takeNote(id);
        }
        break;
      }
      default: // forget
    }
  }

  // ---- the notes' folders: each on its own, the side that moved a note wins ----
  const folders = { ...(index.folders ?? {}) };
  for (const id of Object.keys(folders)) if (!(id in next.notes) || next.notes[id].deleted) delete folders[id];
  for (const id of Object.keys(nextBase.notes)) {
    const mine = notes.get(id)?.folder ?? '';
    const theirs = index.folders ? (index.folders[id] ?? '') : mine;
    const merged = mergeFolder(mine, theirs, base.folders?.[id]);
    if (merged !== mine) await local.setNoteFolder(id, merged);
    if (merged) {
      folders[id] = merged;
      nextBase.folders[id] = merged;
    } else delete folders[id];
  }

  // ---- library ----
  const skip = new Set(skipDocs);
  const docs = new Map();
  const docMeta = {};
  for (const doc of await local.docs()) {
    if (skip.has(doc.id)) continue;
    const data = cardData(doc);
    const file = await local.fileHash(doc);
    docs.set(doc.id, data);
    docMeta[doc.id] = { card: sig(data), file: file.hash, fileTime: file.time };
  }
  const without = (map) => Object.fromEntries(Object.entries(map).filter(([id]) => !skip.has(id)));
  for (const id of skip) {
    if (base.docs[id]) nextBase.docs[id] = base.docs[id];
  }
  const remember = (id, data, file, fileTime) => {
    const card = sig(data);
    next.docs[id] = { card, file, fileTime, format: data.format };
    nextBase.docs[id] = { card, file, sigs: cardSigs(data) };
  };
  // A document this device refuses (its library says no) waits for the next round instead of stopping
  // this one: the notes and the other documents still go through, and the index still gets written.
  const takeDoc = async (id, data, bytes) => {
    try {
      await local.putDoc(id, data, bytes);
      return true;
    } catch (err) {
      result.skippedDocs.push({ id, title: data?.title || data?.name || '', error: err.message });
      return false;
    }
  };
  const sendDoc = async (id, data, withFile) => {
    if (withFile) await upload(`doc-${id}.${data.format}`, await local.docBytes(id), 'application/octet-stream');
    await upload(`card-${id}.json`, JSON.stringify(data), MIME.json);
  };

  for (const step of planDocs(docMeta, without(index.docs), without(base.docs))) {
    const { id } = step;
    const mine = docs.get(id);
    const meta = docMeta[id];
    const r = index.docs[id];
    switch (step.op) {
      case 'same':
        nextBase.docs[id] = { card: meta.card, file: meta.file, sigs: cardSigs(mine) };
        break;
      case 'merge': {
        const raw = await download(`card-${id}.json`, true);
        const theirs = raw === null ? mine : JSON.parse(raw);
        const merged = mergeCard(mine, theirs, base.docs[id]?.sigs);
        let file = meta.file;
        let fileTime = meta.fileTime;
        let bytes = null;
        if (step.file === 'pull') {
          bytes = await download(`doc-${id}.${r.format ?? theirs.format}`, false);
          if (bytes) ({ file, fileTime } = r);
        }
        if (bytes || sig(merged) !== meta.card) {
          if (!(await takeDoc(id, merged, bytes))) break;
          result.docsChanged = true;
        }
        if (step.file === 'push') await upload(`doc-${id}.${merged.format}`, await local.docBytes(id), 'application/octet-stream');
        if (sig(merged) !== r.card || raw === null) await upload(`card-${id}.json`, JSON.stringify(merged), MIME.json);
        remember(id, merged, file, fileTime);
        break;
      }
      case 'push':
        await sendDoc(id, mine, !r || r.deleted || r.file !== meta.file || !byName.has(`doc-${id}.${mine.format}`));
        remember(id, mine, meta.file, meta.fileTime);
        break;
      case 'pull': {
        const raw = await download(`card-${id}.json`, true);
        const bytes = raw === null ? null : await download(`doc-${id}.${r.format}`, false);
        if (!bytes) break; // half-written by another device: next time
        const data = cardData(JSON.parse(raw));
        if (!(await takeDoc(id, data, bytes))) break;
        result.docsChanged = true;
        remember(id, data, r.file, r.fileTime);
        break;
      }
      case 'trash':
        await local.removeDoc(id);
        result.docsChanged = true;
        break;
      case 'delete':
        next.docs[id] = { deleted: now };
        await drop(`card-${id}.json`);
        await drop(`doc-${id}.${r.format}`);
        break;
      default: // forget
    }
  }

  // ---- pictures in notes: they never change, so both sides simply get all of them ----
  const mineAssets = new Set(await local.assets());
  const theirAssets = new Set(index.assets);
  for (const name of mineAssets) {
    if (theirAssets.has(name)) continue;
    await upload(`asset-${name}`, await local.assetBytes(name), 'application/octet-stream');
    next.assets.push(name);
  }
  for (const name of theirAssets) {
    if (mineAssets.has(name)) continue;
    const bytes = await download(`asset-${name}`, false);
    if (bytes) await local.putAsset(name, bytes);
  }
  nextBase.assets = [...new Set([...mineAssets, ...theirAssets])];

  const index2 = { version: 1, notes: next.notes, docs: next.docs, assets: [...new Set(next.assets)].sort(), folders };
  if (stableJson(index2) !== before) await upload(INDEX, JSON.stringify(index2), MIME.json);
  // older twins of a file: their content is already part of what was just written
  for (const f of extra) await drive.remove(f.id).catch(() => {});

  return { ...result, base: nextBase };
}

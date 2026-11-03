// One round of syncing: read what Drive has, put it together with what this device has (merge.js),
// write the result to both sides. The same code runs on Windows (in the local server, server/sync.js)
// and on Android (in the page, src/sync/android.js); each gives it a `local` side:
//
//   notes()                         → [{ id, content, created, updated, folder, trashed }]
//   putNote({ id, content, created, updated })   creates or overwrites a note as it came from Drive
//   createNote(content)             → { id, created, updated }   a fresh note (the other half of a conflict)
//   trashNote(id)                   gone for good elsewhere (deleted from a trash, or by an older app)
//   setNoteFolder(id, folder)       moves a note to a folder ('' for none) as Drive has it
//   setNoteTrashed(id, time)        puts a note in the trash (when) or takes it out (0), as Drive has it
//   settings()                      → { values: { key: value }, at: { key: time } }   (optional)
//   putSettings({ key: { value, at } })                settings as they came from another device
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
//                          folders: { id: folder },   — the notes' folders; none listed: in no folder
//                          trashed: { id: time },     — notes in the trash, and since when
//                          settings: { key: time } }  — when each setting in settings.json was set
//   settings.json        { values: { key: value }, at: { key: time } }   look, language, reading, profile…
//   note-<id>.md         a note's text
//   card-<id>.json       a document's card: title, author, cover, place, marks, bookmarks…
//   doc-<id>.<format>    the document itself
//   asset-<name>         a picture from a note
// Files are written before the index that points at them, so a sync cut short leaves Drive readable,
// and the next round simply does the rest.

import { cardData, cardSigs, fingerprint, mergeCard, mergeFolder, mergeSettings, mergeTrashed, planDocs, planNotes, sig, SETTING_KEYS, stableJson } from './merge.js';

export const INDEX = 'index.json';
export const SETTINGS = 'settings.json';
const MIME = { md: 'text/markdown; charset=UTF-8', json: 'application/json; charset=UTF-8' };

/** SHA-256 of bytes as hex: the same in Node and in a browser. */
export async function hashBytes(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const emptyBase = () => ({ notes: {}, docs: {}, assets: [], folders: {}, trashed: {} });
const emptyIndex = () => ({ version: 1, notes: {}, docs: {}, assets: [], folders: null, trashed: null, settings: null });
const isMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function cleanIndex(raw) {
  const out = emptyIndex();
  if (raw && typeof raw === 'object') {
    if (raw.notes && typeof raw.notes === 'object') out.notes = raw.notes;
    if (raw.docs && typeof raw.docs === 'object') out.docs = raw.docs;
    if (Array.isArray(raw.assets)) out.assets = raw.assets.filter((n) => typeof n === 'string');
    // an index written by an older version has no folders, trash or settings at all: that says nothing about them
    if (isMap(raw.folders)) out.folders = Object.fromEntries(Object.entries(raw.folders).filter(([, v]) => typeof v === 'string' && v));
    if (isMap(raw.trashed)) out.trashed = Object.fromEntries(Object.entries(raw.trashed).filter(([, v]) => Number.isFinite(v) && v > 0));
    if (isMap(raw.settings)) out.settings = Object.fromEntries(Object.entries(raw.settings).filter(([k, v]) => SETTING_KEYS.includes(k) && Number.isFinite(v)));
  }
  return out;
}

/**
 * Runs one sync (see syncRound). Another device may write the index while this round runs; then
 * the round starts over from what that device wrote, so neither side's changes are lost.
 */
export async function syncOnce(args) {
  const earlier = []; // what rounds that started over had already done here: it counts too
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await syncRound({ ...args, checkIndex: attempt < 2 });
      for (const r of earlier) {
        result.pulled = [...new Set([...r.pulled, ...result.pulled])];
        result.trashed = [...new Set([...r.trashed, ...result.trashed])];
        result.conflicts = [...r.conflicts, ...result.conflicts];
        result.settingsChanged = [...new Set([...r.settingsChanged, ...result.settingsChanged])];
        result.docsChanged ||= r.docsChanged;
        result.trashChanged ||= r.trashChanged;
        result.sent += r.sent;
        result.received += r.received;
      }
      return result;
    } catch (err) {
      if (!err.again) throw err;
      earlier.push(err.partial);
    }
  }
}

/**
 * Runs one sync. `base` is what the previous round left (emptyBase() the first time); the result
 * carries the next one, to be kept by the caller. `skipDocs`: ids of documents open right now — they
 * wait for the next round. Returns { base, pulled, trashed, conflicts, docsChanged, skippedDocs, sent,
 * received, trashChanged, settingsChanged }; skippedDocs: [{ id, title, error }], documents this device
 * would not take this time; trashChanged: notes went in or out of the trash here; settingsChanged: keys
 * whose value came from another device.
 */
async function syncRound({ local, drive, base: oldBase, skipDocs = [], now = Date.now(), checkIndex = false }) {
  const base = { ...emptyBase(), ...(oldBase ?? {}) };
  const result = { pulled: [], trashed: [], conflicts: [], docsChanged: false, skippedDocs: [], sent: 0, received: 0, trashChanged: false, settingsChanged: [], skippedAssets: 0 };

  // what is on Drive; of two files with one name (two devices at the same moment) the newer counts
  const files = (await drive.list()).sort((a, b) => String(a.modifiedTime).localeCompare(String(b.modifiedTime)));
  const byName = new Map();
  const extra = [];
  for (const f of files) {
    if (byName.has(f.name)) extra.push(byName.get(f.name));
    byName.set(f.name, f);
  }
  let index = emptyIndex();
  const indexFile = byName.get(INDEX); // what this round started from; checked again before writing
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

  // ---- the trash: a note in it is still a note, it only waits there; in or out moves like a folder ----
  const trashed = { ...(index.trashed ?? {}) };
  for (const id of Object.keys(trashed)) if (!(id in next.notes) || next.notes[id].deleted) delete trashed[id];
  for (const id of Object.keys(nextBase.notes)) {
    const mine = notes.get(id)?.trashed || 0;
    const theirs = index.trashed ? index.trashed[id] || 0 : mine;
    const merged = mergeTrashed(mine, theirs, base.trashed?.[id]);
    if (merged !== mine) {
      await local.setNoteTrashed(id, merged);
      result.trashChanged = true;
    }
    if (merged) {
      trashed[id] = merged;
      nextBase.trashed[id] = merged;
    } else delete trashed[id];
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
  // one picture that will not go (unreadable here, refused there) waits for the next round, like a document
  const mineAssets = new Set(await local.assets());
  const theirAssets = new Set(index.assets);
  for (const name of mineAssets) {
    if (theirAssets.has(name)) continue;
    try {
      await upload(`asset-${name}`, await local.assetBytes(name), 'application/octet-stream');
      next.assets.push(name);
    } catch (err) {
      if (err.auth || err.offline) throw err;
      result.skippedAssets++;
    }
  }
  for (const name of theirAssets) {
    if (mineAssets.has(name)) continue;
    try {
      const bytes = await download(`asset-${name}`, false);
      if (bytes) await local.putAsset(name, bytes);
    } catch (err) {
      if (err.auth || err.offline) throw err;
      result.skippedAssets++;
    }
  }
  nextBase.assets = [...new Set([...mineAssets, ...theirAssets])];

  // ---- settings: read and written only when one side set something the other has not seen ----
  let settings = index.settings;
  if (local.settings) {
    const mine = await local.settings();
    const remoteAt = index.settings ?? {};
    const keys = SETTING_KEYS.filter((key) => key in mine.values || key in remoteAt);
    // settled: both sides know the same time (a value this version refused stays settled, not asked for again)
    if (keys.some((key) => (key in remoteAt ? remoteAt[key] !== mine.at[key] : key in mine.values))) {
      let remote = { values: {}, at: {} };
      const raw = await download(SETTINGS, true);
      try {
        const parsed = raw === null ? null : JSON.parse(raw);
        if (isMap(parsed?.values) && isMap(parsed?.at)) remote = { values: parsed.values, at: parsed.at };
      } catch {
        // a damaged file: this device's settings go up again
      }
      const merged = mergeSettings(mine, remote);
      if (Object.keys(merged.toLocal).length) {
        await local.putSettings(merged.toLocal);
        result.settingsChanged = Object.keys(merged.toLocal).filter((key) => !(key in mine.values) || sig(merged.values[key]) !== sig(mine.values[key]));
      }
      if (merged.upload) await upload(SETTINGS, JSON.stringify({ values: merged.values, at: merged.at }), MIME.json);
      settings = merged.at;
    } else settings = remoteAt;
  }

  const index2 = { version: 1, notes: next.notes, docs: next.docs, assets: [...new Set(next.assets)].sort(), folders, trashed, settings };
  if (stableJson(index2) !== before) {
    // another device wrote the index since this round read it: start over from what it wrote
    if (checkIndex && indexFile && drive.modified) {
      const latest = await drive.modified(indexFile.id);
      if (latest && indexFile.modifiedTime && latest !== indexFile.modifiedTime) throw Object.assign(new Error('index changed'), { again: true, partial: result });
    }
    await upload(INDEX, JSON.stringify(index2), MIME.json);
  }
  // older twins of a file: their content is already part of what was just written
  for (const f of extra) await drive.remove(f.id).catch(() => {});

  return { ...result, base: nextBase };
}

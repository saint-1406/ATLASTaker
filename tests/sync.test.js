import test from 'node:test';
import assert from 'node:assert/strict';
import { cardData, cardSigs, fingerprint, mergeCard, mergeItems, planDocs, planNotes } from '../src/sync/merge.js';
import { emptyBase, hashBytes, syncOnce } from '../src/sync/engine.js';

// ---------- the rules ----------

test('notes: one-sided changes travel, both-sided ones keep both', () => {
  const local = { a: { hash: 'A1', updated: 5 }, b: { hash: 'B2', updated: 5 }, c: { hash: 'C2', updated: 9 }, n: { hash: 'N', updated: 1 } };
  const remote = { a: { hash: 'A2', updated: 6 }, b: { hash: 'B1', updated: 1 }, c: { hash: 'C3', updated: 3 }, r: { hash: 'R', updated: 1 } };
  const base = { a: 'A1', b: 'B1', c: 'C1' };
  const ops = Object.fromEntries(planNotes(local, remote, base).map((s) => [s.id, s]));
  assert.equal(ops.a.op, 'pull');
  assert.equal(ops.b.op, 'push');
  assert.deepEqual(ops.c, { op: 'conflict', id: 'c', keep: 'local' });
  assert.equal(ops.n.op, 'push', 'new here');
  assert.equal(ops.r.op, 'pull', 'new there');
});

test('notes: a deletion wins only over an untouched copy', () => {
  const ops = (local, remote, base) => planNotes(local, remote, base).map((s) => s.op);
  assert.deepEqual(ops({ x: { hash: 'X' } }, { x: { deleted: 1 } }, { x: 'X' }), ['trash']);
  assert.deepEqual(ops({ x: { hash: 'X2' } }, { x: { deleted: 1 } }, { x: 'X' }), ['push'], 'edited here after it was deleted there');
  assert.deepEqual(ops({}, { x: { hash: 'X' } }, { x: 'X' }), ['delete']);
  assert.deepEqual(ops({}, { x: { hash: 'X2' } }, { x: 'X' }), ['pull'], 'edited there after it was deleted here');
  assert.deepEqual(ops({}, { x: { deleted: 1 } }, { x: 'X' }), ['forget']);
  assert.deepEqual(ops({ x: { hash: 'X' } }, {}, { x: 'X' }), ['push'], 'Drive lost it: goes up again');
});

test('marks and bookmarks: new from both sides, removals respected', () => {
  const m = (id, note = '', created = 1) => ({ id, note, created });
  const base = cardSigs({ marks: [m('m-keep'), m('m-gone'), m('m-edit')] }).marks;
  const local = [m('m-keep'), m('m-edit', 'changed here'), m('m-mine', '', 3)];
  const remote = [m('m-keep'), m('m-gone'), m('m-edit'), m('m-theirs', '', 2)];
  // m-gone: removed here, untouched there → stays removed
  assert.deepEqual(
    mergeItems(local, remote, base).map((x) => [x.id, x.note]),
    [['m-edit', 'changed here'], ['m-keep', ''], ['m-theirs', ''], ['m-mine', '']],
  );
});

test('cards: field by field, the place of the side read last', () => {
  const baseCard = { name: 'b.pdf', format: 'pdf', title: 'Old', author: 'A', position: { page: 1 }, progress: 0.1, opened: 10, marks: [], bookmarks: [] };
  const base = cardSigs(baseCard);
  const local = { ...baseCard, title: 'New title', position: { page: 5 }, progress: 0.5, opened: 20 };
  const remote = { ...baseCard, author: 'B. Author', position: { page: 9 }, progress: 0.9, opened: 30 };
  const merged = mergeCard(cardData(local), cardData(remote), base);
  assert.equal(merged.title, 'New title');
  assert.equal(merged.author, 'B. Author');
  assert.deepEqual(merged.position, { page: 9 });
  assert.equal(merged.progress, 0.9);
  assert.equal(merged.opened, 30);
});

test('documents: files go the way they changed', () => {
  const steps = planDocs(
    { a: { card: 'c1', file: 'f2' }, b: { card: 'c2', file: 'f1' }, d: { card: 'c', file: 'f' } },
    { a: { card: 'c1', file: 'f1' }, b: { card: 'c1', file: 'f1' }, d: { deleted: 1 }, e: { card: 'c', file: 'f' } },
    { a: { card: 'c1', file: 'f1' }, b: { card: 'c1', file: 'f1' }, d: { card: 'c', file: 'f' }, e: { card: 'c', file: 'f' } },
  );
  assert.deepEqual(steps, [
    { op: 'merge', id: 'a', file: 'push' },
    { op: 'merge', id: 'b', file: 'same' },
    { op: 'trash', id: 'd' },
    { op: 'delete', id: 'e' },
  ]);
});

// ---------- two devices and a Drive, all in memory ----------

function fakeDrive() {
  const files = new Map(); // id → { id, name, data, modifiedTime }
  let n = 0;
  let clock = 0;
  const copy = (data) => (typeof data === 'string' ? data : new Uint8Array(data));
  return {
    files,
    async list() {
      return [...files.values()].map(({ id, name, modifiedTime }) => ({ id, name, modifiedTime }));
    },
    async text(id) {
      const data = files.get(id).data;
      return typeof data === 'string' ? data : new TextDecoder().decode(data);
    },
    async bytes(id) {
      const data = files.get(id).data;
      return typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    },
    async put(name, data, { id = '' } = {}) {
      const fileId = id || `f${++n}`;
      files.set(fileId, { id: fileId, name: id ? files.get(id).name : name, data: copy(data), modifiedTime: String(++clock).padStart(6, '0') });
      return fileId;
    },
    async remove(id) {
      files.delete(id);
    },
    named: (name) => [...files.values()].filter((f) => f.name === name),
  };
}

function fakeDevice() {
  const notes = new Map();
  const docs = new Map();
  const docFiles = new Map();
  const assets = new Map();
  const trash = [];
  let n = 0;
  let base = emptyBase();
  const local = {
    notes: async () => [...notes.values()].map((x) => ({ ...x })),
    async putNote(note) {
      notes.set(note.id, { ...note });
    },
    async createNote(content) {
      const note = { id: `n-copy${++n}`, content, created: 100 + n, updated: 100 + n };
      notes.set(note.id, note);
      return note;
    },
    async trashNote(id) {
      trash.push(notes.get(id));
      notes.delete(id);
    },
    docs: async () => [...docs.values()].map((d) => structuredClone(d)),
    fileHash: async (doc) => ({ hash: await hashBytes(docFiles.get(doc.id)), time: 1 }),
    docBytes: async (id) => docFiles.get(id),
    async putDoc(id, data, bytes) {
      docs.set(id, { ...(docs.get(id) ?? {}), ...structuredClone(data), id });
      if (bytes) docFiles.set(id, bytes);
    },
    async removeDoc(id) {
      docs.delete(id);
      docFiles.delete(id);
    },
    assets: async () => [...assets.keys()],
    assetBytes: async (name) => assets.get(name),
    async putAsset(name, bytes) {
      assets.set(name, bytes);
    },
  };
  return {
    notes,
    docs,
    docFiles,
    assets,
    trash,
    note: (id, content, updated = 1) => notes.set(id, { id, content, created: 1, updated }),
    async sync(drive, opts = {}) {
      const result = await syncOnce({ local, drive, base, ...opts });
      base = result.base;
      return result;
    },
  };
}

const book = (id, extra = {}) => ({
  id,
  name: `${id}.epub`,
  format: 'epub',
  title: 'Book',
  author: '',
  cover: null,
  added: 1,
  opened: 0,
  progress: 0,
  position: null,
  notesId: null,
  scale: 1,
  marks: [],
  bookmarks: [],
  ...extra,
});

test('two devices end up with the same notes, books, marks and pictures', async () => {
  const drive = fakeDrive();
  const pc = fakeDevice();
  const phone = fakeDevice();
  pc.note('n-aaaaaa', '# Plan\nfrom the PC');
  pc.docs.set('d-book01', book('d-book01'));
  pc.docFiles.set('d-book01', new Uint8Array([1, 2, 3]));
  pc.assets.set('a-pic001.png', new Uint8Array([9]));
  phone.note('n-bbbbbb', '# Shopping\nfrom the phone');

  await pc.sync(drive);
  await phone.sync(drive);
  await pc.sync(drive);

  for (const device of [pc, phone]) {
    assert.deepEqual([...device.notes.keys()].sort(), ['n-aaaaaa', 'n-bbbbbb']);
    assert.deepEqual([...device.docFiles.get('d-book01')], [1, 2, 3]);
    assert.deepEqual([...device.assets.keys()], ['a-pic001.png']);
  }

  // reading on the phone: a mark and a new place; on the PC a different mark
  const m = (id, created) => ({ id, color: 'yellow', note: '', text: 'x', created, anchor: { a: 0, ao: 0, b: 0, bo: 1 } });
  phone.docs.get('d-book01').marks = [m('m-phone1', 5)];
  Object.assign(phone.docs.get('d-book01'), { position: { block: 40 }, progress: 0.4, opened: 50 });
  pc.docs.get('d-book01').marks = [m('m-pc0001', 6)];
  await phone.sync(drive);
  const r = await pc.sync(drive);
  assert.ok(r.docsChanged);
  await phone.sync(drive);
  for (const device of [pc, phone]) {
    const doc = device.docs.get('d-book01');
    assert.deepEqual(doc.marks.map((x) => x.id), ['m-phone1', 'm-pc0001']);
    assert.deepEqual(doc.position, { block: 40 });
  }
  assert.equal(drive.named('index.json').length, 1);
});

test('a note edited on both devices keeps both versions', async () => {
  const drive = fakeDrive();
  const pc = fakeDevice();
  const phone = fakeDevice();
  pc.note('n-shared', 'v1');
  await pc.sync(drive);
  await phone.sync(drive);

  pc.note('n-shared', 'v2 from the PC', 20);
  phone.note('n-shared', 'v2 from the phone', 30);
  await pc.sync(drive);
  const r = await phone.sync(drive);
  assert.equal(r.conflicts.length, 1);
  await pc.sync(drive);

  for (const device of [pc, phone]) {
    const texts = [...device.notes.values()].map((x) => x.content).sort();
    assert.deepEqual(texts, ['v2 from the PC', 'v2 from the phone']);
    assert.equal(device.notes.get('n-shared').content, 'v2 from the phone', 'the newer one keeps the place');
  }
});

test('a deleted note leaves the other device too, and does not come back', async () => {
  const drive = fakeDrive();
  const pc = fakeDevice();
  const phone = fakeDevice();
  pc.note('n-temp01', 'scratch');
  pc.note('n-keep01', 'keep');
  await pc.sync(drive);
  await phone.sync(drive);
  pc.notes.delete('n-temp01');
  await pc.sync(drive);
  const r = await phone.sync(drive);
  assert.deepEqual(r.trashed, ['n-temp01']);
  assert.equal(phone.trash[0].content, 'scratch', 'it went to the trash, not into nothing');
  await pc.sync(drive);
  await phone.sync(drive);
  assert.deepEqual([...pc.notes.keys()], ['n-keep01']);
  assert.deepEqual([...phone.notes.keys()], ['n-keep01']);
  assert.equal(drive.named('note-n-temp01.md').length, 0);
});

test('an open document waits for the next round', async () => {
  const drive = fakeDrive();
  const pc = fakeDevice();
  pc.docs.set('d-open01', book('d-open01'));
  pc.docFiles.set('d-open01', new Uint8Array([7]));
  await pc.sync(drive, { skipDocs: ['d-open01'] });
  assert.equal(drive.named('card-d-open01.json').length, 0);
  await pc.sync(drive);
  assert.equal(drive.named('card-d-open01.json').length, 1);
});

test('a second sync with no changes writes nothing', async () => {
  const drive = fakeDrive();
  const pc = fakeDevice();
  pc.note('n-aaaaaa', 'text');
  await pc.sync(drive);
  const r = await pc.sync(drive);
  assert.equal(r.sent, 0);
  assert.equal(r.received, 0);
});

test('fingerprints tell texts apart', () => {
  assert.notEqual(fingerprint('a'), fingerprint('b'));
  assert.equal(fingerprint('заметка'), fingerprint('заметка'));
});

test('texts on PDF pages sync like marks, and a card from an older app does not remove them', async () => {
  const { mergeCard, cardSigs } = await import('../src/sync/merge.js');
  const text = (id, extra = {}) => ({ id, page: 1, x: 0.1, y: 0.1, w: 0.3, text: id, size: 0.022, color: 'black', created: 1, ...extra });
  const base = cardSigs({ texts: [text('t-aaaa')] });
  // one side added, the other removed one Drive knew
  const merged = mergeCard({ opened: 1, texts: [text('t-aaaa'), text('t-bbbb')] }, { opened: 1, texts: [] }, base);
  assert.deepEqual(merged.texts.map((x) => x.id), ['t-bbbb']);
  // an older app's card has no texts at all: this device's stay
  const old = mergeCard({ opened: 1, texts: [text('t-aaaa')] }, { opened: 2, texts: null }, base);
  assert.deepEqual(old.texts.map((x) => x.id), ['t-aaaa']);
  const fresh = mergeCard({ opened: 1, texts: null }, { opened: 1, texts: [text('t-cccc')] }, null);
  assert.deepEqual(fresh.texts.map((x) => x.id), ['t-cccc']);
});

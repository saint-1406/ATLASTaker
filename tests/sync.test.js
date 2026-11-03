import test from 'node:test';
import assert from 'node:assert/strict';
import { cardData, cardSigs, fingerprint, mergeCard, mergeDays, mergeItems, mergeSettings, planDocs, planNotes, settingsOf } from '../src/sync/merge.js';
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
    async modified(id) {
      return files.get(id)?.modifiedTime ?? '';
    },
    named: (name) => [...files.values()].filter((f) => f.name === name),
  };
}

/** refuse(id): documents this device's library will not take (as the Windows one refused an empty file). */
function fakeDevice({ refuse = () => false, badAsset = '' } = {}) {
  const notes = new Map();
  const docs = new Map();
  const docFiles = new Map();
  const assets = new Map();
  const trash = [];
  const state = {}; // settings, with settingsAt, as the devices keep them
  let n = 0;
  let base = emptyBase();
  const local = {
    notes: async () => [...notes.values()].map((x) => ({ ...x })),
    async putNote(note) {
      // as on the devices: the text and times come in, the folder and the trash stay as they are
      const old = notes.get(note.id);
      notes.set(note.id, { folder: old?.folder ?? '', trashed: old?.trashed ?? 0, ...note });
    },
    async setNoteFolder(id, folder) {
      const note = notes.get(id);
      if (note) note.folder = folder;
    },
    async setNoteTrashed(id, trashed) {
      const note = notes.get(id);
      if (note) note.trashed = trashed || 0;
    },
    settings: async () => settingsOf(state),
    async putSettings(entries) {
      for (const [key, { value, at }] of Object.entries(entries)) {
        state[key] = value;
        (state.settingsAt ??= {})[key] = at;
      }
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
      if (refuse(id)) throw new Error('refused');
      docs.set(id, { ...(docs.get(id) ?? {}), ...structuredClone(data), id });
      if (bytes) docFiles.set(id, bytes);
    },
    async removeDoc(id) {
      docs.delete(id);
      docFiles.delete(id);
    },
    assets: async () => [...assets.keys()],
    async assetBytes(name) {
      if (name === badAsset) throw new Error('unreadable');
      return assets.get(name);
    },
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
    state,
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

test('an empty document arrives as it is, and one this device refuses does not stop the round', async () => {
  const drive = fakeDrive();
  const phone = fakeDevice();
  const pc = fakeDevice({ refuse: (id) => id === 'd-bad001' });
  phone.note('n-phone1', '# From the phone');
  phone.docs.set('d-empty1', book('d-empty1', { format: 'txt', name: 'empty.txt' }));
  phone.docFiles.set('d-empty1', new Uint8Array(0));
  phone.docs.set('d-bad001', book('d-bad001', { title: 'Refused' }));
  phone.docFiles.set('d-bad001', new Uint8Array([5]));
  await phone.sync(drive);

  pc.note('n-pc0001', '# From the PC');
  const r = await pc.sync(drive);
  assert.deepEqual(r.skippedDocs, [{ id: 'd-bad001', title: 'Refused', error: 'refused' }]);
  assert.equal(pc.docFiles.get('d-empty1')?.length, 0, 'the empty file came as an empty file, not as nothing');
  assert.ok(pc.notes.has('n-phone1'));
  await phone.sync(drive);
  assert.ok(phone.notes.has('n-pc0001'), 'the index was written: the PC’s note reached the phone');
  assert.ok(phone.docs.has('d-bad001'), 'the refused document stays where it was');
  assert.deepEqual((await pc.sync(drive)).skippedDocs.map((d) => d.id), ['d-bad001'], 'and is tried again next round');
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

test('rewritten PDF lines sync like texts', async () => {
  const { mergeCard, cardSigs } = await import('../src/sync/merge.js');
  const edit = (id) => ({ id, page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.02, base: 0.115, size: 0.02, font: 'sans', bold: false, ink: '#000000', bg: '#ffffff', original: 'a', text: id, created: 1 });
  const base = cardSigs({ edits: [edit('e-aaaa')] });
  // written into the file on one device (the list emptied), a new one made on the other
  const merged = mergeCard({ opened: 1, edits: [edit('e-aaaa'), edit('e-bbbb')] }, { opened: 1, edits: [] }, base);
  assert.deepEqual(merged.edits.map((x) => x.id), ['e-bbbb']);
  assert.deepEqual(mergeCard({ opened: 1, edits: [edit('e-cccc')] }, { opened: 1 }, base).edits.map((x) => x.id), ['e-cccc']);
});

test('a card with no marks or bookmarks at all (null) merges without failing', async () => {
  const { mergeCard, cardData } = await import('../src/sync/merge.js');
  const bare = cardData({ name: 'a.pdf', format: 'pdf', opened: 1 }); // a card made without those lists
  const other = { ...bare, marks: [{ id: 'm-aaaa', created: 1 }] };
  const out = mergeCard(bare, other, null);
  assert.deepEqual(out.marks.map((m) => m.id), ['m-aaaa']);
  assert.deepEqual(out.bookmarks, []);
  assert.deepEqual(mergeCard(other, bare, null).marks.map((m) => m.id), ['m-aaaa']);
});

test('a note moved to a folder moves on the other device, without a conflict copy', async () => {
  const drive = fakeDrive();
  const pc = fakeDevice();
  const phone = fakeDevice();
  pc.note('n-aaaaaa', '# Plan');
  pc.note('n-bbbbbb', '# Diary');
  await pc.sync(drive);
  await phone.sync(drive);
  assert.equal(phone.notes.get('n-aaaaaa').folder, '');

  // the PC files one note; the phone, meanwhile, edits it and files the other
  pc.notes.get('n-aaaaaa').folder = 'Work';
  Object.assign(phone.notes.get('n-aaaaaa'), { content: '# Plan\nmore', updated: 5 });
  phone.notes.get('n-bbbbbb').folder = 'Personal';
  await pc.sync(drive);
  const r = await phone.sync(drive);
  await pc.sync(drive);
  assert.deepEqual(r.conflicts, []);
  for (const device of [pc, phone]) {
    assert.equal(device.notes.get('n-aaaaaa').folder, 'Work');
    assert.equal(device.notes.get('n-aaaaaa').content, '# Plan\nmore');
    assert.equal(device.notes.get('n-bbbbbb').folder, 'Personal');
  }

  // taken out of the folder on the phone: out on the PC too
  phone.notes.get('n-aaaaaa').folder = '';
  await phone.sync(drive);
  await pc.sync(drive);
  assert.equal(pc.notes.get('n-aaaaaa').folder, '');
});

test('an index written by an app without folders leaves this device’s folders alone', async () => {
  const drive = fakeDrive();
  const pc = fakeDevice();
  pc.note('n-aaaaaa', '# Plan');
  pc.notes.get('n-aaaaaa').folder = 'Work';
  await pc.sync(drive);
  const [indexFile] = drive.named('index.json');
  const index = JSON.parse(indexFile.data);
  assert.deepEqual(index.folders, { 'n-aaaaaa': 'Work' });
  delete index.folders; // an older version rewrote the index
  indexFile.data = JSON.stringify(index);
  await pc.sync(drive);
  assert.equal(pc.notes.get('n-aaaaaa').folder, 'Work');
  assert.deepEqual(JSON.parse(drive.named('index.json')[0].data).folders, { 'n-aaaaaa': 'Work' });
});

// ---------- the trash ----------

test('the trash travels: in on one device, out on another, gone for good only from the trash', async () => {
  const drive = fakeDrive();
  const pc = fakeDevice();
  const phone = fakeDevice();
  pc.note('n-aaaaaa', '# Plan');
  await pc.sync(drive);
  await phone.sync(drive);

  pc.notes.get('n-aaaaaa').trashed = 50; // deleted on the PC: into its trash
  await pc.sync(drive);
  const r = await phone.sync(drive);
  assert.equal(r.trashChanged, true);
  assert.equal(phone.notes.get('n-aaaaaa').trashed, 50, 'in the phone’s trash too, still a whole note');
  assert.equal(phone.notes.get('n-aaaaaa').content, '# Plan');

  phone.notes.get('n-aaaaaa').trashed = 0; // restored on the phone
  await phone.sync(drive);
  await pc.sync(drive);
  assert.equal(pc.notes.get('n-aaaaaa').trashed, 0);

  pc.notes.get('n-aaaaaa').trashed = 60;
  await pc.sync(drive);
  await phone.sync(drive);
  pc.notes.delete('n-aaaaaa'); // deleted for good from the PC's trash
  await pc.sync(drive);
  await phone.sync(drive);
  assert.equal(phone.notes.has('n-aaaaaa'), false, 'gone on the phone as well');
  assert.equal(phone.trash.length, 1, 'kept out of sight, as every removal is');
  assert.deepEqual(JSON.parse(drive.named('index.json')[0].data).trashed, {});
});

test('a note edited on one device while it sits in the other’s trash stays in the trash, with the new text', async () => {
  const drive = fakeDrive();
  const pc = fakeDevice();
  const phone = fakeDevice();
  pc.note('n-aaaaaa', '# Plan');
  await pc.sync(drive);
  await phone.sync(drive);
  pc.notes.get('n-aaaaaa').trashed = 70;
  phone.notes.get('n-aaaaaa').content = '# Plan\nmore';
  await pc.sync(drive);
  await phone.sync(drive);
  await pc.sync(drive);
  for (const device of [pc, phone]) {
    assert.equal(device.notes.get('n-aaaaaa').trashed, 70);
    assert.equal(device.notes.get('n-aaaaaa').content, '# Plan\nmore');
  }
});

test('books, marks and bookmarks in the trash travel as part of the card', async () => {
  const drive = fakeDrive();
  const pc = fakeDevice();
  const phone = fakeDevice();
  const mark = { id: 'm-aaaa01', color: 'yellow', note: '', text: 'x', created: 1, anchor: { a: 1, ao: 0, b: 1, bo: 1 } };
  pc.docs.set('d-book01', book('d-book01', { marks: [mark], bookmarks: [{ id: 'b-aaaa01', position: { block: 1 }, progress: 0.1, label: '', created: 1 }] }));
  pc.docFiles.set('d-book01', new Uint8Array([1]));
  await pc.sync(drive);
  await phone.sync(drive);

  const card = pc.docs.get('d-book01');
  card.marks = [{ ...mark, trashed: 80, edited: 80 }];
  card.bookmarks = [{ ...card.bookmarks[0], trashed: 81, edited: 81 }];
  await pc.sync(drive);
  await phone.sync(drive);
  assert.equal(phone.docs.get('d-book01').marks[0].trashed, 80);
  assert.equal(phone.docs.get('d-book01').bookmarks[0].trashed, 81);

  phone.docs.get('d-book01').trashed = 90; // the whole book into the trash, on the phone
  await phone.sync(drive);
  await pc.sync(drive);
  assert.equal(pc.docs.get('d-book01').trashed, 90);
  assert.ok(pc.docFiles.has('d-book01'), 'its file stays, so it comes back whole');
});

// ---------- settings ----------

test('settings: the newer wins, a default gives way, reading days add up', () => {
  const pc = { values: { skin: 'minimal', theme: 'dark', readDays: { '2026-11-01': 10 } }, at: { skin: 100, theme: 100, readDays: 100 } };
  const fresh = { values: { skin: 'cozy', theme: 'cream', readDays: { '2026-11-02': 5 } }, at: { readDays: 50 } };
  const m = mergeSettings(fresh, pc);
  assert.deepEqual(m.toLocal.skin, { value: 'minimal', at: 100 }, 'a fresh install takes what was chosen');
  assert.deepEqual(m.values.readDays, { '2026-11-01': 10, '2026-11-02': 5 });
  assert.equal(m.upload, true, 'the phone’s day goes up');
  const later = mergeSettings({ values: { theme: 'sepia' }, at: { theme: 200 } }, pc);
  assert.equal(later.values.theme, 'sepia');
  assert.equal(later.values.skin, 'minimal');
  assert.deepEqual(mergeDays({ a: 5, b: 1 }, { a: 3, c: 2 }), { a: 5, b: 1, c: 2 });
});

test('settings travel between devices, and only when something changed', async () => {
  const drive = fakeDrive();
  const pc = fakeDevice();
  const phone = fakeDevice();
  Object.assign(pc.state, { skin: 'minimal', theme: 'dark', fontScale: 1.2, lastOpen: 'n-aaaaaa', settingsAt: { skin: 100, theme: 100, fontScale: 100 } });
  Object.assign(phone.state, { skin: 'cozy', theme: 'cream' }); // a fresh install's defaults
  await pc.sync(drive);
  const r = await phone.sync(drive);
  assert.deepEqual(r.settingsChanged.sort(), ['fontScale', 'skin', 'theme']);
  assert.equal(phone.state.theme, 'dark');
  assert.equal(phone.state.fontScale, 1.2);
  assert.equal('lastOpen' in phone.state, false, 'the open note stays on its device');

  Object.assign(phone.state, { theme: 'night', settingsAt: { ...phone.state.settingsAt, theme: 300 } });
  await phone.sync(drive);
  await pc.sync(drive);
  assert.equal(pc.state.theme, 'night');

  const writes = drive.named('settings.json')[0].modifiedTime;
  await pc.sync(drive);
  await phone.sync(drive);
  assert.equal(drive.named('settings.json')[0].modifiedTime, writes, 'nothing new: settings.json is left alone');
});

// ---------- rounds that meet trouble ----------

test('one picture that will not go does not stop the round', async () => {
  const drive = fakeDrive();
  const pc = fakeDevice({ badAsset: 'a-broken.png' });
  pc.assets.set('a-broken.png', new Uint8Array([1]));
  pc.assets.set('a-good01.png', new Uint8Array([2]));
  pc.note('n-aaaaaa', '# Plan');
  const r = await pc.sync(drive);
  assert.equal(r.skippedAssets, 1);
  assert.equal(drive.named('asset-a-good01.png').length, 1);
  assert.ok(JSON.parse(drive.named('index.json')[0].data).notes['n-aaaaaa'], 'the notes still went through');
});

test('another device writing the index mid-round: the round starts over and both keep their changes', async () => {
  const drive = fakeDrive();
  const pc = fakeDevice();
  const phone = fakeDevice();
  pc.note('n-aaaaaa', '# From the PC');
  await pc.sync(drive);
  await phone.sync(drive);
  pc.note('n-cccccc', '# Written on the PC meanwhile');
  phone.note('n-bbbbbb', '# From the phone');
  // just before the phone writes its index, the PC finishes a round of its own
  const modified = drive.modified;
  let once = true;
  drive.modified = async (id) => {
    if (once) {
      once = false;
      await pc.sync(drive);
    }
    return modified(id);
  };
  await phone.sync(drive);
  drive.modified = modified;
  await pc.sync(drive);
  const index = JSON.parse(drive.named('index.json')[0].data);
  assert.ok(index.notes['n-bbbbbb'] && index.notes['n-cccccc'], 'both new notes are in the index');
  assert.ok(pc.notes.has('n-bbbbbb'));
  assert.ok(phone.notes.has('n-cccccc'));
});

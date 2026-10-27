import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';

function fresh(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createStore(dir) };
}

test('notes, cursors and preferences survive a restart', async (t) => {
  const { dir, store } = fresh(t);
  const note = await store.create('# Первая');
  await store.write(note.id, '# Первая\n\nтекст');
  await store.setMeta(note.id, { cursor: { anchor: 5, head: 7 }, scroll: 120 });
  store.setState({ theme: 'light', lastOpen: note.id });
  await store.idle();
  store.flush();

  const again = createStore(dir);
  const [loaded] = await again.list();
  assert.equal(loaded.content, '# Первая\n\nтекст');
  assert.deepEqual(loaded.cursor, { anchor: 5, head: 7 });
  assert.equal(loaded.scroll, 120);
  assert.equal(again.getState().theme, 'light');
  assert.equal(again.getState().lastOpen, note.id);
  again.flush();
});

test('ids that could escape the folder are rejected', async (t) => {
  const { store } = fresh(t);
  await assert.rejects(store.write('../evil', 'x'), /id/);
  await assert.rejects(store.write('n-..\\..\\x', 'x'), /id/);
  await assert.rejects(store.trash('C:\\Windows'), /id/);
  store.flush();
});

test('the newest of overlapping writes wins', async (t) => {
  const { store } = fresh(t);
  const note = await store.create('');
  await Promise.all([store.write(note.id, 'один'), store.write(note.id, 'два'), store.write(note.id, 'три')]);
  const [loaded] = await store.list();
  assert.equal(loaded.content, 'три');
  store.flush();
});

test('trash moves the file aside and blocks late writes', async (t) => {
  const { dir, store } = fresh(t);
  const note = await store.create('в архив');
  await store.trash(note.id);
  assert.deepEqual(await store.list(), []);
  assert.equal(readdirSync(path.join(dir, '.trash')).length, 1);
  await assert.rejects(store.write(note.id, 'поздно'), /архиве/);
  store.flush();
});

test('state keeps only known keys with valid values', (t) => {
  const { store } = fresh(t);
  store.setState({ theme: 'system', skin: 'atlas', accent: 'cyan', fontScale: 1.1, lang: 'en' });
  const state = store.setState({ theme: 'neon', skin: 'neon', accent: '#fff', fontScale: 9, evil: true, lastOpen: '../x', lang: 'de' });
  assert.deepEqual(state, { theme: 'system', skin: 'atlas', accent: 'cyan', fontScale: 1.1, lang: 'en' });
  store.flush();
});

test('a damaged atlas.json is set aside, notes still load', async (t) => {
  const { dir, store } = fresh(t);
  await store.create('живая заметка');
  await store.idle();
  store.flush();
  writeFileSync(path.join(dir, 'atlas.json'), '{ broken');
  const again = createStore(dir);
  const [loaded] = await again.list();
  assert.equal(loaded.content, 'живая заметка');
  assert.ok(readdirSync(dir).some((name) => name.startsWith('atlas.json.broken-')));
  again.flush();
});

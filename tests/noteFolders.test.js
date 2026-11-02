import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL, NONE, addFolder, folderCounts, folderList, inFolder, pickNotes, preview, renameFolder } from '../src/noteFolders.js';
import { mergeFolder } from '../src/sync/merge.js';

const notes = [
  { id: 'n-1', content: '# Plan\nbuy milk', updated: 3, folder: 'Work' },
  { id: 'n-2', content: 'Shopping list\n- bread', updated: 9, folder: '' },
  { id: 'n-3', content: '# Diary\nrain today', updated: 5, folder: 'Personal' },
  { id: 'n-4', content: 'Loose', updated: 1, folder: 'work' },
];

test('folders: the saved order first, then those notes name (synced in)', () => {
  assert.deepEqual(folderList(['Work', 'Empty'], notes), ['Work', 'Empty', 'Personal']);
  assert.deepEqual(folderList(undefined, []), []);
});

test('folders: membership ignores case; No folder holds notes of unknown folders too', () => {
  const folders = ['Work'];
  assert.ok(inFolder(notes[3], 'Work', folders));
  assert.ok(inFolder(notes[1], NONE, folders));
  assert.ok(inFolder(notes[2], NONE, folders));
  assert.ok(!inFolder(notes[0], NONE, folders));
  assert.ok(inFolder(notes[0], ALL, folders));
  assert.deepEqual(folderCounts(notes, folders), {
    [ALL]: 4,
    [NONE]: 2,
    Work: 2,
  });
});

test('folders: add and rename refuse empty and taken names', () => {
  assert.deepEqual(addFolder(['Work'], '  Ideas  '), ['Work', 'Ideas']);
  assert.equal(addFolder(['Work'], 'work'), null);
  assert.equal(addFolder(['Work'], '   '), null);
  assert.deepEqual(renameFolder(['Work', 'Home'], 'Work', 'Job'), ['Job', 'Home']);
  assert.equal(renameFolder(['Work', 'Home'], 'Work', 'home'), null);
});

test('notes: a folder, a search, newest first', () => {
  assert.deepEqual(
    pickNotes(notes).map((n) => n.id),
    ['n-2', 'n-3', 'n-1', 'n-4'],
  );
  assert.deepEqual(
    pickNotes(notes, { folder: 'Work', folders: ['Work'] }).map((n) => n.id),
    ['n-1', 'n-4'],
  );
  assert.deepEqual(
    pickNotes(notes, { query: 'MILK plan' }).map((n) => n.id),
    ['n-1'],
  );
});

test('preview: the title without marks and a piece of the rest', () => {
  assert.deepEqual(preview('# Plan **now**\n\n- [ ] buy [milk](https://x)\n> quote'), { title: 'Plan now', snippet: 'buy milk quote' });
  assert.deepEqual(preview(''), { title: '', snippet: '' });
  assert.equal(preview(`t\n${'a'.repeat(300)}`, 10).snippet, `${'a'.repeat(10)}…`);
});

test('a note moved on one side keeps the move; on both, this device wins', () => {
  assert.equal(mergeFolder('Work', '', ''), 'Work');
  assert.equal(mergeFolder('', 'Work', ''), 'Work');
  assert.equal(mergeFolder('', 'Work', 'Work'), '');
  assert.equal(mergeFolder('Home', 'Work', ''), 'Home');
  assert.equal(mergeFolder(undefined, undefined, undefined), '');
});

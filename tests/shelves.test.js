import test from 'node:test';
import assert from 'node:assert/strict';
import { addShelf, cleanShelf, groupShelves, isShelf, renameShelf, shelfList } from '../src/shelves.js';

test('the sections: the saved order, then names books bring from elsewhere, no doubles', () => {
  const docs = [{ shelf: 'Хоррор' }, { shelf: 'хоррор' }, { shelf: 'Поэзия' }, { shelf: '' }];
  assert.deepEqual(shelfList(['Фэнтези', 'Хоррор', ' Фэнтези '], docs), ['Фэнтези', 'Хоррор', 'Поэзия']);
  assert.equal(cleanShelf('  Мои   справки '), 'Мои справки');
});

test('books fall into their sections, the rest stays aside', () => {
  const docs = [
    { id: 'a', shelf: 'Хоррор', opened: 1 },
    { id: 'b', shelf: 'хоррор', opened: 5 },
    { id: 'c', shelf: '', added: 3 },
    { id: 'd', shelf: 'Gone', added: 2 },
  ];
  const { groups, unsorted } = groupShelves(['Хоррор', 'Документы'], docs);
  assert.deepEqual(groups.map((g) => [g.name, g.docs.map((d) => d.id)]), [['Хоррор', ['b', 'a']], ['Документы', []]]);
  assert.deepEqual(unsorted.map((d) => d.id), ['c', 'd']);
  assert.ok(isShelf(docs[1], 'Хоррор'));
});

test('adding and renaming sections keeps names unique', () => {
  assert.deepEqual(addShelf(['A'], ' B '), ['A', 'B']);
  assert.equal(addShelf(['A'], 'a'), null);
  assert.equal(addShelf(['A'], '   '), null);
  assert.deepEqual(renameShelf(['A', 'B'], 'B', 'C'), ['A', 'C']);
  assert.equal(renameShelf(['A', 'B'], 'B', 'a'), null);
  assert.deepEqual(renameShelf(['A', 'B'], 'B', 'b'), ['A', 'b']);
});

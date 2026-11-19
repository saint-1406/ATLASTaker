import test from 'node:test';
import assert from 'node:assert/strict';
import { authorKey, authorList, authorsOf, byAuthor } from '../src/authors.js';

test('authors: several people on one line are split, a "Surname, Name" stays one person', () => {
  assert.deepEqual(authorsOf('Илья Ильф, Евгений Петров'), ['Илья Ильф', 'Евгений Петров']);
  assert.deepEqual(authorsOf('Tolstoy, Leo'), ['Tolstoy, Leo']);
  assert.deepEqual(authorsOf('Neil Gaiman & Terry Pratchett'), ['Neil Gaiman', 'Terry Pratchett']);
  assert.deepEqual(authorsOf('A. Author; B.  Writer'), ['A. Author', 'B. Writer']);
  assert.deepEqual(authorsOf(''), []);
  assert.deepEqual(authorsOf(undefined), []);
});

test('authors: the shelf\'s list, each once whatever the case, with counts, the nameless last', () => {
  const docs = [
    { author: 'Лев Толстой' },
    { author: 'лев  толстой' },
    { author: 'Илья Ильф, Евгений Петров' },
    { author: 'Евгений Петров' },
    { author: '' },
  ];
  assert.deepEqual(
    authorList(docs).map((a) => [a.name, a.count]),
    [
      ['Евгений Петров', 2],
      ['Илья Ильф', 1],
      ['Лев Толстой', 2],
      ['', 1],
    ],
  );
  assert.ok(byAuthor(docs[2], authorKey('евгений петров')));
  assert.ok(!byAuthor(docs[0], authorKey('Евгений Петров')));
  assert.ok(byAuthor(docs[4], ''), 'the empty key stands for books with no author');
});

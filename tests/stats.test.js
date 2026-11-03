import test from 'node:test';
import assert from 'node:assert/strict';
import { textStats } from '../src/stats.js';
import { diffCounts, diffLines } from '../src/diff.js';

test('stats: words, sentences and paragraphs of prose; code and rules are not prose', () => {
  const note = '# Лечим ухо\n\nКапли 4 раза в день. Потом ещё раз! Хорошо?\nВторая строка без точки\n\n- пункт один\n- пункт два\n\n---\n\n```\ncode here. more.\n```\n';
  const s = textStats(note, 'ru');
  assert.equal(s.paragraphs, 5, 'heading, two lines of prose, two items');
  assert.equal(s.sentences, 7, 'heading 1, prose 4, items 2');
  assert.equal(s.words, 22);
  assert.equal(s.chars, note.length);
  assert.ok(s.charsNoSpaces < s.chars);
  assert.equal(s.readMinutes, 22 / 200);
});

test('stats: an empty note is all zeros', () => {
  assert.deepEqual(textStats(''), { chars: 0, charsNoSpaces: 0, words: 0, sentences: 0, paragraphs: 0, readMinutes: 0 });
});

test('diff: lines out and in, the shared ones kept in place', () => {
  const ops = diffLines('a\nb\nc\nd', 'a\nx\nc\nd\ne');
  assert.deepEqual(
    ops.map((o) => `${o.op === 'same' ? ' ' : o.op === 'add' ? '+' : '-'}${o.text}`),
    [' a', '-b', '+x', ' c', ' d', '+e'],
  );
  assert.deepEqual(diffCounts(ops), { added: 2, removed: 1 });
  assert.deepEqual(diffLines('same', 'same'), [{ op: 'same', text: 'same' }]);
  assert.deepEqual(diffCounts(diffLines('', 'one\ntwo')), { added: 2, removed: 1 }, 'the empty line went, two came');
});

test('diff: a long note with a change in the middle is quick and exact', () => {
  const lines = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
  const changed = [...lines];
  changed[10000] = 'changed';
  changed.splice(15000, 0, 'new line');
  const t0 = performance.now();
  const ops = diffLines(lines.join('\n'), changed.join('\n'));
  assert.ok(performance.now() - t0 < 500);
  assert.deepEqual(diffCounts(ops), { added: 2, removed: 1 });
});

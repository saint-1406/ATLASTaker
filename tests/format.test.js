import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState } from '@codemirror/state';
import { heading, lineMark, link, rule, wrap } from '../src/format.js';

/** The text (and the selection, as from-to) after one of the bar's commands. */
function after(doc, selection, make) {
  const state = EditorState.create({ doc, selection, extensions: EditorState.allowMultipleSelections.of(true) });
  const spec = make(state);
  if (!spec) return null;
  const next = state.update(spec).state;
  const { from, to } = next.selection.main;
  return { text: next.doc.toString(), sel: [from, to] };
}
const at = (pos) => EditorSelection.cursor(pos);
const span = (from, to) => EditorSelection.single(from, to);

test('headings: put on, changed to another level, taken off', () => {
  assert.equal(after('title\nnext', at(2), (s) => heading(s, 2)).text, '## title\nnext');
  assert.equal(after('## title', at(4), (s) => heading(s, 1)).text, '# title');
  assert.equal(after('## title', at(4), (s) => heading(s, 2)).text, 'title');
  assert.equal(after('- item', at(3), (s) => heading(s, 3)).text, '### item', 'an item becomes the heading');
});

test('lists and quotes: on every written line, numbered in order, off again', () => {
  assert.equal(after('a\nb\n\nc', span(0, 6), (s) => lineMark(s, 'bullet')).text, '- a\n- b\n\n- c');
  assert.equal(after('- a\n- b', span(0, 7), (s) => lineMark(s, 'numbered')).text, '1. a\n2. b');
  assert.equal(after('- a\n- b', span(0, 7), (s) => lineMark(s, 'bullet')).text, 'a\nb');
  assert.equal(after('  item', at(3), (s) => lineMark(s, 'task')).text, '  - [ ] item', 'the indent stays');
  assert.equal(after('- [ ] done', at(7), (s) => lineMark(s, 'task')).text, 'done');
  assert.equal(after('text', at(1), (s) => lineMark(s, 'quote')).text, '> text');
  assert.equal(after('> text', at(3), (s) => lineMark(s, 'quote')).text, 'text');
  assert.equal(after('', at(0), (s) => lineMark(s, 'bullet')).text, '- ', 'an empty line starts a list');
});

test('bold, italic, strike, code: around the selection, and off again', () => {
  assert.deepEqual(after('one two', span(4, 7), (s) => wrap(s, '**')), { text: 'one **two**', sel: [6, 9] });
  assert.equal(after('one **two**', span(6, 9), (s) => wrap(s, '**')).text, 'one two');
  assert.equal(after('one **two**', span(4, 11), (s) => wrap(s, '**')).text, 'one two', 'the marks selected too');
  assert.equal(after('**two**', span(2, 5), (s) => wrap(s, '*')).text, '***two***', 'italic inside bold');
  assert.equal(after('*two*', span(1, 4), (s) => wrap(s, '*')).text, 'two');
  assert.equal(after('a ~~b~~', span(4, 5), (s) => wrap(s, '~~')).text, 'a b');
  assert.deepEqual(after('ab', at(1), (s) => wrap(s, '`')), { text: 'a``b', sel: [2, 2] }, 'nothing selected: a pair, the cursor inside');
});

test('a link takes the selected words; a rule goes on a line of its own', () => {
  assert.deepEqual(after('see site', span(4, 8), link), { text: 'see [site](https://)', sel: [11, 19] });
  assert.deepEqual(after('x', at(1), link), { text: 'x[](https://)', sel: [2, 2] });
  assert.equal(after('text', at(2), rule).text, 'text\n\n---\n');
  assert.equal(after('a\n\nb', at(2), rule).text, 'a\n---\n\nb');
});

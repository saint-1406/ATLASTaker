import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import * as rules from '../src/editingRules.js';
import { wrap } from '../src/format.js';

const stateAt = (doc, anchor) => EditorState.create({ doc, selection: { anchor: anchor ?? doc.length }, extensions: markdown({ base: markdownLanguage }) });

test('strike: Enter and a space at the hidden closing mark continue outside formatting', () => {
  for (const separator of ['\n', ' ']) {
    const state = stateAt('~~слово~~', 7);
    const next = state.update(rules.exitStrike(state, 7, 7, separator)).state;
    assert.equal(next.doc.toString(), '~~слово~~' + separator);
    assert.equal(next.selection.main.head, next.doc.length);
  }
});

test('strike: a keyboard word replacement followed by a space preserves the closing marks', () => {
  const state = stateAt('~~слово~~', 7);
  const next = state.update(rules.exitStrike(state, 2, 7, 'Слово ')).state;
  assert.equal(next.doc.toString(), '~~Слово~~ ');
  assert.equal(next.selection.main.head, next.doc.length);
});

test('strike: Enter preserves task, bullet, quote and numbered-list continuation', () => {
  for (const [prefix, nextPrefix] of [['- [ ] ', '- [ ] '], ['- ', '- '], ['> ', '> '], ['1. ', '2. ']]) {
    const doc = prefix + '~~word~~';
    const state = stateAt(doc, doc.length - 2);
    const next = state.update(rules.exitStrike(state, doc.length - 2, doc.length - 2, '\n')).state;
    assert.equal(next.doc.toString(), doc + '\n' + nextPrefix);
    assert.equal(next.selection.main.head, next.doc.length);
  }
});

test('strike: ordinary typing, middle-of-word spaces, literal code and readonly are left alone', () => {
  const state = stateAt('~~one two~~', 5);
  assert.equal(rules.exitStrike(state, 5, 5, ' '), null);
  assert.equal(rules.exitStrike(state, 9, 9, 'x'), null);
  const code = stateAt('```\n~~one~~\n```', 9);
  assert.equal(rules.exitStrike(code, 9, 9, '\n'), null);
  const readOnly = EditorState.create({ doc: '~~word~~', selection: { anchor: 6 }, extensions: [markdown({ base: markdownLanguage }), EditorState.readOnly.of(true)] });
  assert.equal(rules.exitStrike(readOnly, 6, 6, '\n'), null);
});

test('strike: pressing the toolbar tool again at its end exits instead of adding more tildes', () => {
  const state = stateAt('~~слово~~', 7);
  const next = state.update(wrap(state, '~~')).state;
  assert.equal(next.doc.toString(), '~~слово~~');
  assert.equal(next.selection.main.head, next.doc.length);
});

test('tasks: Enter on an empty checkbox preserves it and creates the next unchecked item', () => {
  for (const [doc, expected] of [
    ['- [ ] ', '- [ ] \n- [ ] '],
    ['- [ ]', '- [ ]\n- [ ] '],
    ['  * [x] ', '  * [x] \n  * [ ] '],
  ]) {
    const state = stateAt(doc);
    const next = state.update(rules.emptyTaskEnter(state)).state;
    assert.equal(next.doc.toString(), expected);
    assert.equal(next.selection.main.head, next.doc.length);
  }
  assert.equal(rules.emptyTaskEnter(stateAt('- [ ] text')), null);
  assert.equal(rules.emptyTaskEnter(stateAt('```\n- [ ] \n```', 10)), null);
  assert.equal(rules.emptyTaskEnter(stateAt('normal')), null);
});

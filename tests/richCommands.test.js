import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, TextSelection, NodeSelection } from 'prosemirror-state';
import { richSchema as schema } from '../src/rich/schema.js';
import { parseMarkdown } from '../src/rich/markdown.js';
import * as commands from '../src/rich/commands.js';

function run(md, text, command, atEnd = true) {
  const doc = parseMarkdown(md).doc;
  let pos;
  doc.descendants((node, at) => { if (pos === undefined && node.isText && node.text.includes(text)) pos = at + node.text.indexOf(text) + (atEnd ? text.length : 0); });
  if (pos === undefined) pos = 1;
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
  assert.equal(command(state, (tr) => { state = state.apply(tr); }), true);
  return state;
}

test('rich Enter: headings, marks, lists, tasks, quotes and code end in an ordinary paragraph', () => {
  for (const md of ['# word', '**word**', '~~word~~', '- word', '1. word', '- [ ] word', '> word', '```\nword\n```']) {
    const state = run(md, 'word', commands.normalParagraph);
    assert.equal(state.doc.lastChild.type.name, 'paragraph', md);
    assert.equal(state.selection.$from.parent.type.name, 'paragraph', md);
    assert.equal(state.selection.$from.depth, 1, md);
    assert.deepEqual(state.storedMarks, [], md);
    assert.match(state.doc.textContent, /word/);
  }
});

test('rich Enter: split in the middle preserves text, exits format and keeps following list items', () => {
  const state = run('- **first second**\n- third', 'first', commands.normalParagraph);
  assert.equal(state.doc.child(0).type.name, 'bullet_list');
  assert.equal(state.doc.child(1).type.name, 'paragraph');
  assert.match(state.doc.child(1).textContent, / second/);
  assert.equal(state.doc.lastChild.type.name, 'bullet_list');
  assert.match(state.doc.lastChild.textContent, /third/);
});

test('rich Enter: empty checkbox remains present and next block is plain', () => {
  const doc = parseMarkdown('- [ ] ').doc;
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 3) });
  let next;
  assert.equal(commands.normalParagraph(state, (tr) => { next = state.apply(tr); }), true);
  assert.equal(next.doc.firstChild.type.name, 'task_list');
  assert.equal(next.doc.firstChild.childCount, 1);
  assert.equal(next.doc.lastChild.type.name, 'paragraph');
});

test('rich list: explicit next item keeps list type, creates an unchecked task and clears marks', () => {
  const state = run('- [x] **word**', 'word', commands.nextItem);
  assert.equal(state.doc.firstChild.type.name, 'task_list');
  assert.equal(state.doc.firstChild.childCount, 2);
  assert.equal(state.doc.firstChild.lastChild.attrs.checked, false);
  assert.deepEqual(state.storedMarks, []);
});

test('rich mark: toggling empty selection sets stored marks without inserting markers', () => {
  let state = EditorState.create({ schema });
  commands.toggleFormat('strong')(state, (tr) => { state = state.apply(tr); });
  assert.equal(state.doc.textContent, '');
  assert.equal(state.storedMarks[0].type.name, 'strong');
  state = state.apply(state.tr.insertText('two words '));
  assert.equal(state.doc.firstChild.firstChild.marks[0].type.name, 'strong');
  commands.toggleFormat('strong')(state, (tr) => { state = state.apply(tr); });
  state = state.apply(state.tr.insertText('plain'));
  assert.equal(state.doc.textContent, 'two words plain');
  assert.equal(state.doc.firstChild.lastChild.marks.length, 0);
});

test('rich Enter: summary with a heading first in its body starts a plain paragraph', () => {
  const state = run('<details open>\n<summary>Title</summary>\n\n# heading\n\n</details>', 'Title', commands.normalParagraph);
  assert.equal(state.selection.$from.parent.type.name, 'paragraph');
  assert.equal(state.doc.firstChild.lastChild.child(1).type.name, 'heading');
});

test('rich block selector: Paragraph exits list/quote without adding a line or losing text', () => {
  for (const md of ['- word', '> word', '# word']) {
    const state = run(md, 'word', commands.setParagraphType('paragraph'));
    assert.equal(state.doc.childCount, 1);
    assert.equal(state.doc.firstChild.type.name, 'paragraph', md);
    assert.equal(state.doc.textContent, 'word');
  }
});

test('rich Enter and after-block action work after an atom such as a horizontal rule', () => {
  const doc = schema.nodes.doc.create(null, schema.nodes.horizontal_rule.create());
  for (const command of [commands.normalParagraph, commands.paragraphAfterBlock]) {
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, 0) }); let next;
    assert.equal(command(state, (tr) => { next = state.apply(tr); }), true);
    assert.equal(next.doc.firstChild.type.name, 'horizontal_rule');
    assert.equal(next.doc.lastChild.type.name, 'paragraph');
    assert.equal(next.selection.$from.parent.type.name, 'paragraph');
  }
});

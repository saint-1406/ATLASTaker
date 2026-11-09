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

test('rich Enter in a paragraph: a new line in it; twice: a new paragraph; saved as Markdown and back', async () => {
  const { serializeMarkdown } = await import('../src/rich/markdown.js');
  let state = run('first', 'first', commands.enterLine);
  assert.equal(state.doc.childCount, 1);
  assert.equal(state.doc.firstChild.lastChild.type.name, 'hard_break');
  state = state.apply(state.tr.insertText('second'));
  const saved = serializeMarkdown(state.doc).text;
  assert.match(saved, /^first {2}\nsecond/);
  assert.equal(parseMarkdown(saved).doc.firstChild.childCount, 3);
  // Enter twice: the empty line becomes the gap before a new paragraph
  let twice = run('first', 'first', commands.enterLine);
  assert.equal(commands.enterLine(twice, (tr) => { twice = twice.apply(tr); }), true);
  assert.equal(twice.doc.childCount, 2);
  assert.equal(twice.doc.firstChild.textContent, 'first');
  assert.equal(twice.doc.firstChild.childCount, 1);
  assert.equal(twice.selection.$from.parent, twice.doc.lastChild);
});

test('rich Enter: lists, headings and an empty paragraph keep their own Enter; Shift+Enter is the other one', () => {
  assert.equal(run('- word', 'word', commands.enterLine).doc.firstChild.childCount, 2);
  const heading = run('# word', 'word', commands.enterLine);
  assert.equal(heading.doc.lastChild.type.name, 'paragraph');
  assert.equal(heading.doc.childCount, 2);
  const shift = run('word', 'word', commands.shiftEnter);
  assert.equal(shift.doc.childCount, 2);
  const inList = run('- word', 'word', commands.shiftEnter);
  assert.equal(inList.doc.firstChild.childCount, 1);
  let hasBreak = false;
  inList.doc.descendants((node) => { if (node.type.name === 'hard_break') hasBreak = true; });
  assert.equal(hasBreak, true);
});

test('Backspace and an accordion: empty goes, one with words gives them back, an empty body steps to the title', () => {
  const at = (md, find) => {
    const doc = parseMarkdown(md).doc;
    let pos;
    doc.descendants((node, p) => { if (pos === undefined && node.type.name === find) pos = p + 1; });
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
    const ok = commands.backspaceDetails(state, (tr) => { state = state.apply(tr); });
    return { ok, state };
  };
  const empty = at('<details open>\n<summary></summary>\n\n</details>', 'summary');
  assert.equal(empty.ok, true);
  let names = []; empty.state.doc.descendants((node) => { names.push(node.type.name); });
  assert.equal(names.includes('details'), false);
  const full = at('<details open>\n<summary>Title</summary>\n\nBody text\n\n</details>', 'summary');
  assert.equal(full.ok, true);
  assert.equal(full.state.doc.child(0).textContent, 'Title');
  assert.equal(full.state.doc.child(1).textContent, 'Body text');
  names = []; full.state.doc.descendants((node) => { names.push(node.type.name); });
  assert.equal(names.includes('details'), false);
  const body = at('<details open>\n<summary>Title</summary>\n\n</details>', 'details_content');
  // the cursor at the start of the body's empty paragraph
  let state = body.state;
  const doc = parseMarkdown('<details open>\n<summary>Title</summary>\n\n</details>').doc;
  let pos; doc.descendants((node, p) => { if (pos === undefined && node.type.name === 'details_content') pos = p + 2; });
  state = EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
  assert.equal(commands.backspaceDetails(state, (tr) => { state = state.apply(tr); }), true);
  assert.equal(state.selection.$from.parent.type.name, 'summary');
  assert.equal(commands.backspaceDetails(EditorState.create({ doc: parseMarkdown('plain').doc }), null), false);
});

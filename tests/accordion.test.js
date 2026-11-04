import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorSelection } from '@codemirror/state';
import { history, undo, undoDepth } from '@codemirror/commands';
import * as accordion from '../src/accordion.js';
import { toHtml, toText } from '../src/exporters.js';
import { analyze } from '../src/markdown.js';

const block = (title = 'Раздел', body = 'текст', open = true) => `<details${open ? ' open' : ''}>\n<summary>${title}</summary>\n\n${body}\n\n</details>`;

test('accordion: note title and word count use content, not wrapper tags', () => {
  const note = analyze(block('A &amp; B', 'one two'));
  assert.equal(note.title, 'A & B');
  assert.equal(note.words, 4);
});

test('accordion: empty insertion, safe title, selected content and undo', () => {
  let state = EditorState.create({ doc: 'до текст после', selection: EditorSelection.single(3, 8), extensions: history() });
  const transaction = accordion.insertAccordion(state, 'A & <B>');
  state = state.update(transaction).state;
  assert.equal(state.doc.toString(), `до \n\n${block('A &amp; &lt;B&gt;', 'текст')}\n\n после`);
  assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), 'A &amp; &lt;B&gt;');
  assert.equal(undo({ get state() { return state; }, dispatch: (tr) => { state = tr.state; } }), true);
  assert.equal(state.doc.toString(), 'до текст после');
  const empty = EditorState.create();
  const inserted = empty.update(accordion.insertAccordion(empty, 'Section')).state;
  assert.equal(inserted.doc.toString(), block('Section', ''));
});

test('accordion: nested boundaries, decoded title and persistent toggle', () => {
  const text = block('A &amp; B', `before\n\n${block('Inner', 'secret', false)}\n\nafter`);
  const blocks = accordion.accordionBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].title, 'A & B');
  assert.equal(text.slice(blocks[0].from, blocks[0].to), text);
  assert.equal(text.slice(blocks[1].bodyFrom, blocks[1].closeFrom).trim(), 'secret');
  const state = EditorState.create({ doc: text });
  const toggled = state.update(accordion.toggleAccordion(state, blocks[0])).state;
  assert.equal(toggled.doc.toString(), text.replace('<details open>', '<details>'));
  assert.equal(accordion.accordionBlocks(toggled.doc.toString())[0].open, false);
});

test('accordion: title typing is one undo step and cannot introduce HTML', () => {
  let state = EditorState.create({ doc: block('A'), extensions: history() });
  for (const title of ['AB', 'ABC', 'ABC<script>']) {
    state = state.update(accordion.renameAccordion(state, accordion.accordionBlocks(state.doc.toString())[0], title)).state;
  }
  assert.equal(undoDepth(state), 1);
  assert.match(state.doc.toString(), /ABC&lt;script&gt;/);
  undo({ get state() { return state; }, dispatch: (tr) => { state = tr.state; } });
  assert.equal(state.doc.toString(), block('A'));
});

test('accordion: unfinished blocks, unsafe attributes and code examples remain literal', () => {
  assert.equal(accordion.accordionBlocks('<details>\n<summary>A</summary>\ntext').length, 0);
  assert.equal(accordion.accordionBlocks('<details onclick="bad()">\n<summary>A</summary>\nx\n</details>').length, 0);
  assert.equal(accordion.accordionBlocks('```html\n' + block() + '\n```').length, 0);
  assert.equal(accordion.accordionBlocks('~~~~\n```\n' + block() + '\n~~~~').length, 0);
  assert.equal(accordion.accordionBlocks(block().split('\n').map((s) => '    ' + s).join('\n')).length, 0);
  assert.equal(accordion.accordionBlocks('<!--\n' + block() + '\n-->').length, 0);
});

test('accordion: a comment example inside a fence does not swallow following blocks', () => {
  const text = '```html\n<!-- example\n```\n\n' + block();
  assert.equal(accordion.accordionBlocks(text).length, 1);
  const state = EditorState.create({ doc: text + '\n\n', selection: { anchor: text.length + 2 } });
  assert.ok(accordion.insertAccordion(state, 'Next'));
});

test('accordion: inline and indented code comments do not swallow following blocks', () => {
  for (const example of ['Use `<!--` to start a comment.', '    <!-- example']) {
    assert.equal(accordion.accordionBlocks(example + '\n\n' + block()).length, 1);
  }
  assert.equal(accordion.accordionBlocks('text <!--\n' + block() + '\n-->').length, 0);
});

test('accordion: insert outside code only; multiple selections are not silently lost', () => {
  const code = EditorState.create({ doc: '```\nexample\n```', selection: { anchor: 6 } });
  assert.equal(accordion.insertAccordion(code, 'Section'), null);
  const multi = EditorState.create({ doc: 'abc', selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(3)]), extensions: EditorState.allowMultipleSelections.of(true) });
  assert.equal(accordion.insertAccordion(multi, 'Section'), null);
});

test('accordion exports: nested interactive HTML, all text, safe titles and print expansion', () => {
  const text = block('A &amp; &lt;script&gt;', `**visible**\n\n${block('Inner', 'secret', false)}`, false);
  const html = toHtml(text);
  assert.match(html, /^<details>\n<summary>A &amp; &lt;script&gt;<\/summary>/);
  assert.match(html, /<strong>visible<\/strong>/);
  assert.match(html, /<details>\n<summary>Inner<\/summary>/);
  assert.doesNotMatch(html, /<script>/);
  const plain = toText(text);
  assert.match(plain, /A & <script>/);
  assert.match(plain, /visible/);
  assert.match(plain, /secret/);
  assert.doesNotMatch(plain, /<\/?(?:details|summary)>/);
  const print = toHtml(text, { expandDetails: true });
  assert.equal((print.match(/<details open>/g) || []).length, 2);
  assert.match(toHtml('```html\n' + text + '\n```'), /<pre><code>&lt;details&gt;/);
  assert.doesNotMatch(toHtml('<details onclick="bad()">\n<summary>x</summary>\n\ny\n\n</details>'), /<details onclick/);
});

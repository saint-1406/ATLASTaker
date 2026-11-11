import test from 'node:test';
import assert from 'node:assert/strict';
import { rangeText, tidyText } from '../src/reader/copyText.js';

// just enough of the DOM for rangeText: elements and text nodes
const text = (data) => ({ nodeType: 3, data });
const el = (tagName, children = [], { cls = '', hidden = false } = {}) => ({
  nodeType: 1,
  tagName,
  childNodes: children.map((c) => (typeof c === 'string' ? text(c) : c)),
  classList: { contains: (name) => cls.split(' ').includes(name) },
  getAttribute: (name) => (name === 'aria-hidden' && hidden ? 'true' : null),
});
const copy = (...children) => tidyText(rangeText({ childNodes: children }));

test('a copied passage keeps its paragraphs and line breaks', () => {
  assert.equal(copy(el('P', ['First\n   paragraph,  wrapped']), el('P', ['Second one.'])), 'First paragraph, wrapped\n\nSecond one.');
  assert.equal(copy(el('P', ['A line', el('BR'), 'and the next'])), 'A line\nand the next');
  // the reader's own units, headings and lists
  assert.equal(copy(el('DIV', ['Chapter 1'], { cls: 'rd-u' }), el('SPAN', ['loose ']), el('EM', ['words'])), 'Chapter 1\n\nloose words');
  assert.equal(copy(el('UL', [el('LI', ['one']), el('LI', ['two'])])), 'one\n\ntwo');
  // a selection inside one paragraph is just its words
  assert.equal(copy(text('only '), el('B', ['these']), text(' words')), 'only these words');
});

test('a copied passage leaves out what is not text', () => {
  assert.equal(copy(el('P', ['Text', el('SPAN', ['¹'], { hidden: true })]), el('STYLE', ['p{}'])), 'Text');
  // inside <pre> the line breaks stay
  assert.equal(copy(el('PRE', ['code\nmore code'])), 'code\nmore code');
});

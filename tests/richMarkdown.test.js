import test from 'node:test';
import assert from 'node:assert/strict';
import * as codec from '../src/rich/markdown.js';
import { toHtml, toText } from '../src/exporters.js';
import { analyze } from '../src/markdown.js';
import { richSchema as schema } from '../src/rich/schema.js';
import { commentsUnder } from '../src/comments.js';

const fixture = '# Заголовок\n\nОбычный **жирный** и *курсив*, ~~зачёркнутый~~, <u>подчёркнутый</u>.\n\n- [ ] задача\n- [x] готово\n\n1. первый\n2. второй\n\n> цитата\n\n```js\nconst a = 1;\n```\n\n[сайт](https://example.com) ![кот](assets/a-cat123.png)\n\n| a | b |\n| --- | --- |\n| c | d |\n\n<details open>\n<summary>Раздел</summary>\n\nВнутри **текст**\n\n</details>';

test('rich Markdown: all current structures survive a semantic round trip', () => {
  const first = codec.parseMarkdown(fixture).doc;
  const saved = codec.serializeMarkdown(first);
  const second = codec.parseMarkdown(saved.text).doc;
  assert.deepEqual(second.toJSON(), first.toJSON());
  assert.match(saved.text, /<details open>/);
  assert.match(saved.text, /- \[x\] готово/);
  const types = new Set(); first.descendants((node) => { types.add(node.type.name); });
  for (const type of ['heading', 'task_list', 'task_item', 'ordered_list', 'blockquote', 'code_block', 'image', 'table', 'details']) assert.ok(types.has(type), type);
});

test('rich Markdown: unsupported HTML/comments remain inert source blocks without data loss', () => {
  const source = '<script>alert("x")</script>\n\n<!-- keep this comment -->';
  const doc = codec.parseMarkdown(source).doc;
  assert.equal(doc.firstChild.type.name, 'source_block');
  assert.equal(codec.serializeMarkdown(doc).text, source);
});

test('rich Markdown: marks around spaces, literal syntax, links and escapes remain meaningful', () => {
  const source = 'one **bold** two ~~strike~~ and `**literal**`\\*';
  const doc = codec.parseMarkdown(source).doc;
  assert.deepEqual(codec.parseMarkdown(codec.serializeMarkdown(doc).text).doc.toJSON(), doc.toJSON());
  const safe = codec.parseMarkdown('[x](javascript:alert(1))');
  safe.doc.descendants((node) => assert.ok(!node.marks.some((mark) => mark.type.name === 'link' && mark.attrs.href.startsWith('javascript:'))));
});

test('rich Markdown: source mapping round trips text offsets across marks, lists and Unicode', () => {
  const parsed = codec.parseMarkdown('## A\n\n**Привет** мир\n\n- [ ] пункт');
  const encoded = codec.serializeMarkdown(parsed.doc);
  parsed.doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (let i = 0; i < node.text.length; i++) assert.equal(encoded.toDocument(encoded.toSource(pos + i)), pos + i);
  });
});

test('rich Markdown: nested accordions and unknown nodes do not eat their neighbors', () => {
  const text = '<details>\n<summary>Outer</summary>\n\na\n\n<details open>\n<summary>Inner</summary>\n\nb\n\n</details>\n\nc\n\n</details>\n\nafter';
  const doc = codec.parseMarkdown(text).doc;
  assert.equal(doc.firstChild.type.name, 'details');
  assert.equal(doc.lastChild.textContent, 'after');
  assert.deepEqual(codec.parseMarkdown(codec.serializeMarkdown(doc).text).doc.toJSON(), doc.toJSON());
});

test('rich Markdown: saved inline HTML marks export and count as visible words', () => {
  const text = '<strong>two words </strong>plain <s>old</s> <code>**literal**</code>';
  assert.match(toHtml(text), /<strong>two words <\/strong>plain <s>old<\/s>/);
  assert.equal(toText(text), 'two words plain old **literal**');
  assert.equal(analyze('<strong>Title</strong>\n\n<s>two words</s>').title, 'Title');
  assert.equal(analyze('<strong>Title</strong>\n\n<s>two words</s>').words, 3);
});

test('rich Markdown: literal text never becomes a block or link on reopen', () => {
  for (const text of ['- literal', '+ literal', '1. literal', '---', '    code', '\tcode', '===', 'https://example.com', 'a@b.com', 'A\n    code', ' trailing ', 'a  ', '   ', '\u00a0']) {
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text(text)));
    assert.deepEqual(codec.parseMarkdown(codec.serializeMarkdown(doc).text).doc.toJSON(), doc.toJSON(), text);
  }
});

test('rich Markdown: nested tasks, lists and multiline quotes retain structure', () => {
  for (const text of ['- [ ] first\n  - [x] child\n- [x] second', '- parent\n  - child\n- last', '> a\n>\n> b']) {
    const doc = codec.parseMarkdown(text).doc;
    assert.deepEqual(codec.parseMarkdown(codec.serializeMarkdown(doc).text).doc.toJSON(), doc.toJSON(), text);
  }
});

test('rich Markdown: accordion title formatting and punctuation survive; code entities stay literal', () => {
  const text = '<details open>\n<summary>A * B &amp; <strong>bold</strong></summary>\n\n`&amp;`\n\n</details>';
  const doc = codec.parseMarkdown(text).doc;
  assert.equal(doc.firstChild.firstChild.textContent, 'A * B & bold');
  assert.equal(doc.firstChild.lastChild.firstChild.textContent, '&amp;');
  assert.deepEqual(codec.parseMarkdown(codec.serializeMarkdown(doc).text).doc.toJSON(), doc.toJSON());
});

test('rich Markdown: multiple paragraphs in a table cell and column widths survive save', () => {
  const p = (text) => schema.nodes.paragraph.create(null, schema.text(text));
  const cell = schema.nodes.table_cell.create({ colspan: 1, rowspan: 1, colwidth: [140] }, [p('first'), p('second')]);
  const doc = schema.nodes.doc.create(null, schema.nodes.table.create(null, schema.nodes.table_row.create(null, cell)));
  assert.deepEqual(codec.parseMarkdown(codec.serializeMarkdown(doc).text).doc.toJSON(), doc.toJSON());
  assert.doesNotMatch(toHtml(codec.serializeMarkdown(doc).text), /&lt;table/);
  assert.match(toHtml(codec.serializeMarkdown(doc).text), /second/);
  assert.match(toText('before\n\n' + codec.serializeMarkdown(doc).text + '\n\nafter'), /first\nsecond/);
});

test('rich Markdown: a long formatted note retains cursor mapping in its middle', () => {
  const source = Array.from({ length: 500 }, (_, i) => `## Section ${i}\n\n**Some text with several words** plain & more.\n\n`).join('');
  const parsed = codec.parseMarkdown(source);
  const at = source.indexOf('Section 250');
  const pos = parsed.toDocument(at);
  assert.equal(parsed.doc.textBetween(pos, pos + 11), 'Section 250');
  assert.equal(parsed.toSource(pos), at);
});

test('rich Markdown: empty paragraphs, images and protected source blocks have exact cursor anchors', () => {
  const p = schema.nodes.paragraph;
  const doc = schema.nodes.doc.create(null, [p.create(null, schema.text('a')), p.create(), schema.nodes.source_block.create({ raw: '<!-- x -->' }), p.create(null, schema.nodes.image.create({ src: 'assets/a-cat123.png', alt: 'cat', title: '' }))]);
  const encoded = codec.serializeMarkdown(doc);
  doc.descendants((node, pos) => {
    if (node.type.name === 'source_block' || node.type.name === 'image') assert.equal(encoded.toDocument(encoded.toSource(pos)), pos, node.type.name);
    if (node.type.name === 'paragraph' && !node.content.size) assert.equal(encoded.toDocument(encoded.toSource(pos + 1)), pos + 1, 'empty paragraph');
  });
});

test('rich Markdown: task comments remain attached with an intact timestamp after editing/saving', () => {
  const source = '- [ ] call\n  💬 26.10.2026 17:52 · moved to Thursday\n- [x] done';
  const first = codec.parseMarkdown(source).doc;
  const saved = codec.serializeMarkdown(first).text;
  const lines = saved.split('\n'), task = lines.findIndex((line) => line.startsWith('- [ ]'));
  assert.equal(commentsUnder(lines, task + 1)[0]?.stamp, '26.10.2026 17:52');
  assert.deepEqual(codec.parseMarkdown(saved).doc.toJSON(), first.toJSON());
});

test('rich Markdown: soft breaks in table cells, spaced URLs and adjacent HTML do not lose data', () => {
  const paragraph = schema.nodes.paragraph.create(null, [schema.text('a'), schema.nodes.hard_break.create(), schema.text('LOST')]);
  const doc = schema.nodes.doc.create(null, schema.nodes.table.create(null, schema.nodes.table_row.create(null, schema.nodes.table_header.create(null, paragraph))));
  assert.deepEqual(codec.parseMarkdown(codec.serializeMarkdown(doc).text).doc.toJSON(), doc.toJSON());
  for (const source of ['![image](<https://example.com/a b.png>)', '[link](<https://example.com/a b>)']) {
    const parsed = codec.parseMarkdown(source).doc;
    assert.deepEqual(codec.parseMarkdown(codec.serializeMarkdown(parsed).text).doc.toJSON(), parsed.toJSON());
  }
  const html = '<table data-atlas-table=""><tr><td><p>keep</p></td></tr></table>\n<div>LOST</div>';
  assert.match(codec.serializeMarkdown(codec.parseMarkdown(html).doc).text, /LOST/);
});

test('rich Markdown: code, links and image pipes inside table cells stay inside the cell', () => {
  for (const content of [schema.text('a|b', [schema.marks.code.create()]), schema.text('link', [schema.marks.link.create({ href: 'https://example.com/a|b', title: 'x|y' })]), schema.nodes.image.create({ src: 'https://example.com/a.png', alt: 'a|b', title: '' })]) {
    const cell = schema.nodes.table_header.create(null, schema.nodes.paragraph.create(null, content));
    const doc = schema.nodes.doc.create(null, schema.nodes.table.create(null, schema.nodes.table_row.create(null, cell)));
    const saved = codec.serializeMarkdown(doc).text;
    assert.deepEqual(codec.parseMarkdown(saved).doc.toJSON(), doc.toJSON());
  }
});

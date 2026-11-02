import test from 'node:test';
import assert from 'node:assert/strict';
import { lookOf, lookOfDeclarations, parseBookCss } from '../src/reader/bookcss.js';
import { htmlBlocks } from '../src/reader/model.js';
import { parseXml } from '../src/reader/xml.js';

test('a book stylesheet: classes that mean italics, bold, alignment and indent', () => {
  const rules = parseBookCss(`
    /* calibre */
    .calibre5 { font-style: italic }
    span.b, .strong2 { font-weight: 700 }
    p.me { margin: 0 0 0 25%; text-align: justify }
    .them { margin-left: 0 }
    .centre { text-align: center !important }
    div > .skip { font-style: italic }
    a:hover { text-decoration: underline }
  `);
  assert.deepEqual(rules.get('calibre5'), { italic: true });
  assert.deepEqual(rules.get('b'), { bold: true });
  assert.equal(rules.get('me').indent, 2); // 25%: about 3 em
  assert.equal(rules.get('centre').align, 'center');
  assert.ok(!rules.has('skip'));
  assert.equal(lookOfDeclarations('padding-left: 2em').indent, 1);
  assert.deepEqual(lookOf({ class: 'x calibre5', style: 'font-weight: bold' }, rules), { italic: true, bold: true, underline: false, align: null, indent: 0 });
});

test('a message exchange keeps its two sides, emphasis by class shows as italics', () => {
  const rules = parseBookCss('.me { margin-left: 30% } .i { font-style: italic } .r { text-align: right }');
  const html = '<body><p>Mishka</p><div class="me"><p>Are you sure?</p><p>100%?</p></div><p>Vaughn actually <span class="i">replied</span>.</p><p class="r">Me</p></body>';
  const blocks = htmlBlocks(parseXml(html).children, { look: (attrs) => lookOf(attrs, rules), id: (x) => x, image: () => null, link: () => null });
  const pick = (b) => [b.attrs.class ?? '', JSON.stringify(b.children)];
  assert.deepEqual(blocks.map((b) => b.attrs.class ?? ''), ['', 'in-2', 'in-2', '', 'ta-right']);
  assert.match(pick(blocks[3])[1], /"tag":"em".*"replied"/);
});

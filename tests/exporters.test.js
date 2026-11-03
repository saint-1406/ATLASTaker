import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState } from '@codemirror/state';
import { htmlPage, toHtml, toText } from '../src/exporters.js';
import { collectTags, normalizeTag, tagsIn } from '../src/tags.js';
import { wrap } from '../src/format.js';

const NOTE = [
  '# План',
  '',
  'Купить **хлеб** и *молоко*, ~~сыр~~, <u>важно</u>, `код`.',
  '',
  '- один',
  '- [x] сделано',
  '- [ ] не сделано',
  '',
  '1. первый',
  '2. второй',
  '',
  '> цитата',
  '',
  '[сайт](https://example.com) и [опасная](javascript:alert(1))',
  '',
  '![кот](assets/a-cat123.png)',
  '',
  '```',
  'x = 1 # не тег',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
].join('\n');

test('html: what is bold is bold, lists and tasks are lists, a picture goes into the page', () => {
  const html = toHtml(NOTE, { images: new Map([['assets/a-cat123.png', 'data:image/png;base64,AAAA']]) });
  assert.match(html, /<h1>План<\/h1>/);
  assert.match(html, /<strong>хлеб<\/strong> и <em>молоко<\/em>, <s>сыр<\/s>, <u>важно<\/u>, <code>код<\/code>/);
  assert.match(html, /<ul>\n<li>один<\/li>/);
  assert.match(html, /<li class="task done"><span class="box">☑<\/span> сделано<\/li>/);
  assert.match(html, /<li class="task"><span class="box">☐<\/span> не сделано<\/li>/);
  assert.match(html, /<ol>\n<li>первый<\/li>/);
  assert.match(html, /<blockquote>\n<p>цитата<\/p>/);
  assert.match(html, /<a href="https:\/\/example.com">сайт<\/a>/);
  assert.ok(!html.includes('javascript:'), 'a script address does not become a link');
  assert.match(html, /<img src="data:image\/png;base64,AAAA" alt="кот">/);
  assert.match(html, /<pre><code>x = 1 # не тег<\/code><\/pre>/);
  assert.match(html, /<tr><th>a<\/th><th>b<\/th><\/tr>/);
  assert.ok(!/\*\*|~~|\]\(/.test(html.replace(/<pre>[\s\S]*?<\/pre>/g, '')), 'no marks are left');
});

test('html: text is escaped, a page wraps the body', () => {
  assert.equal(toHtml('a <script>x</script> & b'), '<p>a &lt;script&gt;x&lt;/script&gt; &amp; b</p>\n');
  const page = htmlPage('План <1>', '<p>x</p>');
  assert.match(page, /<title>План &lt;1&gt;<\/title>/);
  assert.match(page, /<meta charset="utf-8">/);
});

test('text: no marks, lists with bullets and boxes, links with their address', () => {
  const text = toText(NOTE);
  assert.match(text, /^План$/m);
  assert.match(text, /Купить хлеб и молоко, сыр, важно, код\./);
  assert.match(text, /^• один$/m);
  assert.match(text, /^☑ сделано$/m);
  assert.match(text, /^☐ не сделано$/m);
  assert.match(text, /^ {4}цитата$/m);
  assert.match(text, /сайт \(https:\/\/example.com\)/);
  assert.match(text, /^\[кот\]$/m);
  assert.match(text, /^x = 1 # не тег$/m, 'code stays as written');
  assert.ok(!text.includes('```'));
});

test('tags: words after #, not headings, not code, one tag whatever its case', () => {
  const found = tagsIn('# Заголовок\nидея #работа и #Работа/план\n`#нет` и https://a.b/#якорь\n```\n#тоже_нет\n```\n#да');
  assert.deepEqual(
    found.map((f) => [f.tag, f.line]),
    [
      ['работа', 1],
      ['Работа/план', 1],
      ['да', 6],
    ],
  );
  const tags = collectTags([
    { id: 'n-1', title: 'A', content: 'x #работа\ny #дом' },
    { id: 'n-2', title: 'B', content: '#Работа z' },
  ]);
  assert.equal(tags[0].tag, 'работа');
  assert.deepEqual(
    tags[0].places.map((p) => [p.id, p.line]),
    [
      ['n-1', 0],
      ['n-2', 0],
    ],
  );
  assert.equal(normalizeTag('  #мой тег!  '), 'мой_тег');
});

test('underline: <u> around the selection, and off again', () => {
  const run = (doc, from, to) => {
    const state = EditorState.create({ doc, selection: EditorSelection.single(from, to) });
    return state.update(wrap(state, '<u>', '</u>')).state.doc.toString();
  };
  assert.equal(run('one two', 4, 7), 'one <u>two</u>');
  assert.equal(run('one <u>two</u>', 7, 10), 'one two');
  assert.equal(run('one <u>two</u>', 4, 14), 'one two', 'the tags selected too');
});

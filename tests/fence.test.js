import test from 'node:test';
import assert from 'node:assert/strict';
import { fencedBlocks, planSlashFence } from '../src/fence.js';

// "|" marks the cursor: where "/#" was just typed, and where the cursor ends up
function type(marked) {
  const pos = marked.indexOf('|');
  const text = marked.replace('|', '');
  const plan = planSlashFence(text, pos);
  if (!plan) return null;
  const out = text.slice(0, plan.from) + plan.insert + text.slice(plan.to);
  return out.slice(0, plan.cursor) + '|' + out.slice(plan.cursor);
}

test('outside a block "/#" opens one, with the cursor inside', () => {
  assert.equal(type('Текст\n/#|'), 'Текст\n```\n|\n```');
  assert.equal(type('/#|\nдальше'), '```\n|\n```\nдальше');
});

test('in a list the block keeps the indentation', () => {
  assert.equal(type('- пункт\n  /#|'), '- пункт\n  ```\n  |\n  ```');
});

test('inside a block "/#" steps out below the closing fence', () => {
  assert.equal(type('```js\nlet a = 1;\n/#|\n```'), '```js\nlet a = 1;\n```\n|');
  assert.equal(type('```\ncode\n/#|\n\n```\nпосле'), '```\ncode\n```\n|\nпосле');
  assert.equal(type('```\ncode\n/#|\n```\n\nпосле'), '```\ncode\n```\n|\nпосле');
});

test('with code still below, the block is split there and keeps its language', () => {
  assert.equal(type('```python\na = 1\n/#|\nb = 2\n```'), '```python\na = 1\n```\n|\n```python\nb = 2\n```');
});

test('a block that was never closed gets its closing fence', () => {
  assert.equal(type('~~~~\ncode\n/#|'), '~~~~\ncode\n~~~~\n|');
});

test('"/#" with anything else on the line is just text', () => {
  assert.equal(type('a /#|'), null);
  assert.equal(type('/#|a'), null);
  assert.equal(type('/|#'), null);
});

test('fences are matched like Markdown: same character, at least as long', () => {
  const blocks = fencedBlocks(['````', '```', 'still code', '````', '~~~', 'x', '```', '~~~']);
  assert.deepEqual(
    blocks.map((b) => [b.open, b.close]),
    [
      [0, 3],
      [4, 7],
    ],
  );
  assert.deepEqual(fencedBlocks(['``` not `a` fence']), []);
});

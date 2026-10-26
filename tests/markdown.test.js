import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, countWords, deriveTitle, formatCount, WORD_FORMS } from '../src/markdown.js';

test('the title is the first meaningful line, without markup', () => {
  assert.equal(deriveTitle('\n\n# Экспедиция на север\n\nтекст'), 'Экспедиция на север');
  assert.equal(deriveTitle('- [ ] **Купить** [карту](https://example.com)'), 'Купить карту');
  assert.equal(deriveTitle('```js\nconst x = 1;\n```\nПосле кода'), 'После кода');
  assert.equal(deriveTitle('   \n'), '');
});

test('headings inside code fences are not peaks', () => {
  const info = analyze('# A\nraz dva\n```bash\n# not a heading\n```\n## B\nтри четыре пять\n');
  assert.deepEqual(info.headings.map((h) => [h.level, h.text, h.line]), [[1, 'A', 1], [2, 'B', 6]]);
  assert.equal(info.headings[1].words, 3);
  assert.equal(info.codeBlocks, 1);
});

test('a chapter summit includes its subsections', () => {
  const info = analyze('# A\nx\n## B\ny z\n## C\nw\n# D\nq');
  assert.deepEqual(info.headings.map((h) => [h.text, h.words]), [['A', 6], ['B', 2], ['C', 1], ['D', 1]]);
});

test('words are counted in Cyrillic and Latin alike', () => {
  assert.equal(countWords('Привет, world! Это — тест-драйв 2026.'), 5);
});

test('comment lines are counted and kept out of the excerpt', () => {
  const info = analyze('# План\n- [ ] Позвонить\n      💬 26.10.2026 17:52 · перенесли\nДальше текст');
  assert.equal(info.comments, 1);
  assert.equal(info.excerpt, 'Позвонить Дальше текст');
});

test('counts are written the Russian way', () => {
  assert.equal(formatCount(1, WORD_FORMS), '1 слово');
  assert.equal(formatCount(3, WORD_FORMS), '3 слова');
  assert.equal(formatCount(11, WORD_FORMS), '11 слов');
  assert.equal(formatCount(1204, WORD_FORMS).replace(/\s/g, ' '), '1 204 слова');
});

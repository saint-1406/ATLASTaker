import test from 'node:test';
import assert from 'node:assert/strict';
import { findIn, foldText, MAX_HITS, queryPattern, snippet } from '../src/reader/search.js';

// no-break space, soft hyphen, zero-width space
const [NBSP, SHY, ZW] = [0xa0, 0xad, 0x200b].map((c) => String.fromCharCode(c));
const NL = '\n';

/** The pieces of `text` a query finds. */
const find = (text, query, limit) => findIn(foldText(text), queryPattern(query), limit).map(([a, b]) => text.slice(a, b));

test('folding: lower case, ё as е, one space for every run, invisible marks gone', () => {
  const { text, map } = foldText(`  Ёлка${NL}${NL}  и${NBSP}ЕЛЬ${ZW}! `);
  assert.equal(text, 'елка и ель!');
  assert.equal(map.length, text.length);
  assert.equal(map[0], 2);
  assert.equal(map[4], 6); // the space stands where the run began
});

test('a word is found without regard to case or ё', () => {
  assert.deepEqual(find('Ёж. ежик. ЁЖИК. Еж', 'ёж'), ['Ёж', 'еж', 'ЁЖ', 'Еж']);
  assert.deepEqual(find('The Quick fox', 'quick'), ['Quick']);
});

test('a phrase is found whole, across line breaks and doubled spaces', () => {
  const text = `и вот${NL}   однажды  утром\r${NL}он ушёл`;
  assert.deepEqual(find(text, 'вот однажды утром'), [`вот${NL}   однажды  утром`]);
  assert.deepEqual(find(text, '  ОДНАЖДЫ   утром '), ['однажды  утром']);
  assert.deepEqual(find(text, 'утром он ушел'), [`утром\r${NL}он ушёл`]);
  assert.deepEqual(find(text, 'вот утром'), []);
});

test('a word cut at the end of a line is found whole; a real hyphen still matches', () => {
  assert.deepEqual(find(`большое сло-${NL}во тут`, 'слово'), [`сло-${NL}во`]);
  assert.deepEqual(find(`большое сло${SHY}${NL}во тут`, 'слово'), [`сло${SHY}${NL}во`]);
  assert.deepEqual(find(`кто-${NL}то пришёл`, 'кто-то пришел'), [`кто-${NL}то пришёл`]);
  assert.deepEqual(find('кто-то пришёл', 'кто-то'), ['кто-то']);
  // a dash between words is not a cut word
  assert.deepEqual(find(`конец -${NL}начало`, 'конецначало'), []);
});

test('special characters in the query are taken literally', () => {
  assert.deepEqual(find('a+b=c (x) [1] $5 a.b', 'a+b'), ['a+b']);
  assert.deepEqual(find('a+b=c (x) [1] $5 a.b', '(x)'), ['(x)']);
  assert.deepEqual(find('axb a.b', 'a.b'), ['a.b']);
  assert.deepEqual(find('100$ и $5', '$5'), ['$5']);
});

test('nothing to look for: an empty or blank query', () => {
  assert.equal(queryPattern(''), null);
  assert.equal(queryPattern(`  ${NL} `), null);
  assert.deepEqual(findIn(foldText('text'), null), []);
  assert.deepEqual(find('', 'word'), []);
});

test('matches do not overlap, and stop at the limit', () => {
  assert.deepEqual(find('aaaa', 'aa'), ['aa', 'aa']);
  const many = 'ла '.repeat(MAX_HITS + 50);
  assert.equal(find(many, 'ла').length, MAX_HITS);
  assert.equal(find(many, 'ла', 10).length, 10);
});

test('a snippet shows the words around a match on one line', () => {
  const text = `Первая строка текста.${NL}Вторая строка, где спрятано слово, и третья строка после него.`;
  const start = text.indexOf('слово');
  const [before, hit, after] = snippet(text, start, start + 5, 20);
  assert.equal(hit, 'слово');
  assert.ok(before.startsWith('…') && before.endsWith('спрятано '), before);
  assert.ok(after.startsWith(', и') && after.endsWith('…'), after);
  assert.ok(!before.includes(NL));
  assert.deepEqual(snippet('слово', 0, 5), ['', 'слово', '']);
  // a blank line ends the paragraph: the snippet stays inside it
  const blocks = `Глава 1${NL}${NL}Последний абзац: слово — конец.${NL}${NL}Глава 2`;
  const at = blocks.indexOf('слово');
  assert.deepEqual(snippet(blocks, at, at + 5), ['Последний абзац: ', 'слово', ' — конец.']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOOK, DEFAULT_READING, normalizeLook, normalizeReading, SKINS, THEMES, toneOf, TURNS } from '../src/skins.js';
import { STRINGS } from '../src/i18n.js';
import { activeHeading } from '../src/outline.js';

test('both looks name every piece of the interface, in every language', () => {
  for (const [lang, { look }] of Object.entries(STRINGS)) {
    assert.deepEqual(Object.keys(look).sort(), [...SKINS].sort(), `${lang}: one set of words per look`);
    const keys = (copy) => Object.keys(copy).sort();
    assert.deepEqual(keys(look.atlas), keys(look.minimal), lang);
    for (const [key, value] of Object.entries(look.minimal)) {
      assert.equal(typeof look.atlas[key], typeof value, `${lang}: ${key} differs in kind`);
    }
  }
  assert.equal(STRINGS.ru.look.minimal.coords(12, 4), 'Стр 12, кол 4');
  assert.equal(STRINGS.en.look.minimal.coords(12, 4), 'Ln 12, Col 4');
  assert.equal(STRINGS.ru.look.atlas.coords(12, 4), 'N 12° · E 4′');
});

test('unknown or missing preferences fall back to the minimal look', () => {
  assert.deepEqual(normalizeLook(), DEFAULT_LOOK);
  assert.deepEqual(normalizeLook({ skin: 'atlas', theme: 'system', accent: 'violet' }), { skin: 'atlas', theme: 'system', accent: 'violet' });
  assert.deepEqual(normalizeLook({ skin: 'neon', theme: 'mauve', accent: 'pink' }), DEFAULT_LOOK);
  assert.equal(normalizeLook({ theme: 'sepia' }).theme, 'sepia');
});

test('every theme has a tone, and the palettes sit on the right one', () => {
  for (const theme of THEMES) assert.ok(['light', 'dark'].includes(toneOf(theme)), theme);
  assert.equal(toneOf('sepia'), 'light');
  assert.equal(toneOf('night'), 'dark');
  assert.equal(toneOf('contrast'), 'dark');
  assert.equal(toneOf('system', false), 'light');
  assert.equal(toneOf('system', true), 'dark');
  for (const [lang, strings] of Object.entries(STRINGS)) {
    for (const theme of THEMES) assert.equal(typeof strings.themes[theme], 'string', `${lang}: themes.${theme}`);
  }
});

test('reading preferences keep only what the reader knows', () => {
  assert.deepEqual(normalizeReading(), DEFAULT_READING);
  assert.deepEqual(normalizeReading({ readMode: 'pages', readTurn: 'stack', readFont: 'sans', readLeading: 'loose' }), {
    readMode: 'pages',
    readTurn: 'stack',
    readFont: 'sans',
    readLeading: 'loose',
  });
  assert.equal(normalizeReading({ readTurn: 'explode' }).readTurn, 'flip');
  for (const turn of TURNS) assert.equal(typeof STRINGS.en.reader.turns[turn], 'string', turn);
});

test('the outline marks the section that holds the cursor', () => {
  const headings = [{ line: 1 }, { line: 5 }, { line: 12 }];
  assert.equal(activeHeading(headings, 1), 0);
  assert.equal(activeHeading(headings, 11), 1);
  assert.equal(activeHeading(headings, 40), 2);
  assert.equal(activeHeading([{ line: 3 }], 2), -1);
  assert.equal(activeHeading([], 2), -1);
});

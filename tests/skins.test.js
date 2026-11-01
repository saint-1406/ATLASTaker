import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOOK,
  DEFAULT_READ_LOOK,
  DEFAULT_READING,
  FONT_STACKS,
  isModified,
  normalizeLook,
  normalizeReadLook,
  normalizeReading,
  READ_FONTS,
  READ_THEME_DEFAULTS,
  READ_THEMES,
  shownTheme,
  SKINS,
  styleVars,
  themeStyle,
  THEMES,
  toneOf,
  TURNS,
} from '../src/skins.js';
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
  assert.deepEqual(normalizeReading({ readMode: 'pages', readTurn: 'stack', readLook: { theme: 'night', bright: 0.6 } }), {
    readMode: 'pages',
    readTurn: 'stack',
    readLook: { theme: 'night', auto: false, bright: 0.6, themes: {} },
  });
  assert.equal(normalizeReading({ readTurn: 'explode' }).readTurn, 'flip');
  for (const turn of TURNS) assert.equal(typeof STRINGS.en.reader.turns[turn], 'string', turn);
});

test('the old font and line spacing become changes to the app theme', () => {
  const { readLook } = normalizeReading({ readFont: 'sans', readLeading: 'loose' });
  assert.deepEqual(readLook.themes.app, { font: 'inter', custom: true, leading: 1.95 });
  assert.deepEqual(normalizeReading({ readFont: 'serif', readLeading: 'normal' }).readLook, DEFAULT_READ_LOOK);
});

test('reading themes keep only known, changed, in-range values', () => {
  const look = normalizeReadLook({
    theme: 'paper',
    auto: true,
    bright: 0.05,
    themes: { paper: { font: 'mono', leading: 9, letter: 3.4, justify: false, colour: 'red' }, light: { font: 'georgia' }, neon: { bold: true } },
  });
  assert.equal(look.bright, 0.3);
  // no justify is how paper came, georgia is how light came: nothing to keep for them
  assert.deepEqual(look.themes, { paper: { font: 'mono', leading: 2.4, letter: 3 } });
  assert.ok(isModified(look, 'paper'));
  assert.ok(!isModified(look, 'light'));
  assert.equal(normalizeReadLook({ theme: 'sepia' }).theme, 'app');
});

test('spacing counts only while "custom" is on; font and justify always', () => {
  const look = normalizeReadLook({ themes: { app: { font: 'garamond', bold: true, leading: 2, margin: 40, justify: true } } });
  const off = themeStyle(look, 'app');
  assert.equal(off.font, 'garamond');
  assert.equal(off.justify, true);
  assert.equal(off.leading, READ_THEME_DEFAULTS.app.leading);
  assert.equal(off.margin, 0);
  const on = themeStyle(normalizeReadLook({ themes: { app: { ...look.themes.app, custom: true } } }), 'app');
  assert.equal(on.leading, 2);
  assert.equal(on.margin, 40);
  const vars = styleVars(on);
  assert.equal(vars['--rd-weight'], '700');
  assert.equal(vars['--rd-align'], 'justify');
  assert.equal(vars['--rd-font'], FONT_STACKS.garamond);
});

test('auto-dark trades only a light page for night, and only in the dark', () => {
  assert.equal(shownTheme(normalizeReadLook({ theme: 'paper', auto: true }), true), 'night');
  assert.equal(shownTheme(normalizeReadLook({ theme: 'paper', auto: true }), false), 'paper');
  assert.equal(shownTheme(normalizeReadLook({ theme: 'paper', auto: false }), true), 'paper');
  assert.equal(shownTheme(normalizeReadLook({ theme: 'dusk', auto: true }), true), 'dusk');
});

test('every reading theme and font has a name in every language', () => {
  for (const [lang, strings] of Object.entries(STRINGS)) {
    for (const id of READ_THEMES) assert.equal(typeof strings.readThemes[id], 'string', `${lang}: ${id}`);
    for (const font of READ_FONTS) assert.equal(typeof strings.readFonts[font], 'string', `${lang}: ${font}`);
  }
  for (const id of READ_THEMES) assert.ok(READ_FONTS.includes(READ_THEME_DEFAULTS[id].font), id);
});

test('the outline marks the section that holds the cursor', () => {
  const headings = [{ line: 1 }, { line: 5 }, { line: 12 }];
  assert.equal(activeHeading(headings, 1), 0);
  assert.equal(activeHeading(headings, 11), 1);
  assert.equal(activeHeading(headings, 40), 2);
  assert.equal(activeHeading([{ line: 3 }], 2), -1);
  assert.equal(activeHeading([], 2), -1);
});

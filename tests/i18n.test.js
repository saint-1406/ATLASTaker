import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { count, currentLocale, detectLang, formatDay, formatTime, LANGS, localeFor, pickLang, setLang, STRINGS, t } from '../src/i18n.js';
import { analyze } from '../src/markdown.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CYRILLIC = /[А-Яа-яЁё]/;
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const at = (dict, key) => key.split('.').reduce((node, part) => node?.[part], dict);

/** Every leaf of a dictionary as "a.b.c" → its kind; a function's kind includes how many arguments it takes. */
function shape(node, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(node)) {
    const where = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') shape(value, where, out);
    else out[where] = typeof value === 'function' ? `function(${value.length})` : typeof value;
  }
  return out;
}

const withoutForms = ({ forms, ...rest }) => rest;

test('every key is there in both languages, of the same kind', () => {
  const reference = shape(withoutForms(STRINGS.ru));
  for (const { id } of LANGS) {
    assert.deepEqual(shape(withoutForms(STRINGS[id])), reference, `${id} differs from ru`);
    assert.deepEqual(Object.keys(STRINGS[id].forms).sort(), Object.keys(STRINGS.ru.forms).sort(), `${id}: plural nouns`);
  }
});

test('no text is empty and every argument shows up in its sentence', () => {
  for (const { id } of LANGS) {
    for (const [key, kind] of Object.entries(shape(withoutForms(STRINGS[id])))) {
      const value = at(STRINGS[id], key);
      if (kind === 'string') {
        assert.ok(value.trim(), `${id}: ${key} is empty`);
        continue;
      }
      const args = Array.from({ length: value.length }, (_, i) => `«arg${i}»`);
      const text = value(...args);
      assert.equal(typeof text, 'string', `${id}: ${key}`);
      for (const arg of args) assert.ok(text.includes(arg), `${id}: ${key} drops ${arg}`);
    }
  }
});

test('plural forms cover every case of each language', () => {
  for (const { id } of LANGS) {
    const cases = new Intl.PluralRules(localeFor(id)).resolvedOptions().pluralCategories;
    for (const [noun, forms] of Object.entries(STRINGS[id].forms)) {
      for (const c of cases) assert.ok(forms[c], `${id}: ${noun} has no "${c}" form`);
    }
  }
  assert.deepEqual(Object.keys(STRINGS.ru.forms.note).sort(), ['few', 'many', 'one', 'other']);
  assert.deepEqual(Object.keys(STRINGS.en.forms.note).sort(), ['one', 'other']);
});

test('counts are written each language’s way', () => {
  setLang('ru', []);
  assert.equal(count(1, 'word'), '1 слово');
  assert.equal(count(3, 'word'), '3 слова');
  assert.equal(count(11, 'word'), '11 слов');
  assert.equal(count(21, 'note'), '21 заметка');
  assert.equal(count(1204, 'word').replace(/\s/g, ' '), '1 204 слова');
  setLang('en', []);
  assert.equal(count(1, 'word'), '1 word');
  assert.equal(count(0, 'note'), '0 notes');
  assert.equal(count(21, 'note'), '21 notes');
  assert.equal(count(1204, 'word'), '1,204 words');
  assert.equal(count(3, 'line'), '3 lines');
  setLang('ru', []);
});

test('dates follow the language, and the browser’s variant of it', () => {
  const day = new Date(2026, 9, 27, 17, 5).getTime();
  setLang('ru', []);
  assert.equal(formatDay(day), '27 окт');
  assert.equal(formatTime(day), '17:05');
  setLang('en', []);
  assert.equal(currentLocale(), 'en-GB');
  assert.equal(formatDay(day), '27 Oct');
  assert.equal(formatTime(day), '17:05');
  setLang('en', ['ru-RU', 'en-US']);
  assert.equal(currentLocale(), 'en-US');
  assert.equal(formatDay(day), 'Oct 27');
  assert.match(formatTime(day), /^05:05\sPM$/u);
  setLang('ru', ['en-US', 'ru']);
  assert.equal(formatDay(day), '27 окт');
  setLang('ru', []);
});

test('the language to start in', () => {
  assert.equal(detectLang(['ru-RU', 'en-US']), 'ru');
  assert.equal(detectLang(['uk-UA', 'en-GB']), 'en');
  assert.equal(detectLang(['de-DE']), 'en');
  assert.equal(detectLang([]), 'en');
  assert.equal(pickLang({ saved: 'en', existing: true, preferred: ['ru'] }), 'en', 'a saved choice wins');
  assert.equal(pickLang({ existing: true, preferred: ['en-US'] }), 'ru', 'someone who used ATLAS before it spoke English stays in Russian');
  assert.equal(pickLang({ saved: 'de', preferred: ['en-US'] }), 'en');
  assert.equal(pickLang({ preferred: ['ru'] }), 'ru');
  assert.equal(localeFor('en', ['ru-RU', 'en-US']), 'en-US');
  assert.equal(localeFor('en', ['ru-RU']), 'en-GB');
  assert.equal(localeFor('ru', ['en']), 'ru-RU');
});

test('t() reads the current language and falls back to the key', () => {
  setLang('en', []);
  assert.equal(t('look.atlas.deleteTitle', 'Plan'), 'Sink the island “Plan”?');
  assert.equal(t('commands.otherLang'), 'Язык: русский');
  assert.equal(t('no.such.key'), 'no.such.key');
  setLang('ru', []);
  assert.equal(t('look.atlas.deleteTitle', 'План'), 'Затопить остров «План»?');
  assert.equal(t('commands.otherLang'), 'Language: English');
});

test('every word of index.html has a key in both languages', () => {
  const html = read('index.html');
  const fixes = { title: 'data-i18n-title', 'aria-label': 'data-i18n-label', placeholder: 'data-i18n-placeholder' };
  for (const [, tag, attrs, text] of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>([^<]*)/gi)) {
    const attr = (name) => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
    for (const [name, key] of Object.entries(fixes)) {
      if (CYRILLIC.test(attr(name) ?? '')) {
        assert.ok(attr(key) || (name === 'placeholder' && attr('data-copy-placeholder')), `<${tag}> ${name}="${attr(name)}" has no ${key}`);
      }
    }
    if (CYRILLIC.test(text)) assert.ok(attr('data-i18n') || attr('data-copy'), `<${tag}> «${text.trim()}» has no data-i18n`);
    for (const { id } of LANGS) {
      for (const key of ['data-i18n', ...Object.values(fixes)].map(attr).filter(Boolean)) {
        assert.equal(typeof at(STRINGS[id], key), 'string', `${id}: no ${key}`);
      }
      for (const key of [attr('data-copy'), attr('data-copy-placeholder')].filter(Boolean)) {
        for (const look of Object.values(STRINGS[id].look)) assert.equal(typeof look[key], 'string', `${id}: no look word ${key}`);
      }
    }
  }
  for (const [, text] of html.matchAll(/<\/[^>]+>([^<]*)/g)) assert.ok(!CYRILLIC.test(text), `loose text «${text.trim()}»`);
});

test('the interface code has no Russian of its own outside the dictionary', () => {
  const files = readdirSync(path.join(ROOT, 'src')).filter((name) => name.endsWith('.js') && name !== 'i18n.js');
  for (const name of files) {
    const code = read(path.join('src', name))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1')
      .replace(/keywords: '[^']*'/g, ''); // the palette searches in both languages at once
    const line = code.split('\n').find((l) => CYRILLIC.test(l));
    assert.equal(line, undefined, `${name}: ${line?.trim()}`);
  }
});

test('the English welcome notes say what the Russian ones say', () => {
  for (const [ru, en] of [
    ['welcome.md', 'welcome-en.md'],
    ['welcome-browser.md', 'welcome-browser-en.md'],
  ]) {
    const a = analyze(read(path.join('src', ru)));
    const b = analyze(read(path.join('src', en)));
    assert.ok(!CYRILLIC.test(read(path.join('src', en))), `${en} is in English`);
    assert.equal(b.title, 'Welcome to ATLAS');
    assert.deepEqual(b.headings.map((h) => h.level), a.headings.map((h) => h.level), en);
    assert.equal(b.codeBlocks, a.codeBlocks, en);
    assert.equal(b.comments, 1, `${en}: the sample comment is a real comment line`);
  }
});

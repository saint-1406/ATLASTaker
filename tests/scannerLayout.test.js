import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixScripts, joinLines, pageConfidence, pageParagraphs, scanText } from '../src/scanner/layout.js';

// What the recognizer (PP-OCRv5 det + eslav rec on ncnn) really answered for synthetic pages: made with
// the desktop prototype of the Android code (docs/scanner-ocr.md), so the boxes and the mistakes are real.
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scanner');
const page = (name) => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), 'utf8'));

function cer(got, truth) {
  const a = [...got];
  const b = [...truth];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1])));
    prev = cur;
  }
  return prev[b.length] / b.length;
}

/** A box for a piece of text: x, y of its top left, its width, the letters' height. */
const item = (text, x, y, w, h = 30, score = 0.95) => ({ text, score, box: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] });

test('Russian page: paragraphs as on paper, nearly every letter right', () => {
  const p = page('ru-flat');
  const paras = pageParagraphs(p.items);
  assert.equal(paras.length, p.truth.length, paras.join('\n|\n'));
  paras.forEach((got, i) => assert.ok(cer(got, p.truth[i]) < 0.02, `paragraph ${i}: ${got}`));
});

test('two columns are read one after the other, not across', () => {
  const p = page('columns');
  const paras = pageParagraphs(p.items);
  assert.equal(paras.length, 4, paras.join('\n|\n'));
  paras.forEach((got, i) => assert.ok(cer(got, p.truth[i]) < 0.03, `paragraph ${i}: ${got}`));
});

test('Russian and English mixed: look-alike letters put into the right alphabet', () => {
  for (const name of ['mixed-flat', 'mixed-photo-dim']) {
    const p = page(name);
    const raw = p.items.map((it) => it.text).join(' ');
    const text = scanText([p]);
    const truth = p.truth.join('\n\n');
    assert.ok(cer(text, truth) < cer(raw, truth.replace(/\n\n/g, ' ')), `${name}: fixing helps`);
    assert.ok(cer(text, truth) < 0.02, `${name}: ${(cer(text, truth) * 100).toFixed(1)}% wrong\n${text}`);
    for (const word of ['Android', 'Markdown', 'ncnn', 'OCR']) assert.ok(text.includes(word), `${name}: ${word}`);
  }
});

test('a page turned upside down or sideways reads as well once the recognizer stood it up', () => {
  for (const name of ['en-rot180', 'ru-rot90', 'ru-dim']) {
    const p = page(name);
    assert.ok(cer(scanText([p]), p.truth.join('\n\n')) < 0.02, name);
  }
  assert.equal(page('en-rot180').rotation, 180);
  assert.equal(page('ru-rot90').rotation, 270);
});

test('several pages: one text, pages in order', () => {
  const text = scanText([page('ru-flat'), page('en-rot180')]);
  assert.ok(text.indexOf('Отчёт о сканировании') < text.indexOf('Scanning report'));
  assert.match(text, /булок, да выпей чаю\./);
});

test('lines: in reading order, pieces of one line joined, a heading apart from its text', () => {
  const items = [
    item('Заголовок', 100, 100, 400, 50),
    item('вторая часть', 520, 200, 300),
    item('Первая строка,', 100, 200, 400),
    item('и ещё строка текста, которая тянется', 100, 245, 720),
    item('до самого края.', 100, 290, 300),
  ];
  assert.deepEqual(pageParagraphs(items), ['Заголовок', 'Первая строка, вторая часть и ещё строка текста, которая тянется до самого края.']);
  assert.deepEqual(pageParagraphs(items, { keepLines: true })[1].split('\n').length, 3);
});

test('a short line that ends a sentence ends its paragraph; a list item starts its own', () => {
  const items = [
    item('Первый абзац тянется через всю ширину строки и', 100, 100, 800),
    item('кончается здесь.', 100, 145, 250),
    item('Второй абзац начинается сразу, без пустой строки.', 100, 190, 800),
    item('1. пункт списка', 100, 235, 300),
    item('2. ещё пункт', 100, 280, 250),
  ];
  assert.equal(pageParagraphs(items).length, 4);
});

test('a word broken at the line end is joined again', () => {
  assert.equal(joinLines(['модели распознава-', 'ния лежат внутри']), 'модели распознавания лежат внутри');
  assert.equal(joinLines(['Wi-', 'Fi в офисе']), 'Wi- Fi в офисе', 'a capital after the hyphen: not a broken word');
  assert.equal(joinLines(['а', 'б'], true), 'а\nб');
});

test('unsure pieces are left out; confidence follows the text', () => {
  const items = [item('ясно', 0, 0, 100, 30, 0.95), item('шум', 0, 100, 100, 30, 0.2)];
  assert.deepEqual(pageParagraphs(items), ['ясно']);
  assert.ok(Math.abs(pageConfidence([{ text: 'aaaa', score: 1 }, { text: 'b', score: 0.5 }]) - 0.9) < 1e-9);
  assert.equal(pageConfidence([]), 0);
});

test('look-alike letters', () => {
  assert.equal(fixScripts('Andrоid'), 'Android', 'a Cyrillic о in a Latin word');
  assert.equal(fixScripts('сканеp'), 'сканер', 'a Latin p in a Russian word');
  assert.equal(fixScripts('GitНub и пспn'), 'GitHub и ncnn');
  assert.equal(fixScripts('обсудить AРІ'), 'обсудить API');
  assert.equal(fixScripts('EPUB, a также'), 'EPUB, а также', 'a lone "a" before a Russian word');
  assert.equal(fixScripts('I have a cat'), 'I have a cat');
  assert.equal(fixScripts('на C++ и C#'), 'на C++ и C#', 'C++ stays Latin');
  assert.equal(fixScripts('ОРЕХ и МОРЕ'), 'ОРЕХ и МОРЕ', 'one-alphabet words are left alone');
  assert.equal(fixScripts('сумма 12 500 Р, срок'), 'сумма 12 500 ₽, срок');
  assert.equal(fixScripts('Page 5 P, then'), 'Page 5 P, then', 'not in an English text');
});

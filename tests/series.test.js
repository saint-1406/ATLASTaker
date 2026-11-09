import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSeries, foldSeries, inSeries, searchText, seriesNames, seriesNumber, seriesOrder } from '../src/series.js';

test('series: a part is read from what was typed', () => {
  assert.equal(seriesNumber('2'), 2);
  assert.equal(seriesNumber('2,5'), 2.5);
  assert.equal(seriesNumber('#3'), 3);
  assert.equal(seriesNumber('часть 4'), 4);
  assert.equal(seriesNumber(''), null);
  assert.equal(seriesNumber('первая'), null);
  assert.equal(seriesNumber(7), 7);
  assert.equal(seriesNumber(-1), null);
  assert.equal(seriesNumber('1000000'), null);
});

test('series: names are kept tidy and compared without case', () => {
  assert.equal(cleanSeries('  Гарри   Поттер '), 'Гарри Поттер');
  assert.equal(cleanSeries('x'.repeat(300)).length, 120);
  assert.ok(inSeries({ series: 'гарри поттер' }, 'Гарри Поттер'));
  assert.ok(!inSeries({ series: '' }, ''));
  assert.deepEqual(seriesNames([{ series: 'Б' }, { series: 'а' }, { series: 'А ' }, {}]), ['а', 'Б']);
});

test('series: books lie in reading order, those without a part last', () => {
  const docs = [
    { title: 'Узник Азкабана', seriesNo: 3 },
    { title: 'Без номера' },
    { title: 'Философский камень', seriesNo: 1 },
    { title: 'Тайная комната', seriesNo: 2 },
  ];
  assert.deepEqual(seriesOrder(docs).map((d) => d.title), ['Философский камень', 'Тайная комната', 'Узник Азкабана', 'Без номера']);
});

test('series: on the shelf a series is one folder where its first book was', () => {
  const docs = [
    { id: 'a', title: 'A' },
    { id: 'hp3', series: 'Гарри Поттер', seriesNo: 3 },
    { id: 'b', title: 'B' },
    { id: 'hp1', series: 'гарри поттер', seriesNo: 1 },
  ];
  const items = foldSeries(docs);
  assert.equal(items.length, 3);
  assert.equal(items[0].doc.id, 'a');
  assert.equal(items[1].series, 'Гарри Поттер');
  assert.deepEqual(items[1].docs.map((d) => d.id), ['hp1', 'hp3']);
  assert.equal(items[2].doc.id, 'b');
});

test('series: a search finds a book by its series', () => {
  assert.match(searchText({ title: 'Философский камень', series: 'Гарри Поттер' }), /гарри поттер/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommands, createDictation, joinDictated, speechTag } from '../src/dictation.js';

test('a phrase joins the text: a space where words would touch, none where there is one', () => {
  assert.equal(joinDictated('Привет', 'как дела'), ' как дела');
  assert.equal(joinDictated('Привет ', 'как дела'), 'как дела');
  assert.equal(joinDictated('Привет', ', как дела'), ', как дела');
  assert.equal(joinDictated('(', 'скобка'), ' скобка', 'only closing marks hug the text before');
  assert.equal(joinDictated('слово', '  много   пробелов  '), ' много пробелов');
  assert.equal(joinDictated('слово', '   '), '');
});

test('a capital at the start of a line and after a full stop, not in the middle of a sentence', () => {
  assert.equal(joinDictated('', 'начало заметки'), 'Начало заметки');
  assert.equal(joinDictated('Первая строка\n', 'вторая строка'), 'Вторая строка');
  assert.equal(joinDictated('Конец фразы.', 'новая фраза'), ' Новая фраза');
  assert.equal(joinDictated('Вопрос? ', 'ответ'), 'Ответ');
  assert.equal(joinDictated('середина', 'фразы'), ' фразы');
  assert.equal(joinDictated('', 'hello world'), 'Hello world');
});

test('"new line" and "new paragraph" are done, not written, in either language', () => {
  assert.equal(applyCommands('первое новая строка второе'), 'первое\nвторое');
  assert.equal(applyCommands('первое. Новый абзац. Второе'), 'первое.\n\nВторое');
  assert.equal(applyCommands('one new line two'), 'one\ntwo');
  assert.equal(applyCommands('one new paragraph two'), 'one\n\ntwo');
  assert.equal(applyCommands('строкаа новая строками'), 'строкаа новая строками', 'only whole phrases');
  assert.equal(joinDictated('Список', 'новая строка второй пункт'), '\nВторой пункт');
});

test('the recognizer listens in the language of the interface', () => {
  assert.equal(speechTag('ru'), 'ru-RU');
  assert.equal(speechTag('en'), 'en-US');
  assert.equal(speechTag('de'), 'en-US');
});

test('on Android the phone does the listening: start, words, end', () => {
  const calls = [];
  const seen = { partial: [], final: [], state: [], error: [] };
  const android = {
    canDictate: () => true,
    startDictation: (lang) => calls.push(['start', lang]),
    stopDictation: () => calls.push(['stop']),
  };
  const handlers = Object.fromEntries(Object.keys(seen).map((key) => [key, (value) => seen[key].push(value)]));
  const dictation = createDictation({ android, handlers });
  assert.equal(dictation.supported, true);
  dictation.start('ru');
  assert.deepEqual(calls, [['start', 'ru-RU']]);
  assert.equal(dictation.listening, true);
  dictation.receive({ type: 'partial', text: 'при' });
  dictation.receive({ type: 'final', text: 'привет' });
  dictation.receive({ type: 'error', code: 'not-allowed' });
  assert.deepEqual(seen.partial, ['при', '', '']);
  assert.deepEqual(seen.final, ['привет']);
  assert.deepEqual(seen.error, ['not-allowed']);
  assert.deepEqual(seen.state, [true, false]);
  assert.equal(dictation.listening, false);
});

test('without speech recognition the button knows it cannot work', () => {
  const dictation = createDictation({ android: null, handlers: { partial() {}, final() {}, state() {}, error() {} } });
  assert.equal(dictation.supported, false);
});

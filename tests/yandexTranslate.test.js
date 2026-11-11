import test from 'node:test';
import assert from 'node:assert/strict';
import { batches, yandexEngine } from '../src/translate.js';
import { yandexTranslate } from '../server/translate.js';

test('pieces go to Yandex in batches it takes at once', () => {
  assert.deepEqual(batches(['aaaa', 'bbb', 'cc', 'd'], 7), [['aaaa', 'bbb'], ['cc', 'd']]);
  assert.deepEqual(batches(['a long piece'], 5), [['a long piece']]);
  assert.deepEqual(batches([], 5), []);
});

test('the Yandex engine is offered only with a key, and asks per batch', async () => {
  const sent = [];
  const engine = yandexEngine({ getKey: () => 'k', send: async (body) => (sent.push(body), body.texts.map((s) => s.toUpperCase())) });
  assert.equal(await engine.state('ru-en'), 'ready');
  assert.deepEqual(await engine.translate('en-ru', ['one', 'two']), ['ONE', 'TWO']);
  assert.deepEqual(sent, [{ key: 'k', from: 'en', to: 'ru', texts: ['one', 'two'] }]);
  assert.equal(await yandexEngine({ getKey: () => '', send: async () => [] }).state('ru-en'), 'unavailable');
});

const reply = (status, body) => async () => ({ status, ok: status < 300, json: async () => body });

test('the server asks Yandex with the key and says what went wrong', async () => {
  let asked;
  const fetchImpl = async (url, init) => {
    asked = { url, init };
    return reply(200, { translations: [{ text: 'привет' }] })();
  };
  assert.deepEqual(await yandexTranslate({ key: 'abc', from: 'en', to: 'ru', texts: ['hello'] }, { fetchImpl }), { texts: ['привет'] });
  assert.equal(asked.url, 'https://translate.api.cloud.yandex.net/translate/v2/translate');
  assert.equal(asked.init.headers.Authorization, 'Api-Key abc');
  assert.deepEqual(JSON.parse(asked.init.body), { sourceLanguageCode: 'en', targetLanguageCode: 'ru', format: 'PLAIN_TEXT', texts: ['hello'] });

  const body = { key: 'abc', from: 'ru', to: 'en', texts: ['привет'] };
  assert.deepEqual(await yandexTranslate(body, { fetchImpl: reply(401, {}) }), { code: 'yandex-key' });
  assert.deepEqual(await yandexTranslate(body, { fetchImpl: reply(429, {}) }), { code: 'yandex-quota' });
  assert.deepEqual(await yandexTranslate(body, { fetchImpl: async () => { throw new Error('offline'); } }), { code: 'network' });
  // nothing leaves for a request it should not make
  assert.deepEqual(await yandexTranslate({ ...body, key: '' }, { fetchImpl: reply(200, {}) }), { code: 'failed' });
  assert.deepEqual(await yandexTranslate({ ...body, to: 'de' }, { fetchImpl: reply(200, {}) }), { code: 'failed' });
  assert.deepEqual(await yandexTranslate({ ...body, key: 'a\nb' }, { fetchImpl: reply(200, {}) }), { code: 'failed' });
});

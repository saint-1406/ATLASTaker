import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmail, myMemoryEngine, splitText, translateWith, unentity } from '../src/translate.js';

const answer = (body, status = 200) => async () => ({ status, ok: status < 300, json: async () => body });
const ok = (text) => ({ responseData: { translatedText: text }, responseStatus: 200, quotaFinished: false });

test('MyMemory is asked one piece at a time, with the e-mail when there is one', async () => {
  const asked = [];
  const engine = myMemoryEngine({
    getEmail: () => 'me@example.com',
    fetchImpl: async (url) => {
      const u = new URL(url);
      asked.push({ q: u.searchParams.get('q'), langpair: u.searchParams.get('langpair'), de: u.searchParams.get('de') });
      return answer(ok(`[${u.searchParams.get('q')}]`))();
    },
  });
  assert.deepEqual(await engine.translate('en-ru', ['one', 'two']), ['[one]', '[two]']);
  assert.deepEqual(asked, [
    { q: 'one', langpair: 'en|ru', de: 'me@example.com' },
    { q: 'two', langpair: 'en|ru', de: 'me@example.com' },
  ]);
});

test('a passage goes to MyMemory in pieces it takes (500 bytes: 200 letters), paragraphs kept', async () => {
  const engine = myMemoryEngine({ getEmail: () => '', fetchImpl: async (url) => answer(ok(new URL(url).searchParams.get('q').toUpperCase()))() });
  const long = `${'слово '.repeat(80).trim()}.`;
  for (const piece of splitText(long, engine.maxPiece)) assert.ok(new TextEncoder().encode(piece.text).length <= 500);
  assert.equal(await translateWith(engine, 'ru-en', 'Первый.\n\nВторой.'), 'ПЕРВЫЙ.\n\nВТОРОЙ.');
});

test('MyMemory says when the day is used up or it is out of reach', async () => {
  const run = (fetchImpl) => myMemoryEngine({ getEmail: () => '', fetchImpl }).translate('en-ru', ['hi']).catch((e) => e.code);
  assert.equal(await run(answer({}, 429)), 'quota');
  assert.equal(await run(answer({ responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' }, responseStatus: 200 })), 'quota');
  assert.equal(await run(answer({ responseData: { translatedText: 'x' }, responseStatus: 200, quotaFinished: true })), 'quota');
  assert.equal(await run(async () => { throw new TypeError('Failed to fetch'); }), 'network');
  assert.equal(await run(answer({ responseStatus: 403, responseData: {} })), 'failed');
  assert.equal(await myMemoryEngine({ online: () => false }).state('en-ru'), 'unavailable');
});

test('MyMemory’s entities become characters; e-mails are checked', () => {
  assert.equal(unentity('It&#39;s &quot;fine&quot; &amp; good&#8230;'), 'It\'s "fine" & good…');
  assert.ok(isEmail('name@example.com'));
  assert.ok(!isEmail('name@example'));
  assert.ok(!isEmail('no spaces@example.com'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { whenRunning } from '../server/launchUtil.js';
import { isNewer } from '../server/server.js';

const mine = { version: '0.19.19', build: 'b-mine' };

test('a start opens a window to a server of its very build', () => {
  assert.equal(whenRunning({ version: '0.19.19', build: 'b-mine' }, mine, isNewer), 'open');
});

test('an older start never ends a newer app: it opens a window to it', () => {
  assert.equal(whenRunning({ version: '0.19.20', build: 'b-new' }, mine, isNewer), 'open');
  assert.equal(whenRunning({ version: '0.20.0', build: 'b-new' }, mine, isNewer), 'open');
});

test('a server of an older version is replaced by the newer start', () => {
  assert.equal(whenRunning({ version: '0.19.9', build: 'b-old' }, mine, isNewer), 'replace');
  assert.equal(whenRunning({ version: '0.19.18', build: 'b-old' }, mine, isNewer), 'replace');
});

test('the same version built anew (the code on disk changed) is replaced, as after an update', () => {
  assert.equal(whenRunning({ version: '0.19.19', build: 'b-other' }, mine, isNewer), 'replace');
});

test('a server too old to say its version is replaced', () => {
  assert.equal(whenRunning({ build: 'b-ancient' }, mine, isNewer), 'replace');
});

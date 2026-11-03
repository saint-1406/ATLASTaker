import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../server/server.js';

test('a version is newer only when it really is', () => {
  assert.equal(isNewer('0.16.0', '0.15.0'), true);
  assert.equal(isNewer('0.15.10', '0.15.9'), true, 'numbers, not letters');
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.15.0', '0.15.0'), false);
  assert.equal(isNewer('0.14.2', '0.15.0'), false);
  assert.equal(isNewer('0.16', '0.15.9'), true, 'a missing part counts as 0');
});

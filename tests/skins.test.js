import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY, DEFAULT_LOOK, normalizeLook } from '../src/skins.js';
import { activeHeading } from '../src/outline.js';

test('both looks name every piece of the interface', () => {
  const keys = (copy) => Object.keys(copy).sort();
  assert.deepEqual(keys(COPY.atlas), keys(COPY.minimal));
  for (const [key, value] of Object.entries(COPY.minimal)) {
    assert.equal(typeof COPY.atlas[key], typeof value, `${key} differs in kind`);
  }
  assert.equal(COPY.minimal.coords(12, 4), 'Стр 12, кол 4');
  assert.equal(COPY.atlas.coords(12, 4), 'N 12° · E 4′');
});

test('unknown or missing preferences fall back to the minimal look', () => {
  assert.deepEqual(normalizeLook(), DEFAULT_LOOK);
  assert.deepEqual(normalizeLook({ skin: 'atlas', theme: 'system', accent: 'violet' }), { skin: 'atlas', theme: 'system', accent: 'violet' });
  assert.deepEqual(normalizeLook({ skin: 'neon', theme: 'sepia', accent: 'pink' }), DEFAULT_LOOK);
});

test('the outline marks the section that holds the cursor', () => {
  const headings = [{ line: 1 }, { line: 5 }, { line: 12 }];
  assert.equal(activeHeading(headings, 1), 0);
  assert.equal(activeHeading(headings, 11), 1);
  assert.equal(activeHeading(headings, 40), 2);
  assert.equal(activeHeading([{ line: 3 }], 2), -1);
  assert.equal(activeHeading([], 2), -1);
});

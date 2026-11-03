import test from 'node:test';
import assert from 'node:assert/strict';
import { changedKeys, createSteps, stepKey } from '../src/undo.js';

/** A counter to step: each step adds `by`, and undoing takes it off again. */
function counter() {
  const box = { value: 0 };
  const steps = createSteps({ limit: 3 });
  const add = (by) => {
    box.value += by;
    steps.push({ undo: () => (box.value -= by), redo: () => (box.value += by) });
  };
  return { box, steps, add };
}

test('steps: back and forward one at a time, in order', async () => {
  const { box, steps, add } = counter();
  add(1);
  add(10);
  assert.equal(box.value, 11);
  assert.ok(await steps.undo());
  assert.equal(box.value, 1);
  assert.ok(await steps.undo());
  assert.equal(box.value, 0);
  assert.equal(await steps.undo(), false, 'nothing left to undo');
  assert.ok(steps.canRedo());
  await steps.redo();
  assert.equal(box.value, 1);
  await steps.redo();
  assert.equal(box.value, 11);
  assert.equal(steps.canRedo(), false);
});

test('steps: something new done after going back drops what was ahead', async () => {
  const { box, steps, add } = counter();
  add(1);
  add(10);
  await steps.undo();
  add(100);
  assert.equal(steps.canRedo(), false);
  await steps.undo();
  await steps.undo();
  assert.equal(box.value, 0);
});

test('steps: only the last ones are kept', async () => {
  const { box, steps, add } = counter();
  for (const by of [1, 2, 4, 8]) add(by);
  while (await steps.undo());
  assert.equal(box.value, 1, 'the oldest step fell off the end');
});

test('steps: past the budget the oldest heavy steps go, the newest always stays', async () => {
  const steps = createSteps({ budget: 100 });
  const step = (weight) => ({ undo() {}, redo() {}, weight });
  steps.push(step(40));
  steps.push(step(40));
  steps.push(step(40)); // 120 > 100: the first goes
  let n = 0;
  while (await steps.undo()) n++;
  assert.equal(n, 2);
  const big = createSteps({ budget: 10 });
  big.push(step(500));
  assert.ok(big.canUndo(), 'one step heavier than the budget is still kept');
});

test('steps: what a step does while it is replayed is not a new step', async () => {
  const steps = createSteps();
  steps.push({
    undo: () => steps.push({ undo() {}, redo() {} }),
    redo() {},
  });
  await steps.undo();
  assert.equal(steps.canUndo(), false, 'the push inside the replay was ignored');
  assert.ok(steps.canRedo());
});

test('steps: a step that fails does not stop the history', async () => {
  const steps = createSteps();
  steps.push({ undo() {}, redo() {} });
  steps.push({
    undo() {
      throw new Error('disk gone');
    },
    redo() {},
  });
  const error = console.error;
  console.error = () => {};
  try {
    await steps.undo();
  } finally {
    console.error = error;
  }
  assert.equal(steps.replaying(), false);
  assert.ok(steps.canUndo(), 'the older step is still there');
});

test('changed keys: added, removed and changed entries; equal ones are left alone', () => {
  const before = { $folders: ['Work'], a: 'Work', b: '', c: { shelf: 'x', finished: false } };
  const after = { $folders: ['Work', 'Home'], a: 'Work', c: { shelf: 'x', finished: true }, d: '' };
  assert.deepEqual(changedKeys(before, after).sort(), ['$folders', 'b', 'c', 'd']);
  assert.deepEqual(changedKeys(before, structuredClone(before)), []);
});

test('step keys: Ctrl+Z back, Ctrl+Y and Ctrl+Shift+Z forward, by the key whatever the layout; not inside a field', () => {
  const key = (code, extra = {}) => ({ code, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, target: null, ...extra });
  assert.equal(stepKey(key('KeyZ')), 'undo');
  assert.equal(stepKey(key('KeyZ', { shiftKey: true })), 'redo');
  assert.equal(stepKey(key('KeyY')), 'redo');
  assert.equal(stepKey(key('KeyZ', { ctrlKey: false, metaKey: true })), 'undo', 'Cmd on a Mac');
  assert.equal(stepKey(key('KeyZ', { ctrlKey: false })), null);
  assert.equal(stepKey(key('KeyZ', { altKey: true })), null);
  assert.equal(stepKey(key('KeyX')), null);
  const field = { closest: (sel) => (sel.includes('textarea') ? {} : null) };
  assert.equal(stepKey(key('KeyZ', { target: field })), null, 'a field undoes its own typing');
});

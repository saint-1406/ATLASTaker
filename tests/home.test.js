import test from 'node:test';
import assert from 'node:assert/strict';
import { addReading, dayKey, streakOf } from '../src/home.js';

test('minutes read add up per day, old days drop off', () => {
  const day = new Date(2026, 10, 1, 20, 0);
  let days = addReading({ '2026-08-01': 30 }, 0.5, day);
  days = addReading(days, 0.5, day);
  assert.deepEqual(days, { '2026-11-01': 1 });
  assert.equal(dayKey(day), '2026-11-01');
});

test('the streak counts days in a row, today or up to yesterday', () => {
  const today = new Date(2026, 10, 5, 9, 0);
  const days = { '2026-11-02': 5, '2026-11-03': 12, '2026-11-04': 1 };
  assert.equal(streakOf(days, today), 3); // nothing yet today: the streak still stands
  assert.equal(streakOf({ ...days, '2026-11-05': 2 }, today), 4);
  assert.equal(streakOf({ '2026-11-03': 9 }, today), 0);
  assert.equal(streakOf({ '2026-11-04': 0.5 }, today), 0); // under a minute does not count
});

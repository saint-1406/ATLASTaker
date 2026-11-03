import test from 'node:test';
import assert from 'node:assert/strict';
import { heatCells, lastDays, noteWriting, writingStreak } from '../src/writing.js';
import { mergeSettings, mergeWriting } from '../src/sync/merge.js';
import { MAX_VERSIONS, versionsToKeep } from '../src/versionRules.js';
import { checkPin, hashPin, waitAfter } from '../src/lock.js';

const day = (s) => new Date(`${s}T12:00:00`);

test('writing log: written and grown per day; an undo shrinks the text but writes nothing', () => {
  let log = noteWriting({}, 120, 120, day('2026-11-02'));
  log = noteWriting(log, 30, 30, day('2026-11-03'));
  log = noteWriting(log, 0, -50, day('2026-11-03'));
  assert.deepEqual(log.writeDays, { '2026-11-02': 120, '2026-11-03': 30 });
  assert.deepEqual(log.growDays, { '2026-11-02': 120, '2026-11-03': -20 });
  assert.equal(lastDays(log.writeDays, 7, day('2026-11-03')), 150);
  assert.equal(lastDays(log.growDays, 1, day('2026-11-03')), -20);
});

test('writing log: days in a row, up to today or yesterday', () => {
  const days = { '2026-11-01': 5, '2026-11-02': 9, '2026-10-30': 3 };
  assert.equal(writingStreak(days, day('2026-11-02')), 2);
  assert.equal(writingStreak(days, day('2026-11-03')), 2, 'today has nothing yet: yesterday counts');
  assert.equal(writingStreak(days, day('2026-11-05')), 0);
});

test('heat map: 26 weeks of seven days, Monday first, today last, levels by quarters of the busiest day', () => {
  const days = { '2026-11-03': 1000, '2026-11-02': 10, '2026-10-20': 100, '2026-10-21': 500 };
  const cells = heatCells(days, 26, day('2026-11-03')); // a Tuesday
  assert.equal(cells.length, 26 * 7);
  assert.equal(cells.filter((c) => c === null).length, 5, 'Wednesday to Sunday of this week are to come');
  const at = (key) => cells.find((c) => c?.day === key);
  assert.equal(at('2026-11-03').level, 4);
  assert.equal(at('2026-11-02').level, 1);
  assert.equal(cells[0].day, '2026-05-11', 'the first cell is a Monday');
  assert.ok(cells.filter((c) => c && !c.value).every((c) => c.level === 0));
});

test('writing logs from two devices: of each day the larger, not the sum', () => {
  assert.deepEqual(mergeWriting({ a: 10, b: -40 }, { a: 25, c: 3, b: 5 }), { a: 25, b: -40, c: 3 });
  const local = { values: { writeDays: { '2026-11-01': 10 } }, at: {} };
  const remote = { values: { writeDays: { '2026-11-01': 4, '2026-11-02': 7 } }, at: { writeDays: 5 } };
  const merged = mergeSettings(local, remote);
  assert.deepEqual(merged.values.writeDays, { '2026-11-01': 10, '2026-11-02': 7 });
  assert.ok(merged.upload, 'Drive gets the merged log');
  assert.ok('writeDays' in merged.toLocal, 'and so does this device');
});

test('versions: every one of the last day, one an hour for a week, one a day after; 60 at most', () => {
  const now = Date.UTC(2026, 10, 3, 12);
  const H = 3600e3;
  const times = [now - 60e3, now - 2 * 60e3, now - 3 * H, now - 30 * H + 60e3, now - 30 * H, now - 10 * 24 * H, now - 10 * 24 * H - 2 * H];
  assert.deepEqual(versionsToKeep(times, now), [now - 60e3, now - 2 * 60e3, now - 3 * H, now - 30 * H + 60e3, now - 10 * 24 * H]);
  const many = Array.from({ length: 200 }, (_, i) => now - i * 60e3);
  assert.equal(versionsToKeep(many, now).length, MAX_VERSIONS);
});

test('PIN: kept as a salted hash, checked exactly; waits grow after a few wrong ones', async () => {
  const lock = await hashPin('2580', 60, 10_000);
  assert.equal(lock.len, 4);
  assert.equal(lock.after, 60);
  assert.ok(!JSON.stringify(lock).includes('2580'), 'the PIN itself is not kept');
  assert.ok(await checkPin('2580', lock));
  assert.equal(await checkPin('2581', lock), false);
  assert.equal(await checkPin('25', lock), false);
  const other = await hashPin('2580', 0, 10_000);
  assert.notEqual(other.hash, lock.hash, 'a new salt every time');
  assert.equal(waitAfter(4), 0);
  assert.equal(waitAfter(5), 30_000);
  assert.equal(waitAfter(6), 60_000);
  assert.equal(waitAfter(30), 15 * 60_000);
});

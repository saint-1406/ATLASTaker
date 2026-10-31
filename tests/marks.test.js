import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MARKS, mergeRects, newMarkId, sortMarks, validAnchor, validMark, validMarks } from '../src/marks.js';

const mark = (patch = {}) => ({ id: newMarkId(), color: 'yellow', note: '', text: 'a passage', anchor: { a: 2, ao: 5, b: 3, bo: 1 }, created: 1, ...patch });

test('a mark is a colour, a comment and a place the reader can find again', () => {
  assert.ok(validMark(mark()));
  assert.ok(validMark(mark({ note: 'why it matters', where: 'Chapter 2', edited: 5 })));
  assert.ok(validMark(mark({ anchor: { rects: [[1, 0.1, 0.2, 0.3, 0.02], [2, 0, 0, 1, 0.05]] } })));
  assert.ok(!validMark(mark({ color: 'red' })), 'only the known colours');
  assert.ok(!validMark(mark({ id: '../x' })));
  assert.ok(!validMark(mark({ note: 'x'.repeat(10_001) })));
  assert.ok(!validMark(mark({ anchor: { a: 3, ao: 0, b: 2, bo: 4 } })), 'the end comes after the start');
  assert.ok(!validMark(mark({ anchor: { a: 1, ao: 4, b: 1, bo: 4 } })), 'not empty');
  assert.ok(!validAnchor({ rects: [] }));
  assert.ok(!validAnchor({ rects: [[0, 0, 0, 1, 1]] }), 'pages count from 1');
  assert.ok(!validAnchor({ rects: [[1, 0, 0, 7, 1]] }), 'fractions of the page');
});

test('a list of marks is all good or refused, without two marks under one id', () => {
  const one = mark();
  assert.ok(validMarks([]));
  assert.ok(validMarks([one, mark()]));
  assert.ok(!validMarks([one, one]));
  assert.ok(!validMarks([one, { ...mark(), color: 'black' }]));
  assert.ok(!validMarks({ length: 0 }));
  assert.ok(!validMarks(Array.from({ length: MAX_MARKS + 1 }, () => mark())));
});

test('PDF boxes side by side on one line merge into one', () => {
  const merged = mergeRects([
    [1, 0.3, 0.1, 0.2, 0.02],
    [1, 0.1, 0.1, 0.2, 0.02],
    [1, 0.1, 0.13, 0.4, 0.02],
    [2, 0.1, 0.1, 0.1, 0.02],
  ]);
  assert.deepEqual(merged, [
    [1, 0.1, 0.1, 0.4, 0.02],
    [1, 0.1, 0.13, 0.4, 0.02],
    [2, 0.1, 0.1, 0.1, 0.02],
  ]);
});

test('marks sort in reading order', () => {
  const late = mark({ anchor: { a: 9, ao: 0, b: 9, bo: 3 } });
  const early = mark({ anchor: { a: 1, ao: 7, b: 2, bo: 0 } });
  const earlier = mark({ anchor: { a: 1, ao: 2, b: 1, bo: 6 } });
  assert.deepEqual(sortMarks([late, early, earlier]).map((m) => m.id), [earlier.id, early.id, late.id]);
  const p2 = mark({ anchor: { rects: [[2, 0.1, 0.1, 0.1, 0.02]] } });
  const p1low = mark({ anchor: { rects: [[1, 0.1, 0.8, 0.1, 0.02]] } });
  const p1high = mark({ anchor: { rects: [[1, 0.5, 0.2, 0.1, 0.02]] } });
  assert.deepEqual(sortMarks([p2, p1low, p1high]).map((m) => m.id), [p1high.id, p1low.id, p2.id]);
});

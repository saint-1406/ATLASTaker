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

test('a bookmark is a kept place with a name', async () => {
  const { newBookmarkId, validBookmark, validBookmarks } = await import('../src/marks.js');
  const b = { id: newBookmarkId(), position: { at: 12, frac: 0.3 }, progress: 0.4, label: 'Глава 2 · 40%', snippet: 'Он вошёл', created: 1 };
  assert.ok(validBookmark(b));
  assert.ok(validBookmark({ ...b, position: { page: 7, frac: 0 }, snippet: undefined }));
  assert.ok(!validBookmark({ ...b, progress: 2 }));
  assert.ok(!validBookmark({ ...b, position: null }));
  assert.ok(!validBookmark({ ...b, id: 'm-abcdef' }));
  assert.ok(validBookmarks([b]));
  assert.ok(!validBookmarks([b, b]));
});

test('after a PDF\'s pages change, marks and bookmarks follow their pages', async () => {
  const { remapPdf, turnBox } = await import('../src/marks.js');
  // a quarter turn clockwise: the top-left corner goes to the top-right
  assert.deepEqual(turnBox([0.1, 0.2, 0.3, 0.05], 90).map((v) => Math.round(v * 1000) / 1000), [0.75, 0.1, 0.05, 0.3]);
  assert.deepEqual(turnBox(turnBox([0.1, 0.2, 0.3, 0.05], 90), 270).map((v) => Math.round(v * 1000) / 1000), [0.1, 0.2, 0.3, 0.05]);
  assert.deepEqual(turnBox([0.1, 0.2, 0.3, 0.05], 180).map((v) => Math.round(v * 1000) / 1000), [0.6, 0.75, 0.3, 0.05]);
  const m = (page, id) => ({ id, color: 'yellow', note: '', text: 'x', where: `p. ${page}`, anchor: { rects: [[page, 0.1, 0.2, 0.3, 0.05]] }, created: 1 });
  const marks = [m(1, 'm-aaaa'), m(2, 'm-bbbb'), m(3, 'm-cccc')];
  const bookmarks = [{ id: 'b-aaaa', position: { page: 3, frac: 0.5 }, progress: 1, label: 'Page 3', created: 1 }];
  // page 3 first, page 1 turned, page 2 gone, a page from another file at the end
  const plan = [{ src: 0, page: 3, turn: 0 }, { src: 0, page: 1, turn: 90 }, { src: 1, page: 1, turn: 0 }];
  const out = remapPdf({ marks, bookmarks }, plan);
  assert.deepEqual(out.marks.map((x) => [x.id, x.anchor.rects[0][0], x.where]), [['m-aaaa', 2, 'p. 2'], ['m-cccc', 1, 'p. 1']]);
  assert.deepEqual(out.marks[0].anchor.rects[0].slice(1), [0.75, 0.1, 0.05, 0.3]);
  assert.deepEqual(out.bookmarks.map((b) => [b.position.page, b.label, b.progress]), [[1, 'Page 1', 0]]);
});

test('texts on a PDF page: well formed or refused, a list without two under one id', async () => {
  const { newTextId, validText, validTexts, sortTexts } = await import('../src/marks.js');
  const item = { id: newTextId(), page: 2, x: 0.1, y: 0.2, w: 0.4, text: 'Привет', size: 0.022, color: 'red', created: 1 };
  assert.ok(validText(item));
  assert.ok(validTexts([item]));
  assert.ok(!validTexts([item, item]));
  for (const bad of [{ page: 0 }, { x: 1.2 }, { w: 0 }, { color: 'yellow' }, { size: 1 }, { text: 5 }, { id: 'm-abcdef' }]) assert.ok(!validText({ ...item, ...bad }), JSON.stringify(bad));
  const later = { ...item, id: 't-bbbbbb', page: 1, y: 0.5 };
  assert.deepEqual(sortTexts([item, later]).map((x) => x.id), ['t-bbbbbb', item.id]);
});

test('after a PDF\'s pages change, texts follow their pages and stay on the page', async () => {
  const { remapTexts } = await import('../src/marks.js');
  const t = (page, id) => ({ id, page, x: 0.1, y: 0.2, w: 0.5, text: 'x', size: 0.022, color: 'black', created: 1 });
  // page 3 first and turned right, page 1 second, page 2 removed
  const plan = [{ src: 0, page: 3, turn: 90 }, { src: 0, page: 1, turn: 0 }];
  const out = remapTexts([t(1, 't-aaaa'), t(2, 't-bbbb'), t(3, 't-cccc')], plan);
  assert.deepEqual(out.map((x) => [x.id, x.page]), [['t-aaaa', 2], ['t-cccc', 1]]);
  assert.deepEqual([out[0].x, out[0].y], [0.1, 0.2]);
  // turned: the corner moves with the page, the box still fits across it
  assert.ok(out[1].x + out[1].w <= 1 && out[1].y >= 0 && out[1].y <= 0.98);
});

test('a rewritten PDF line: well formed or refused', async () => {
  const { newEditId, validEdit, validEdits } = await import('../src/marks.js');
  const e = { id: newEditId(), page: 1, x: 0.1, y: 0.2, w: 0.5, h: 0.03, base: 0.225, size: 0.02, font: 'serif', bold: false, ink: '#111111', bg: '#ffffff', original: 'Old line', text: 'New line', created: 1 };
  assert.ok(validEdit(e));
  assert.ok(validEdits([e]));
  assert.ok(!validEdits([e, e]));
  for (const bad of [{ font: 'comic' }, { ink: 'red' }, { bg: '#fff' }, { bold: 'yes' }, { h: 0 }, { page: 0 }, { text: null }]) assert.ok(!validEdit({ ...e, ...bad }), JSON.stringify(bad));
  assert.ok(validEdit({ ...e, text: '' }), 'an empty text removes the line');
});

test('the line under a point: runs on one baseline, a wide gap is another column', async () => {
  const { pickLine } = await import('../src/marks.js');
  const run = (str, left, right, base = 100, size = 12) => ({ str, left, right, base, top: base - size * 0.95, bottom: base + size * 0.28, size, font: 'sans', bold: false });
  const runs = [run('Hello', 50, 80), run('world,', 83, 120), run('again', 124, 155), run('Column two', 300, 370), run('Next line', 50, 110, 116)];
  const line = pickLine(runs, 90, 96);
  assert.equal(line.text, 'Hello world, again');
  assert.deepEqual([line.left, line.right, line.base], [50, 155, 100]);
  assert.equal(pickLine(runs, 320, 96).text, 'Column two');
  assert.equal(pickLine(runs, 60, 112).text, 'Next line');
  assert.equal(pickLine(runs, 250, 96), null);
});

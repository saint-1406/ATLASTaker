import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHeightField, contourSegments, createNoise2D, hashString, normalizeField } from '../src/terrain.js';

test('hashString is stable and tells close strings apart', () => {
  assert.equal(hashString('n-abc'), hashString('n-abc'));
  assert.notEqual(hashString('n-abc'), hashString('n-abd'));
});

test('noise is repeatable per seed, different across seeds, and bounded', () => {
  const a = createNoise2D(42);
  const b = createNoise2D(42);
  const c = createNoise2D(43);
  let differs = false;
  for (let i = 0; i < 300; i++) {
    const x = i * 0.37;
    const y = i * 0.11;
    assert.equal(a(x, y), b(x, y));
    assert.ok(Math.abs(a(x, y)) <= 1.01);
    if (a(x, y) !== c(x, y)) differs = true;
  }
  assert.ok(differs);
});

test('contours of a cone are circles', () => {
  const cols = 41;
  const rows = 41;
  const field = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) field[j * cols + i] = -Math.hypot(i - 20, j - 20);
  const seg = contourSegments(field, cols, rows, -10);
  assert.ok(seg.length / 4 >= 40, `only ${seg.length / 4} segments`);
  for (let s = 0; s < seg.length; s += 2) {
    const d = Math.hypot(seg[s] - 20, seg[s + 1] - 20);
    assert.ok(Math.abs(d - 10) < 0.15, `point at distance ${d}`);
  }
});

test('the same note always gets the same terrain', () => {
  const a = buildHeightField({ seed: 7, cols: 30, rows: 20 });
  const b = buildHeightField({ seed: 7, cols: 30, rows: 20 });
  const c = buildHeightField({ seed: 8, cols: 30, rows: 20 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('a heading peak raises the ground around it and nowhere else', () => {
  const base = buildHeightField({ seed: 7, cols: 60, rows: 41 });
  const peaked = buildHeightField({ seed: 7, cols: 60, rows: 41, peaks: [{ x: 0.5, y: 0.5, height: 1, radius: 0.08 }] });
  const centre = 20 * 60 + 30;
  assert.ok(peaked[centre] - base[centre] > 0.8);
  assert.ok(Math.abs(peaked[0] - base[0]) < 1e-6);
});

test('normalizeField maps the field onto [0, 1]', () => {
  const field = normalizeField(Float32Array.from([3, -1, 5, 1]));
  assert.deepEqual([...field], [2 / 3, 0, 1, 1 / 3].map((v) => Math.fround(v)));
});

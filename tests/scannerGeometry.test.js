import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHomography, findPage, flatSize, fullQuad, homography, isPlausibleQuad, orderQuad, polygonArea, rotateQuad, warp } from '../src/scanner/geometry.js';

const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} is not within ${eps} of ${b}`);

/** A grey picture: a dark, speckled table and a light sheet with dark "text" lines on it. */
function photo(width, height, quad, { paper = 225, table = 70, seed = 1 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const inside = (x, y) => {
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false;
    }
    return true;
  };
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = inside(x + 0.5, y + 0.5);
      const text = on && y % 9 < 2 && x % 23 > 3;
      gray[y * width + x] = (on ? (text ? 60 : paper) : table) + Math.round(rnd() * 20);
    }
  }
  return gray;
}

test('corners come in order, clockwise from the top left', () => {
  const q = orderQuad([{ x: 90, y: 95 }, { x: 10, y: 5 }, { x: 5, y: 90 }, { x: 95, y: 10 }]);
  assert.deepEqual(q, [{ x: 10, y: 5 }, { x: 95, y: 10 }, { x: 90, y: 95 }, { x: 5, y: 90 }]);
  assert.equal(polygonArea(fullQuad(10, 20)), 200);
});

test('a plausible sheet: convex and not a sliver', () => {
  assert.ok(isPlausibleQuad(fullQuad(100, 100, 0.1), 100, 100));
  assert.ok(!isPlausibleQuad([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 100 }], 100, 100), 'folded in');
  assert.ok(!isPlausibleQuad(fullQuad(100, 100, 0.48), 100, 100), 'a speck');
});

test('the homography takes each corner where it is asked to go', () => {
  const from = [{ x: 12, y: 30 }, { x: 410, y: 8 }, { x: 440, y: 600 }, { x: 0, y: 560 }];
  const to = fullQuad(300, 400);
  const h = homography(from, to);
  for (let i = 0; i < 4; i++) {
    const p = applyHomography(h, from[i]);
    near(p.x, to[i].x, 1e-6, `x${i}`);
    near(p.y, to[i].y, 1e-6, `y${i}`);
  }
});

test('the flattened size follows the longer sides and keeps within the limit', () => {
  assert.deepEqual(flatSize([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 900, y: 1400 }, { x: 100, y: 1400 }], 4000), { width: 1000, height: 1404 }, 'the slanted side is the longer one');
  assert.deepEqual(flatSize(fullQuad(4000, 3000), 2400), { width: 2400, height: 1800 });
});

test('warping a sheet straightens it: a square seen at an angle comes out square', () => {
  const sw = 120;
  const sh = 100;
  // a picture: left half black, right half white, seen through a slanted quad
  const src = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      src.fill(x < 60 ? 0 : 255, (y * sw + x) * 4, (y * sw + x) * 4 + 3);
      src[(y * sw + x) * 4 + 3] = 255;
    }
  }
  const quad = [{ x: 20, y: 10 }, { x: 100, y: 20 }, { x: 100, y: 80 }, { x: 20, y: 90 }];
  const out = warp(src, sw, sh, quad, 80, 80);
  const at = (x, y) => out[(y * 80 + x) * 4];
  assert.equal(at(5, 40), 0, 'the left stays dark');
  assert.equal(at(75, 40), 255, 'the right stays light');
  assert.equal(out[3], 255, 'opaque');
});

test('a sheet on a darker table is found, its corners within a few pixels', () => {
  const w = 240;
  const h = 320;
  const truth = [{ x: 40, y: 30 }, { x: 205, y: 48 }, { x: 196, y: 290 }, { x: 28, y: 270 }];
  const { quad, confidence } = findPage(photo(w, h, truth), w, h);
  assert.ok(quad, 'a sheet was found');
  assert.ok(confidence > 0.6, `confident (${confidence})`);
  quad.forEach((p, i) => {
    near(p.x, truth[i].x, 4, `corner ${i} x`);
    near(p.y, truth[i].y, 4, `corner ${i} y`);
  });
});

test('a dim photo still shows its sheet', () => {
  const w = 200;
  const h = 260;
  const truth = [{ x: 30, y: 20 }, { x: 170, y: 30 }, { x: 175, y: 240 }, { x: 22, y: 230 }];
  const { quad } = findPage(photo(w, h, truth, { paper: 80, table: 25, seed: 7 }), w, h);
  assert.ok(quad);
  quad.forEach((p, i) => near(p.x, truth[i].x, 5, `corner ${i}`));
});

test('nothing sheet-like: no corners, or little confidence', () => {
  const w = 100;
  const h = 100;
  const flat = new Uint8Array(w * h).fill(128);
  assert.equal(findPage(flat, w, h).quad, null);
  // a round light blob is not a sheet
  const blob = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) blob[y * w + x] = (x - 50) ** 2 + (y - 50) ** 2 < 35 ** 2 ? 220 : 40;
  const found = findPage(blob, w, h);
  assert.ok(!found.quad || found.confidence < 0.5, `a disc is not a page (${found.confidence})`);
});

test('corners turn with the picture', () => {
  const quad = [{ x: 10, y: 20 }, { x: 90, y: 20 }, { x: 90, y: 60 }, { x: 10, y: 60 }];
  // 100×80 picture turned 90° clockwise becomes 80×100: (x, y) → (80 − y, x)
  assert.deepEqual(rotateQuad(quad, 90, 100, 80), [{ x: 20, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 90 }, { x: 20, y: 90 }]);
  assert.deepEqual(rotateQuad(rotateQuad(quad, 90, 100, 80), 270, 80, 100), quad);
  assert.deepEqual(rotateQuad(quad, 180, 100, 80), [{ x: 10, y: 20 }, { x: 90, y: 20 }, { x: 90, y: 60 }, { x: 10, y: 60 }]);
});

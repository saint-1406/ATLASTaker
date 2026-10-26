import test from 'node:test';
import assert from 'node:assert/strict';
import { islandRadius, islandRings, layoutIslands } from '../src/archipelago.js';

const items = Array.from({ length: 40 }, (_, i) => ({ id: `n-test${String(i).padStart(4, '0')}`, words: (i * 137) % 900 }));

test('islands never crowd each other', () => {
  const nodes = layoutIslands(items);
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
      assert.ok(d >= nodes[a].r + nodes[b].r, `${nodes[a].id} and ${nodes[b].id} overlap`);
    }
  }
});

test('the layout is the same every time', () => {
  assert.deepEqual(layoutIslands(items), layoutIslands(items));
});

test('longer notes make bigger islands', () => {
  assert.ok(islandRadius(1000) > islandRadius(100));
  assert.ok(islandRadius(100) > islandRadius(0));
});

function inside([x, y], polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

test('inner contour rings stay inside the coastline', () => {
  for (const { id } of items.slice(0, 15)) {
    const { rings } = islandRings(id, 60);
    for (let r = 1; r < rings.length; r++) {
      for (const point of rings[r]) assert.ok(inside(point, rings[0]), `${id}: ring ${r} leaves the coast`);
    }
  }
});

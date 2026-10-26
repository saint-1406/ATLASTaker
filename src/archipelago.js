// The atlas view's geometry: where each note's island sits and what its coastline looks like.
// Layout and shapes are pure and seeded by the note id, so an island keeps its shape for ever.

import { createNoise2D, fbm, hashString, mulberry32 } from './terrain.js';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function islandRadius(words) {
  return 22 + Math.min(70, Math.sqrt(Math.max(0, words)) * 3.2);
}

/**
 * Oldest note in the middle, newer ones spiralling outwards, then nudged apart until no two
 * islands crowd each other. items: [{ id, words }] in creation order.
 */
export function layoutIslands(items) {
  const nodes = items.map((it, i) => {
    const rand = mulberry32(hashString(it.id));
    const r = islandRadius(it.words);
    const dist = 150 * Math.sqrt(i);
    const angle = i * GOLDEN_ANGLE + (rand() - 0.5) * 0.6;
    return { id: it.id, r, x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
  });

  for (let iter = 0; iter < 200; iter++) {
    let moved = false;
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const A = nodes[a];
        const B = nodes[b];
        let dx = B.x - A.x;
        let dy = B.y - A.y;
        let d = Math.hypot(dx, dy);
        if (d < 1e-6) { dx = 1; dy = 0; d = 1e-6; }
        const min = (A.r + B.r) * 1.35 + 24;
        if (d < min) {
          const push = (min - d) / 2 + 0.5;
          const ux = dx / d;
          const uy = dy / d;
          A.x -= ux * push; A.y -= uy * push;
          B.x += ux * push; B.y += uy * push;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return nodes;
}

/** Coastline as a closed polygon around (0,0). */
export function islandOutline(id, radius, steps = 72) {
  const noise = createNoise2D(hashString(id));
  const pts = [];
  for (let k = 0; k < steps; k++) {
    const a = (k / steps) * Math.PI * 2;
    const n = fbm(noise, Math.cos(a) * 1.3 + 3, Math.sin(a) * 1.3 + 3, 3);
    const rr = radius * (1 + 0.45 * n);
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  return pts;
}

/**
 * The coast plus inner contour rings. Inner rings are the coast shrunk towards an off-centre summit,
 * which keeps them nested inside each other.
 */
export function islandRings(id, radius) {
  const coast = islandOutline(id, radius);
  const rand = mulberry32(hashString(id) ^ 0xa5a5a5a5);
  const sx = (rand() - 0.5) * radius * 0.3;
  const sy = (rand() - 0.5) * radius * 0.3;
  const rings = [0.76, 0.52, 0.29].map((s) => coast.map(([x, y]) => [sx + (x - sx) * s, sy + (y - sy) * s]));
  return { rings: [coast, ...rings], summit: [sx, sy] };
}

/** Smooth closed curve through the polygon's edge midpoints. */
export function traceSmooth(ctx, pts, ox, oy, scale) {
  const n = pts.length;
  const mid = (i) => {
    const p = pts[i % n];
    const q = pts[(i + 1) % n];
    return [ox + ((p[0] + q[0]) / 2) * scale, oy + ((p[1] + q[1]) / 2) * scale];
  };
  const start = mid(n - 1);
  ctx.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i++) {
    const m = mid(i);
    ctx.quadraticCurveTo(ox + pts[i][0] * scale, oy + pts[i][1] * scale, m[0], m[1]);
  }
  ctx.closePath();
}

export function drawPin(ctx, x, y, color, ring) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y - 15, 7, Math.PI * 0.75, Math.PI * 0.25, false);
  ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = ring;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y - 15, 2.6, 0, Math.PI * 2);
  ctx.fillStyle = ring;
  ctx.fill();
  ctx.restore();
}

/** Small island portrait for the index list. */
export function drawIslandThumb(canvas, id, pal) {
  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  const c = S / 2;
  ctx.clearRect(0, 0, S, S);
  const { rings } = islandRings(id, S * 0.26);
  ctx.lineJoin = 'round';

  ctx.beginPath();
  traceSmooth(ctx, rings[0], c, c, 1.25);
  ctx.setLineDash([2, 4]);
  ctx.strokeStyle = pal.shallow;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  traceSmooth(ctx, rings[0], c, c, 1);
  ctx.fillStyle = pal.land;
  ctx.fill();
  for (let r = 1; r < rings.length; r++) {
    ctx.beginPath();
    traceSmooth(ctx, rings[r], c, c, 1);
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = pal.landHi;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = pal.contour;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
  ctx.beginPath();
  traceSmooth(ctx, rings[0], c, c, 1);
  ctx.strokeStyle = pal.coast;
  ctx.lineWidth = 1.8;
  ctx.stroke();
}

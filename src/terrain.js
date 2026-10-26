// Deterministic terrain for a note: seeded noise, a height field and contour lines (marching squares).
// Pure functions with no DOM, so the renderer and the tests share them.

export function hashString(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GX = [1, -1, 1, -1, 1, -1, 0, 0];
const GY = [1, 1, -1, -1, 0, 0, 1, -1];

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

/** 2D gradient noise with a permutation shuffled by `seed`. Output stays within about [-1, 1]. */
export function createNoise2D(seed) {
  const rand = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  return function noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const aa = perm[X + perm[Y]] & 7;
    const ba = perm[X + 1 + perm[Y]] & 7;
    const ab = perm[X + perm[Y + 1]] & 7;
    const bb = perm[X + 1 + perm[Y + 1]] & 7;
    const u = fade(xf);
    const v = fade(yf);
    const x1 = lerp(GX[aa] * xf + GY[aa] * yf, GX[ba] * (xf - 1) + GY[ba] * yf, u);
    const x2 = lerp(GX[ab] * xf + GY[ab] * (yf - 1), GX[bb] * (xf - 1) + GY[bb] * (yf - 1), u);
    return lerp(x1, x2, v);
  };
}

export function fbm(noise, x, y, octaves = 5) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * The note's bare ground on a cols×rows grid covering the unit square (stretched by `aspect`
 * horizontally). It depends only on the seed and the grid, so callers can keep it while the text changes.
 */
export function baseField({ seed, cols, rows, aspect = cols / rows, scale = 2.3 }) {
  const noise = createNoise2D(seed);
  const warp = createNoise2D((seed ^ 0x9e3779b9) >>> 0);
  const field = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const v = rows > 1 ? j / (rows - 1) : 0;
    for (let i = 0; i < cols; i++) {
      const u = cols > 1 ? i / (cols - 1) : 0;
      const x = u * scale * aspect;
      const y = v * scale;
      // domain warping bends the contours into something closer to real coastlines
      const wx = fbm(warp, x + 5.2, y + 1.3, 3) * 0.7;
      const wy = fbm(warp, x + 1.7, y + 9.2, 3) * 0.7;
      field[j * cols + i] = fbm(noise, x + wx, y + wy, 5);
    }
  }
  return field;
}

/**
 * Ground scaled by `ruggedness`, plus gaussian peaks: { x, y } in [0,1], `radius` in units of the
 * grid height. Pass a cached `base` from baseField() to skip the expensive noise.
 */
export function buildHeightField({ seed, cols, rows, aspect = cols / rows, scale = 2.3, ruggedness = 1, peaks = [], base }) {
  const ground = base ?? baseField({ seed, cols, rows, aspect, scale });
  const field = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const v = rows > 1 ? j / (rows - 1) : 0;
    for (let i = 0; i < cols; i++) {
      const u = cols > 1 ? i / (cols - 1) : 0;
      let h = ground[j * cols + i] * ruggedness;
      for (const p of peaks) {
        const dx = (u - p.x) * aspect;
        const dy = v - p.y;
        h += p.height * Math.exp(-(dx * dx + dy * dy) / (2 * p.radius * p.radius));
      }
      field[j * cols + i] = h;
    }
  }
  return field;
}

export function normalizeField(field) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of field) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - min) / span;
  return field;
}

const frac = (level, p, q) => (q === p ? 0.5 : (level - p) / (q - p));

// One marching-squares cell: corners a (top-left), b (top-right), c (bottom-right), d (bottom-left).
// Appends [x1, y1, x2, y2] per segment, with crossings placed by linear interpolation.
function cellSegments(out, level, i, j, a, b, c, d) {
  const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
  if (idx === 0 || idx === 15) return;
  const topX = i + frac(level, a, b);
  const rightY = j + frac(level, b, c);
  const bottomX = i + frac(level, d, c);
  const leftY = j + frac(level, a, d);
  switch (idx) {
    case 1: case 14: out.push(i, leftY, bottomX, j + 1); break;
    case 2: case 13: out.push(bottomX, j + 1, i + 1, rightY); break;
    case 3: case 12: out.push(i, leftY, i + 1, rightY); break;
    case 4: case 11: out.push(topX, j, i + 1, rightY); break;
    case 6: case 9: out.push(topX, j, bottomX, j + 1); break;
    case 7: case 8: out.push(i, leftY, topX, j); break;
    case 5:
      // saddle: the centre decides which corners connect
      if ((a + b + c + d) / 4 > level) out.push(i, leftY, topX, j, bottomX, j + 1, i + 1, rightY);
      else out.push(topX, j, i + 1, rightY, i, leftY, bottomX, j + 1);
      break;
    case 10:
      if ((a + b + c + d) / 4 > level) out.push(topX, j, i + 1, rightY, i, leftY, bottomX, j + 1);
      else out.push(i, leftY, topX, j, bottomX, j + 1, i + 1, rightY);
      break;
    default: break;
  }
}

/**
 * Contours for several iso levels (ascending) in a single pass: each cell only visits the levels
 * between its lowest and highest corner. Returns one flat [x1, y1, x2, y2, ...] list per level.
 */
export function contourLevels(field, cols, rows, levels) {
  const out = levels.map(() => []);
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = field[j * cols + i];
      const b = field[j * cols + i + 1];
      const c = field[(j + 1) * cols + i + 1];
      const d = field[(j + 1) * cols + i];
      const lo = Math.min(a, b, c, d);
      const hi = Math.max(a, b, c, d);
      for (let k = 0; k < levels.length; k++) {
        const level = levels[k];
        if (level < lo) continue;
        if (level >= hi) break;
        cellSegments(out[k], level, i, j, a, b, c, d);
      }
    }
  }
  return out;
}

export function contourSegments(field, cols, rows, level) {
  return contourLevels(field, cols, rows, [level])[0];
}

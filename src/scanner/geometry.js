// The scanner's geometry: where the sheet of paper is in a photo (findPage), the four corners in
// order, the perspective that flattens the sheet (homography) and the flattening itself in the page
// (warp: the desktop's way; Android flattens in MainActivity). No DOM here: the tests run it in Node.

/** A point: { x, y }. A quad: [tl, tr, br, bl], the corners of the sheet clockwise from the top left. */

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** The area of a polygon (shoelace), always positive. */
export function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Four points in any order → [tl, tr, br, bl], clockwise on the screen (y grows downwards). */
export function orderQuad(points) {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const around = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // clockwise from the one nearest the top left corner of the picture
  let first = 0;
  for (let i = 1; i < 4; i++) if (around[i].x + around[i].y < around[first].x + around[first].y) first = i;
  return [0, 1, 2, 3].map((i) => ({ x: around[(first + i) % 4].x, y: around[(first + i) % 4].y }));
}

/** Whether the four corners make a shape a sheet could be: convex, not folded over, not a sliver. */
export function isPlausibleQuad(quad, width, height) {
  if (!quad || quad.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]);
    if (Math.abs(c) < 1e-9) return false;
    if (sign && Math.sign(c) !== sign) return false;
    sign = Math.sign(c);
  }
  const area = polygonArea(quad);
  if (area < width * height * 0.05) return false;
  // no side shorter than a tenth of the one opposite: that is not a sheet seen at an angle any more
  const [tl, tr, br, bl] = quad;
  const ratio = (a, b) => Math.min(a, b) / Math.max(a, b);
  return ratio(dist(tl, tr), dist(bl, br)) > 0.1 && ratio(dist(tl, bl), dist(tr, br)) > 0.1;
}

/** The whole picture, a little inside its edges: where the frame starts when no sheet was found. */
export const fullQuad = (width, height, inset = 0) => [
  { x: width * inset, y: height * inset },
  { x: width * (1 - inset), y: height * inset },
  { x: width * (1 - inset), y: height * (1 - inset) },
  { x: width * inset, y: height * (1 - inset) },
];

/**
 * The flattened page's size in pixels: the longer of each pair of opposite sides, then made to fit
 * maxSide on its longer side (a phone's 12-megapixel shot need not become a 4000-pixel page).
 */
export function flatSize(quad, maxSide = 2400) {
  const [tl, tr, br, bl] = quad;
  let w = Math.max(dist(tl, tr), dist(bl, br));
  let h = Math.max(dist(tl, bl), dist(tr, br));
  const k = Math.min(1, maxSide / Math.max(w, h, 1));
  w = Math.max(1, Math.round(w * k));
  h = Math.max(1, Math.round(h * k));
  return { width: w, height: h };
}

/**
 * The 3×3 matrix (row-major, h[8] = 1) taking each of the four `from` points to the `to` point at the
 * same place: x' = (h0 x + h1 y + h2) / (h6 x + h7 y + 1), y' = (h3 x + h4 y + h5) / (…).
 */
export function homography(from, to) {
  const a = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented matrix
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      if (!f) continue;
      for (let c = col; c < 9; c++) a[r][c] -= f * a[col][c];
    }
  }
  const h = a.map((row, i) => row[8] / row[i]);
  h.push(1);
  return h;
}

export function applyHomography(h, { x, y }) {
  const d = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / d, y: (h[3] * x + h[4] * y + h[5]) / d };
}

/**
 * The sheet flattened: src is RGBA (Uint8ClampedArray, sw×sh), quad the sheet's corners in it; the
 * answer is a new RGBA of width×height. Bilinear; each output pixel looks back into the photo.
 */
export function warp(src, sw, sh, quad, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  const back = homography(fullQuad(width, height), quad);
  if (!back) return out;
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = back;
  let o = 0;
  for (let y = 0; y < height; y++) {
    const yc = y + 0.5;
    for (let x = 0; x < width; x++) {
      const xc = x + 0.5;
      const d = h6 * xc + h7 * yc + h8;
      let sx = (h0 * xc + h1 * yc + h2) / d - 0.5;
      let sy = (h3 * xc + h4 * yc + h5) / d - 0.5;
      sx = sx < 0 ? 0 : sx > sw - 1 ? sw - 1 : sx;
      sy = sy < 0 ? 0 : sy > sh - 1 ? sh - 1 : sy;
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = x0 + 1 < sw ? x0 + 1 : x0;
      const y1 = y0 + 1 < sh ? y0 + 1 : y0;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const bottom = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        out[o + c] = top + (bottom - top) * fy;
      }
      o += 4;
    }
  }
  return out;
}

/** RGBA → luminance, one byte a pixel. */
export function toGray(rgba, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return gray;
}

/** A box blur of radius r, horizontal then vertical (a cheap stand-in for a Gaussian). */
function blur(src, w, h, r) {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  const span = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / span;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / span;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Otsu's threshold: the grey level that best splits the picture into a dark and a light part. */
export function otsu(gray) {
  const hist = new Float64Array(256);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** The largest 4-connected region of set pixels: its pixel count and, per row, its left and right ends. */
function largestRegion(mask, w, h) {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let best = { size: 0, id: 0 };
  let next = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const id = next++;
    let top = 0;
    let size = 0;
    stack[top++] = start;
    label[start] = id;
    while (top) {
      const p = stack[--top];
      size++;
      const x = p % w;
      if (x > 0 && mask[p - 1] && !label[p - 1]) (label[p - 1] = id), (stack[top++] = p - 1);
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) (label[p + 1] = id), (stack[top++] = p + 1);
      if (p >= w && mask[p - w] && !label[p - w]) (label[p - w] = id), (stack[top++] = p - w);
      if (p < w * (h - 1) && mask[p + w] && !label[p + w]) (label[p + w] = id), (stack[top++] = p + w);
    }
    if (size > best.size) best = { size, id };
  }
  if (!best.size) return null;
  const points = [];
  for (let y = 0; y < h; y++) {
    let left = -1;
    let right = -1;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (label[row + x] !== best.id) continue;
      if (left < 0) left = x;
      right = x;
    }
    if (left >= 0) points.push({ x: left, y }, { x: right + 1, y }, { x: left, y: y + 1 }, { x: right + 1, y: y + 1 });
  }
  return { size: best.size, points };
}

/** The convex hull (Andrew's monotone chain), clockwise on the screen. */
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** The four points of a convex polygon that enclose the most area: the sheet's corners on its outline. */
export function largestQuad(hull) {
  const n = hull.length;
  if (n < 4) return null;
  // start from the points furthest out on the two diagonals, then move each corner while that grows the area
  const pick = (score) => hull.reduce((best, p, i) => (score(p) > score(hull[best]) ? i : best), 0);
  let idx = [pick((p) => -p.x - p.y), pick((p) => p.x - p.y), pick((p) => p.x + p.y), pick((p) => -p.x + p.y)];
  if (new Set(idx).size < 4) idx = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4)];
  const area = (ids) => polygonArea(ids.map((i) => hull[i]));
  let best = area(idx);
  for (let round = 0; round < 6; round++) {
    let moved = false;
    for (let k = 0; k < 4; k++) {
      for (let i = 0; i < n; i++) {
        if (idx.includes(i)) continue;
        const trial = [...idx];
        trial[k] = i;
        // keep the corners in their order around the outline
        const sorted = [...trial].sort((a, b) => a - b);
        const rot = sorted.indexOf(trial[0]);
        const inOrder = [0, 1, 2, 3].every((j) => sorted[(rot + j) % 4] === trial[j]) || [0, 1, 2, 3].every((j) => sorted[(rot - j + 4) % 4] === trial[j]);
        if (!inOrder) continue;
        const a = area(trial);
        if (a > best + 1e-6) {
          best = a;
          idx = trial;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return orderQuad(idx.map((i) => hull[i]));
}

/**
 * Where the sheet of paper is in a (small) grey picture: paper is lighter than what it lies on, so
 * the largest light region, its outline, and the four corners that hold most of it. The answer's
 * corners are in the picture's pixels; `confidence` (0…1) says how much it looks like a sheet: low
 * when the light part is not a four-cornered thing, or is the whole picture, or a speck.
 */
export function findPage(gray, width, height) {
  const smooth = blur(blur(gray, width, height, 2), width, height, 2);
  let lo = 255;
  let hi = 0;
  for (const v of smooth) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi - lo < 24) return { quad: null, confidence: 0 }; // one even grey: nothing to tell apart
  const t = otsu(smooth);
  const mask = new Uint8Array(smooth.length);
  for (let i = 0; i < smooth.length; i++) mask[i] = smooth[i] > t ? 1 : 0;
  const region = largestRegion(mask, width, height);
  if (!region || region.size < width * height * 0.08) return { quad: null, confidence: 0 };
  const hull = convexHull(region.points);
  const quad = largestQuad(hull);
  if (!quad || !isPlausibleQuad(quad, width, height)) return { quad: null, confidence: 0 };
  const quadArea = polygonArea(quad);
  const fill = Math.min(1, region.size / quadArea); // a sheet fills its corners; a blob does not
  const hullFit = quadArea / polygonArea(hull); // a sheet's outline is four straight sides
  const share = quadArea / (width * height);
  const notEverything = share > 0.97 ? 0.4 : 1; // the "sheet" is the whole frame: likely just a light picture
  const confidence = Math.max(0, Math.min(1, ((fill - 0.75) / 0.2) * ((hullFit - 0.85) / 0.12))) * notEverything;
  return { quad, confidence: Math.round(confidence * 100) / 100 };
}

/** Corners in one picture's pixels → in another's (the small picture the finder saw → the photo). */
export const scaleQuad = (quad, kx, ky = kx) => quad.map((p) => ({ x: p.x * kx, y: p.y * ky }));

/** The quad turned with the picture by 90° steps clockwise (w, h: the picture before turning). */
export function rotateQuad(quad, degrees, w, h) {
  const turn = ((degrees % 360) + 360) % 360;
  const map = {
    0: (p) => p,
    90: (p) => ({ x: h - p.y, y: p.x }),
    180: (p) => ({ x: w - p.x, y: h - p.y }),
    270: (p) => ({ x: p.y, y: w - p.x }),
  }[turn];
  const [nw, nh] = turn % 180 ? [h, w] : [w, h];
  return orderQuad(quad.map(map)).map((p) => ({ x: Math.min(nw, Math.max(0, p.x)), y: Math.min(nh, Math.max(0, p.y)) }));
}

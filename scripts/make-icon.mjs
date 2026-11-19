// Draws the app icon, the ATLAS emblem (assets/logo.svg: a figure holding up a crescent) in black on
// white, straight into PNG and ICO files, with no image libraries.

import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((img) => img.data)]);
}

const WHITE = [255, 255, 255];
const INK = [20, 20, 20];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// ---------- the emblem: assets/logo.svg's paths (M, L, C, Z only) as polygons, filled by scanlines ----------

const SVG = readFileSync(path.join(OUT, 'logo.svg'), 'utf8');
const [VIEW_W, VIEW_H] = SVG.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).slice(1).map(Number);

function polygonsOf(d) {
  const tokens = d.match(/[MLCZ]|-?[\d.]+/g);
  const polys = [];
  let poly = null;
  let cur = [0, 0];
  let cmd = '';
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[MLCZ]/.test(tokens[i])) cmd = tokens[i++];
    if (cmd === 'M') {
      cur = [num(), num()];
      poly = [cur];
      polys.push(poly);
      cmd = 'L';
    } else if (cmd === 'L') {
      cur = [num(), num()];
      poly.push(cur);
    } else if (cmd === 'C') {
      const c1 = [num(), num()];
      const c2 = [num(), num()];
      const p = [num(), num()];
      for (let k = 1; k <= 16; k++) {
        const t = k / 16;
        const s = 1 - t;
        const at = (n) => s * s * s * cur[n] + 3 * s * s * t * c1[n] + 3 * s * t * t * c2[n] + t * t * t * p[n];
        poly.push([at(0), at(1)]);
      }
      cur = p;
    }
  }
  return polys;
}

// every edge of every path; the paths do not overlap, so even-odd over all of them is the emblem
const EDGES = [...SVG.matchAll(/ d="([^"]+)"/g)]
  .flatMap((m) => polygonsOf(m[1]))
  .flatMap((poly) => poly.map((a, i) => [a, poly[(i + 1) % poly.length]]))
  .filter(([a, b]) => a[1] !== b[1]);

const rows = new Map(); // y -> where that line crosses the emblem's edges, left to right
function crossings(y) {
  let xs = rows.get(y);
  if (xs) return xs;
  xs = [];
  for (const [a, b] of EDGES) {
    if ((a[1] <= y && y < b[1]) || (b[1] <= y && y < a[1])) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
  }
  xs.sort((p, q) => p - q);
  if (rows.size > 64) rows.clear();
  rows.set(y, xs);
  return xs;
}

/**
 * Is (u, v) of the unit square on the emblem? It stands `height` of the square tall, its point
 * (ax, ay) — in the SVG's own units — at (cx, cy) of the square.
 */
function onEmblem(u, v, { height, cx = 0.5, cy = 0.5, ax = VIEW_W / 2, ay = VIEW_H / 2 }) {
  const s = height / VIEW_H;
  const x = (u - cx) / s + ax;
  const y = (v - cy) / s + ay;
  if (x < 0 || y < 0 || x > VIEW_W || y > VIEW_H) return false;
  let inside = false;
  for (const cross of crossings(y)) {
    if (cross > x) break;
    inside = !inside;
  }
  return inside;
}

// the rounded tile of the desktop icon (and Android's own before adaptive icons): white, a faint edge so
// it holds its shape on a white taskbar, the emblem two thirds of its height
const TILE = { height: 0.64 };
function shade(u, v) {
  const r = 0.2;
  const half = 0.47;
  const qx = Math.max(Math.abs(u - 0.5) - (half - r), 0);
  const qy = Math.max(Math.abs(v - 0.5) - (half - r), 0);
  const edge = Math.hypot(qx, qy) - r;
  if (edge > 0) return null;
  if (onEmblem(u, v, TILE)) return INK;
  return edge > -0.014 ? mix(WHITE, INK, 0.14) : WHITE;
}

// The Android adaptive icon: the launcher cuts its own shape (circle, squircle…) out of a plain white
// background (android/…/colors.xml, icon_bg), so the foreground is the emblem alone, inside the 66 dp
// safe circle of the 108 dp square: its tips are what reach furthest from the middle.
const ICON_BG = WHITE;
const SAFE = { height: 0.47, cy: 0.5, ay: 161 };
const foreground = (u, v) => (onEmblem(u, v, SAFE) ? INK : null);

function render(size, colorAt = shade) {
  const ss = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const col = colorAt((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          if (!col) continue;
          r += col[0];
          g += col[1];
          b += col[2];
          hits++;
        }
      }
      const o = (y * size + x) * 4;
      if (hits) {
        rgba[o] = Math.round(r / hits);
        rgba[o + 1] = Math.round(g / hits);
        rgba[o + 2] = Math.round(b / hits);
        rgba[o + 3] = Math.round((hits / (ss * ss)) * 255);
      }
    }
  }
  return png(size, rgba);
}

// node scripts/make-icon.mjs --android android/app/src/main/res → the launcher icons for every density
const androidAt = process.argv.indexOf('--android');
// node scripts/make-icon.mjs --ios → the iPhone app's icon: 1024 px, square and opaque (iOS rounds it
// itself, only at the corners, so the emblem may stand larger than in Android's safe circle)
const iosAt = process.argv.indexOf('--ios');
if (iosAt > 0) {
  const file = path.join(OUT, '..', 'ios', 'ATLAS', 'Assets.xcassets', 'AppIcon.appiconset', 'icon-1024.png');
  writeFileSync(file, render(1024, (u, v) => (onEmblem(u, v, { height: 0.62 }) ? INK : ICON_BG)));
  console.log(`иконка iOS записана в ${file}`);
} else if (androidAt > 0) {
  const res = path.resolve(process.argv[androidAt + 1]);
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [name, scale] of Object.entries(densities)) {
    const dir = path.join(res, `mipmap-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'ic_launcher.png'), render(Math.round(48 * scale)));
    writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), render(Math.round(108 * scale), foreground));
  }
  console.log(`иконки Android записаны в ${res} (фон #${ICON_BG.map((c) => c.toString(16).padStart(2, '0')).join('')})`);
} else {
  mkdirSync(OUT, { recursive: true });
  const images = [256, 64, 48, 32, 16].map((size) => ({ size, data: render(size) }));
  writeFileSync(path.join(OUT, 'icon.png'), images[0].data);
  writeFileSync(path.join(OUT, 'icon.ico'), ico(images));
  console.log(`icon.png и icon.ico записаны в ${OUT}`);
}

// Draws the app icon (contour rings around an amber summit inside a map neatline, on a night-chart
// square) straight into PNG and ICO files, with no image libraries.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
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

const TOP = [18, 40, 56];
const BOTTOM = [9, 20, 32];
const TEAL = [110, 205, 200];
const AMBER = [242, 166, 90];
const CREAM = [232, 223, 204];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Colour at (u, v) in the unit square, or null outside the rounded tile. */
function shade(u, v) {
  const r = 0.2;
  const half = 0.47;
  const qx = Math.max(Math.abs(u - 0.5) - (half - r), 0);
  const qy = Math.max(Math.abs(v - 0.5) - (half - r), 0);
  if (Math.hypot(qx, qy) > r) return null;

  let col = mix(TOP, BOTTOM, v);
  const edge = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5));
  if (Math.abs(edge - 0.385) < 0.007) col = mix(col, CREAM, 0.5);

  const cx = 0.5;
  const cy = 0.53;
  const ang = Math.atan2(v - cy, u - cx);
  const d = Math.hypot(u - cx, v - cy);
  for (let k = 0; k < 5; k++) {
    const base = 0.07 + k * 0.058;
    const rr = base * (1 + 0.13 * Math.sin(3 * ang + k * 0.9) + 0.07 * Math.sin(5 * ang + 1.7 * k));
    const width = k === 2 ? 0.009 : 0.0055;
    if (Math.abs(d - rr) < width) col = mix(col, TEAL, k === 2 ? 0.95 : 0.7);
  }
  if (inTriangle(u, v, [0.5, 0.485], [0.455, 0.565], [0.545, 0.565])) col = AMBER;
  return col;
}

// The Android adaptive icon: the launcher cuts its own shape (circle, squircle…) out of a plain
// background, so the foreground is the rings and the summit alone, shrunk into the 66 dp safe zone.
const ICON_BG = mix(TOP, BOTTOM, 0.5).map(Math.round); // the background colour in android/…/colors.xml
function foreground(u, v) {
  const x = 0.5 + (u - 0.5) * 1.2;
  const y = 0.5 + (v - 0.5) * 1.2;
  if (inTriangle(x, y, [0.5, 0.485], [0.455, 0.565], [0.545, 0.565])) return AMBER;
  const cx = 0.5;
  const cy = 0.53;
  const ang = Math.atan2(y - cy, x - cx);
  const d = Math.hypot(x - cx, y - cy);
  for (let k = 0; k < 5; k++) {
    const base = 0.07 + k * 0.058;
    const rr = base * (1 + 0.13 * Math.sin(3 * ang + k * 0.9) + 0.07 * Math.sin(5 * ang + 1.7 * k));
    const width = k === 2 ? 0.009 : 0.0055;
    if (Math.abs(d - rr) < width) return mix(ICON_BG, TEAL, k === 2 ? 0.95 : 0.7);
  }
  return null;
}

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
if (androidAt > 0) {
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

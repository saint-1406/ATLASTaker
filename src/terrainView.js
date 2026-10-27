// The living map behind the sheet: the open note's terrain, its headings as labelled summits in the
// margins, a graticule and an old-atlas neatline. Two stacked canvases let a new survey sweep over the
// old one instead of popping in.

import { baseField, buildHeightField, contourLevels, hashString, mulberry32, normalizeField } from './terrain.js';
import { count } from './i18n.js';

const CELL = 7; // px per grid cell
const LEVELS = 15;
const SEA = 0.14;

function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    line: v('--terrain-line'),
    index: v('--terrain-index'),
    water: v('--terrain-water'),
    coast: v('--terrain-coast'),
    grid: v('--terrain-grid'),
    frame: v('--terrain-frame'),
    peak: v('--peak'),
    label: v('--ink-soft'),
    dim: v('--ink-dim'),
    halo: v('--bg'),
  };
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo ? `${text.slice(0, lo).trimEnd()}…` : '';
}

/** Breaks a label into at most `maxLines` lines; whatever still doesn't fit gets an ellipsis. */
function wrapLabel(ctx, text, maxWidth, maxLines = 2) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (let i = 0; i < words.length; i++) {
    const next = current ? `${current} ${words[i]}` : words[i];
    if (!current || ctx.measureText(next).width <= maxWidth) {
      current = next;
      continue;
    }
    lines.push(current);
    if (lines.length === maxLines - 1) {
      current = words.slice(i).join(' ');
      break;
    }
    current = words[i];
  }
  if (current) lines.push(current);
  return lines.map((line) => fitText(ctx, line, maxWidth));
}

function formatDegrees(value, positive, negative) {
  const sign = value < 0 ? negative : positive;
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let min = Math.round((abs - deg) * 60);
  if (min === 60) { deg += 1; min = 0; }
  return `${deg}°${String(min).padStart(2, '0')}′${sign}`;
}

/** Headings become summits: in reading order top to bottom, alternating between the free margins. */
function placePeaks(spec, layout) {
  const heads = spec.headings.slice(0, 24);
  if (!heads.length) return [];
  const zones = [...layout.zones].sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0));
  const top = layout.frame.top + 64;
  const bottom = layout.frame.bottom - 64;
  const span = Math.max(1, bottom - top);
  const capacity = zones.map((z) => ({ zone: z, left: Math.floor(span / 64) }));
  return heads.map((hd, i) => {
    const rand = mulberry32(hashString(`${spec.id}|${i}|${hd.text}`));
    const slot = capacity.length ? capacity[i % capacity.length] : null;
    const zone = slot?.zone ?? null;
    const labelled = Boolean(slot && slot.left-- > 0);
    const y = top + ((i + 0.5) / heads.length) * span + (rand() - 0.5) * Math.min(24, span / heads.length / 3);
    let x;
    if (zone) {
      const pad = Math.min(60, (zone.x1 - zone.x0) * 0.3);
      x = zone.x0 + pad + rand() * Math.max(0, zone.x1 - zone.x0 - 2 * pad);
    } else {
      x = layout.w * (0.15 + rand() * 0.7);
    }
    const size = Math.min(1, Math.log10(1 + hd.words) / 2.5);
    const height = ([0, 0.95, 0.78, 0.62, 0.52, 0.46, 0.42][hd.level] ?? 0.42) * (0.75 + 0.45 * size);
    return { x, y, height, radius: 0.05 + 0.05 * size, text: hd.text, words: hd.words, line: hd.line, level: hd.level, zone, labelled };
  });
}

function strokeSegments(ctx, seg, sx, sy, color, width) {
  if (!seg.length) return;
  const path = new Path2D();
  for (let s = 0; s < seg.length; s += 4) {
    path.moveTo(seg[s] * sx, seg[s + 1] * sy);
    path.lineTo(seg[s + 2] * sx, seg[s + 3] * sy);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke(path);
}

// Low ground below "sea level" gets classic hatched water: a soft mask filled with hairlines.
function drawWater(ctx, field, cols, rows, sx, sy, pal, dpr) {
  const mask = document.createElement('canvas');
  mask.width = cols;
  mask.height = rows;
  const mctx = mask.getContext('2d');
  const img = mctx.createImageData(cols, rows);
  let any = false;
  for (let i = 0; i < field.length; i++) {
    const a = Math.max(0, Math.min(1, (SEA - field[i]) / 0.05));
    if (a > 0) any = true;
    img.data[i * 4 + 3] = Math.round(a * 255);
  }
  if (!any) return;
  mctx.putImageData(img, 0, 0);

  const layer = document.createElement('canvas');
  layer.width = ctx.canvas.width;
  layer.height = ctx.canvas.height;
  const lctx = layer.getContext('2d');
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = 'high';
  // stretch so that mask pixel centres land on grid points
  lctx.drawImage(mask, (-sx / 2) * dpr, (-sy / 2) * dpr, cols * sx * dpr, rows * sy * dpr);
  lctx.globalCompositeOperation = 'source-in';
  lctx.fillStyle = pal.water;
  const step = Math.round(5 * dpr);
  const thick = Math.max(1, Math.round(dpr));
  lctx.beginPath();
  for (let y = 0; y < layer.height; y += step) lctx.rect(0, y, layer.width, thick);
  lctx.fill();

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

function drawGraticule(ctx, spec, layout, pal) {
  const { frame } = layout;
  const rand = mulberry32(spec.seed ^ 0x51ed270b);
  const lat0 = 22 + rand() * 46;
  const lon0 = -30 + rand() * 150;
  const spacing = 160;
  const degPerCell = 0.25;
  ctx.save();
  ctx.strokeStyle = pal.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([1, 6]);
  ctx.beginPath();
  for (let x = frame.left + spacing; x < frame.right - 20; x += spacing) {
    ctx.moveTo(Math.round(x) + 0.5, frame.top);
    ctx.lineTo(Math.round(x) + 0.5, frame.bottom);
  }
  for (let y = frame.top + spacing; y < frame.bottom - 20; y += spacing) {
    ctx.moveTo(frame.left, Math.round(y) + 0.5);
    ctx.lineTo(frame.right, Math.round(y) + 0.5);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '500 9px "JetBrains Mono Variable", Consolas, monospace';
  ctx.fillStyle = pal.dim;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  for (let x = frame.left + spacing, k = 1; x < frame.right - 60; x += spacing, k++) {
    ctx.fillText(formatDegrees(lon0 + k * degPerCell, 'E', 'W'), x + 4, frame.top + 9);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  for (let y = frame.top + spacing, k = 1; y < frame.bottom - 20; y += spacing, k++) {
    ctx.fillText(formatDegrees(lat0 - k * degPerCell, 'N', 'S'), frame.right - 9, y - 3);
  }
  ctx.restore();
}

// The neatline of an old map: a double rule with an alternating black-and-white band between.
function drawFrame(ctx, layout, pal) {
  const { left, top, right, bottom } = layout.frame;
  const band = 5;
  const seg = 44;
  ctx.save();
  ctx.strokeStyle = pal.frame;
  ctx.fillStyle = pal.frame;
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, bottom - top - 1);
  ctx.strokeRect(left + band + 0.5, top + band + 0.5, right - left - 2 * band - 1, bottom - top - 2 * band - 1);
  for (let x = left + band, k = 0; x < right - band; x += seg, k++) {
    if (k % 2) continue;
    const w = Math.min(seg, right - band - x);
    ctx.fillRect(x, top, w, band);
    ctx.fillRect(x, bottom - band, w, band);
  }
  for (let y = top + band, k = 0; y < bottom - band; y += seg, k++) {
    if (k % 2) continue;
    const h = Math.min(seg, bottom - band - y);
    ctx.fillRect(left, y, band, h);
    ctx.fillRect(right - band, y, band, h);
  }
  ctx.fillRect(left, top, band, band);
  ctx.fillRect(right - band, top, band, band);
  ctx.fillRect(left, bottom - band, band, band);
  ctx.fillRect(right - band, bottom - band, band, band);
  ctx.restore();
}

function drawPeaks(ctx, peaks, pal) {
  const hits = [];
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const p of peaks) {
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 7);
    ctx.lineTo(p.x + 6, p.y + 4);
    ctx.lineTo(p.x - 6, p.y + 4);
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = pal.halo;
    ctx.stroke();
    ctx.fillStyle = pal.peak;
    ctx.fill();
    if (!p.labelled) continue;

    const big = p.level <= 1;
    const narrow = p.zone.x1 - p.zone.x0 < 170;
    const size = (big ? 19 : 16) - (narrow ? 2 : 0);
    ctx.font = `italic ${big ? 700 : 600} ${size}px "Cormorant Garamond", Georgia, serif`;
    const lines = wrapLabel(ctx, p.text, p.zone.x1 - p.zone.x0 - 8);
    const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const lx = Math.min(Math.max(p.x, p.zone.x0 + width / 2 + 4), p.zone.x1 - width / 2 - 4);
    const ly = p.y + 9;
    const lineHeight = Math.round(size * 1.08);
    lines.forEach((line, i) => {
      ctx.lineWidth = 5;
      ctx.strokeStyle = pal.halo;
      ctx.strokeText(line, lx, ly + i * lineHeight);
      ctx.fillStyle = pal.label;
      ctx.fillText(line, lx, ly + i * lineHeight);
    });

    ctx.font = '500 9.5px "JetBrains Mono Variable", Consolas, monospace';
    const elevation = `▲ ${count(p.words, 'metre')}`;
    const ey = ly + lines.length * lineHeight + 3;
    ctx.lineWidth = 4;
    ctx.strokeText(elevation, lx, ey);
    ctx.fillStyle = pal.dim;
    ctx.fillText(elevation, lx, ey);
    hits.push({ x0: Math.min(lx - width / 2, p.x - 8) - 6, x1: Math.max(lx + width / 2, p.x + 8) + 6, y0: p.y - 12, y1: ey + 14, line: p.line });
  }
  ctx.restore();
  return hits;
}

// The bare ground is the costly part and only changes with the note or the window size.
let groundCache = { key: '', field: null };

function groundFor(seed, cols, rows, aspect) {
  const key = `${seed}|${cols}|${rows}`;
  if (groundCache.key !== key) groundCache = { key, field: baseField({ seed, cols, rows, aspect }) };
  return groundCache.field;
}

function paint(canvas, spec, layout, pal) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { w, h } = layout;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cols = Math.ceil(w / CELL) + 1;
  const rows = Math.ceil(h / CELL) + 1;
  const peaks = placePeaks(spec, layout);
  const field = buildHeightField({
    seed: spec.seed,
    cols,
    rows,
    aspect: w / h,
    ruggedness: spec.ruggedness,
    peaks: peaks.map((p) => ({ x: p.x / w, y: p.y / h, height: p.height, radius: p.radius })),
    base: groundFor(spec.seed, cols, rows, w / h),
  });
  normalizeField(field);
  const sx = w / (cols - 1);
  const sy = h / (rows - 1);

  drawWater(ctx, field, cols, rows, sx, sy, pal, dpr);
  // level 0 is the coastline, every fifth one above it a heavier "index contour" as on survey maps
  const levels = [SEA];
  for (let k = 1; k <= LEVELS; k++) levels.push(SEA + (k / (LEVELS + 1)) * (1 - SEA));
  const contours = contourLevels(field, cols, rows, levels);
  ctx.lineCap = 'butt';
  contours.forEach((seg, k) => {
    if (k === 0) strokeSegments(ctx, seg, sx, sy, pal.coast, 1.2);
    else if (k % 5 === 0) strokeSegments(ctx, seg, sx, sy, pal.index, 1.15);
    else strokeSegments(ctx, seg, sx, sy, pal.line, 0.65);
  });
  drawGraticule(ctx, spec, layout, pal);
  drawFrame(ctx, layout, pal);
  return drawPeaks(ctx, peaks, pal);
}

export class TerrainView {
  constructor(host, { getLayout, onPeakClick }) {
    this.host = host;
    this.getLayout = getLayout;
    this.onPeakClick = onPeakClick;
    this.canvases = [this.#makeCanvas(), this.#makeCanvas()];
    this.front = 0;
    this.spec = null;
    this.hits = [];
    this.token = 0;
    this.enabled = true;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    let resizeTimer = 0;
    addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.render('none'), 150);
    });
    // the margins are see-through, so summits behind them are clickable
    host.addEventListener('pointermove', (e) => {
      host.style.cursor = this.#hit(e.clientX, e.clientY) ? 'pointer' : '';
    });
    host.addEventListener('click', (e) => {
      const hit = this.#hit(e.clientX, e.clientY);
      if (hit) this.onPeakClick(hit.line);
    });
  }

  #makeCanvas() {
    const canvas = document.createElement('canvas');
    canvas.style.opacity = '0';
    this.host.append(canvas);
    return canvas;
  }

  #hit(x, y) {
    return this.hits.find((h) => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) ?? null;
  }

  setSpec(spec, mode = 'fade', origin) {
    this.spec = spec;
    this.render(mode, origin);
  }

  /** Only the Atlas look shows the map; switched off, it draws nothing and takes no clicks. */
  setEnabled(on) {
    this.enabled = on;
    this.host.hidden = !on;
    if (!on) this.hits = [];
  }

  /** mode: 'reveal' sweeps a circle out from `origin`, 'fade' cross-fades, 'none' swaps at once. */
  render(mode = 'fade', origin) {
    if (!this.spec || !this.enabled) return;
    const layout = this.getLayout();
    const back = this.canvases[1 - this.front];
    const front = this.canvases[this.front];
    const token = ++this.token;
    for (const anim of back.getAnimations()) anim.cancel();
    this.hits = paint(back, this.spec, layout, readPalette());
    back.style.zIndex = '2';
    front.style.zIndex = '1';
    back.style.opacity = '1';
    this.front = 1 - this.front;

    const finish = () => {
      if (token === this.token) front.style.opacity = '0';
    };
    if (this.reduced || mode === 'none') {
      finish();
      return;
    }
    let anim;
    if (mode === 'reveal') {
      const x = origin?.x ?? layout.w / 2;
      const y = origin?.y ?? layout.h / 2;
      const r = Math.hypot(Math.max(x, layout.w - x), Math.max(y, layout.h - y));
      anim = back.animate(
        [{ clipPath: `circle(0px at ${x}px ${y}px)` }, { clipPath: `circle(${r}px at ${x}px ${y}px)` }],
        { duration: 1100, easing: 'cubic-bezier(.22,.7,.2,1)' },
      );
    } else {
      anim = back.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, easing: 'ease-in-out' });
    }
    anim.finished.then(finish, () => {});
  }
}

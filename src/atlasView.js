// The atlas: every note as an island of an archipelago. Oldest notes in the middle, newer ones further
// out, bigger notes bigger islands. Drag to pan, wheel to zoom, click an island to land on it.

import { drawPin, islandRings, layoutIslands, traceSmooth } from './archipelago.js';
import { hashString, mulberry32 } from './terrain.js';
import { formatCount, WORD_FORMS } from './markdown.js';
import { h } from './overlays.js';

const ISLAND_FORMS = { one: 'остров', few: 'острова', many: 'островов', other: 'острова' };
const number = new Intl.NumberFormat('ru-RU');
const longDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function readAtlasPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    ocean: v('--ocean'),
    land: v('--land'),
    landHi: v('--land-hi'),
    coast: v('--atlas-coast'),
    contour: v('--atlas-contour'),
    shallow: v('--atlas-shallow'),
    wave: v('--atlas-wave'),
    grid: v('--terrain-grid'),
    frame: v('--terrain-frame'),
    accent: v('--accent'),
    ink: v('--ink'),
    dim: v('--ink-dim'),
  };
}

function clip(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

export class AtlasView {
  constructor(root, { getNotes, getCurrentId, onOpen, onCreate, onClose }) {
    Object.assign(this, { root, getNotes, getCurrentId, onOpen, onCreate, onClose });
    this.canvas = root.querySelector('.atlas-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.input = root.querySelector('#atlas-filter');
    this.tip = root.querySelector('#atlas-tip');
    this.sub = root.querySelector('#atlas-sub');
    this.view = { x: 0, y: 0, k: 1 };
    this.nodes = [];
    this.hover = null;
    this.tipFor = null;
    this.query = '';
    this.isOpen = false;
    this.drag = null;
    this.busy = false;
    this.raf = 0;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.#bind();
  }

  show() {
    const items = this.getNotes()
      .slice()
      .sort((a, b) => a.created - b.created)
      .map((n) => ({
        id: n.id,
        created: n.created,
        updated: n.updated,
        words: n.info.words,
        title: n.info.title || 'Без названия',
        excerpt: n.info.excerpt,
        hay: `${n.info.title}\n${n.content}`.toLowerCase(),
      }));
    const placed = layoutIslands(items);
    this.nodes = items.map((it, i) => ({ ...it, ...placed[i], ...islandRings(it.id, placed[i].r) }));
    const land = items.reduce((sum, n) => sum + n.words, 0);
    this.sub.textContent = `${formatCount(items.length, ISLAND_FORMS)} · ${formatCount(land, WORD_FORMS)} суши`;

    this.root.hidden = false;
    this.isOpen = true;
    this.busy = false;
    this.root.classList.remove('leaving');
    this.root.classList.add('entering');
    setTimeout(() => this.root.classList.remove('entering'), 500);
    this.input.value = '';
    this.query = '';
    this.hover = null;
    this.tip.hidden = true;
    this.#resize();
    this.#fit();
    this.render();
    this.input.focus({ preventScroll: true });
  }

  hide() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    this.tip.hidden = true;
    this.root.classList.remove('leaving');
    this.onClose?.();
  }

  render() {
    if (!this.isOpen) return;
    const { ctx } = this;
    const pal = readAtlasPalette();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = pal.ocean;
    ctx.fillRect(0, 0, this.w, this.h);
    this.#grid(pal);
    this.#waves(pal);
    const current = this.getCurrentId();
    for (const n of this.nodes) this.#island(n, pal, n.id === current);
    for (const n of this.nodes) this.#label(n, pal, n.id === current);
    this.#frame(pal);
  }

  #resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  #fit() {
    if (!this.nodes.length) {
      this.view = { x: this.w / 2, y: this.h / 2, k: 1 };
      return;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of this.nodes) {
      x0 = Math.min(x0, n.x - n.r * 1.35);
      x1 = Math.max(x1, n.x + n.r * 1.35);
      y0 = Math.min(y0, n.y - n.r * 1.35);
      y1 = Math.max(y1, n.y + n.r * 1.35 + 44);
    }
    const padX = 110;
    const padTop = 150;
    const padBottom = 80;
    const k = clamp(Math.min((this.w - 2 * padX) / (x1 - x0), (this.h - padTop - padBottom) / (y1 - y0)), 0.25, 1.7);
    this.view = {
      k,
      x: this.w / 2 - ((x0 + x1) / 2) * k,
      y: padTop + (this.h - padTop - padBottom) / 2 - ((y0 + y1) / 2) * k,
    };
  }

  #schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  #matches(n) {
    return !this.query || n.hay.includes(this.query);
  }

  #screen(n) {
    const { x, y, k } = this.view;
    return { sx: x + n.x * k, sy: y + n.y * k, R: n.r * k };
  }

  #grid(pal) {
    const { ctx, view } = this;
    const step = 400 * view.k;
    if (step < 40) return;
    ctx.save();
    ctx.strokeStyle = pal.grid;
    ctx.setLineDash([1, 7]);
    ctx.beginPath();
    for (let x = ((view.x % step) + step) % step; x < this.w; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, this.h);
    }
    for (let y = ((view.y % step) + step) % step; y < this.h; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(this.w, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }

  #waves(pal) {
    const { ctx, view } = this;
    const T = 170;
    const tx0 = Math.floor(-view.x / view.k / T);
    const tx1 = Math.floor((this.w - view.x) / view.k / T);
    const ty0 = Math.floor(-view.y / view.k / T);
    const ty1 = Math.floor((this.h - view.y) / view.k / T);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 900) return;
    const s = 7 * clamp(view.k, 0.6, 1.4);
    ctx.save();
    ctx.strokeStyle = pal.wave;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const rand = mulberry32(hashString(`${tx},${ty}`));
        for (let i = 0; i < 3; i++) {
          const sx = view.x + (tx * T + rand() * T) * view.k;
          const sy = view.y + (ty * T + rand() * T) * view.k;
          ctx.moveTo(sx - s, sy);
          ctx.quadraticCurveTo(sx - s / 2, sy - s / 2.4, sx, sy);
          ctx.quadraticCurveTo(sx + s / 2, sy + s / 2.4, sx + s, sy);
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  #island(n, pal, isCurrent) {
    const { ctx } = this;
    const { sx, sy, R } = this.#screen(n);
    if (sx + R * 1.5 < 0 || sx - R * 1.5 > this.w || sy + R * 1.5 < 0 || sy - R * 1.5 > this.h) return;
    const k = this.view.k;
    const hot = this.hover === n;
    ctx.save();
    ctx.globalAlpha = this.#matches(n) ? 1 : 0.16;
    ctx.lineJoin = 'round';

    ctx.beginPath();
    traceSmooth(ctx, n.rings[0], sx, sy, k * 1.28);
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = pal.shallow;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    traceSmooth(ctx, n.rings[0], sx, sy, k);
    ctx.fillStyle = pal.land;
    ctx.fill();
    const base = ctx.globalAlpha;
    for (let r = 1; r < n.rings.length; r++) {
      ctx.beginPath();
      traceSmooth(ctx, n.rings[r], sx, sy, k);
      ctx.globalAlpha = base * 0.42;
      ctx.fillStyle = pal.landHi;
      ctx.fill();
      ctx.globalAlpha = base;
      ctx.strokeStyle = pal.contour;
      ctx.lineWidth = 0.9;
      ctx.stroke();
    }
    ctx.beginPath();
    traceSmooth(ctx, n.rings[0], sx, sy, k);
    ctx.strokeStyle = hot || isCurrent ? pal.accent : pal.coast;
    ctx.lineWidth = hot ? 2.4 : 1.4;
    ctx.stroke();
    if (isCurrent) drawPin(ctx, sx + n.summit[0] * k, sy + n.summit[1] * k, pal.accent, pal.ocean);
    ctx.restore();
  }

  #label(n, pal, isCurrent) {
    const { ctx } = this;
    const { sx, sy, R } = this.#screen(n);
    const hot = this.hover === n;
    if (R < 11 && !isCurrent && !hot) return;
    if (sx < -200 || sx > this.w + 200 || sy < -100 || sy > this.h + 100) return;
    ctx.save();
    ctx.globalAlpha = this.#matches(n) ? 1 : 0.22;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    const fs = clamp(12 * Math.sqrt(this.view.k) + R * 0.05, 11, 22);
    ctx.font = `italic 600 ${fs}px "Cormorant Garamond", Georgia, serif`;
    const title = clip(ctx, n.title, Math.max(130, R * 3.2));
    const ly = sy + R * 1.15 + 4;
    ctx.lineWidth = 4;
    ctx.strokeStyle = pal.ocean;
    ctx.strokeText(title, sx, ly);
    ctx.fillStyle = isCurrent || hot ? pal.accent : pal.ink;
    ctx.fillText(title, sx, ly);
    ctx.font = `500 ${clamp(9 * Math.sqrt(this.view.k), 8.5, 11)}px "JetBrains Mono Variable", Consolas, monospace`;
    const meta = `${number.format(n.words)} сл. · ${shortDate.format(n.updated).replace('.', '')}`;
    ctx.lineWidth = 3;
    ctx.strokeText(meta, sx, ly + fs + 2);
    ctx.fillStyle = pal.dim;
    ctx.fillText(meta, sx, ly + fs + 2);
    ctx.restore();
  }

  #frame(pal) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = pal.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(14.5, 14.5, this.w - 29, this.h - 29);
    ctx.strokeRect(19.5, 19.5, this.w - 39, this.h - 39);
    ctx.restore();
  }

  #hit(mx, my) {
    const { x, y, k } = this.view;
    const wx = (mx - x) / k;
    const wy = (my - y) / k;
    let best = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot(wx - n.x, wy - n.y);
      if (d < n.r * 1.15 && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  #showTip(n, x, y) {
    if (!n) {
      this.tip.hidden = true;
      this.tipFor = null;
      return;
    }
    if (this.tipFor !== n) {
      this.tipFor = n;
      this.tip.replaceChildren(
        h('div', { class: 'tip-title' }, n.title),
        h('div', { class: 'tip-meta' }, `${formatCount(n.words, WORD_FORMS)} · открыт ${longDate.format(n.created)}`),
        n.excerpt ? h('div', { class: 'tip-text' }, n.excerpt) : null,
      );
    }
    this.tip.hidden = false;
    const r = this.tip.getBoundingClientRect();
    this.tip.style.left = `${Math.min(x + 18, this.w - r.width - 14)}px`;
    this.tip.style.top = `${Math.min(y + 18, this.h - r.height - 14)}px`;
  }

  /** Zoom into the island, then land on it. */
  pick(id) {
    const n = this.nodes.find((node) => node.id === id);
    if (!n || this.busy) return;
    this.busy = true;
    this.tip.hidden = true;
    const start = { ...this.view };
    const k = Math.min(5, start.k * 3);
    const end = { k, x: this.w / 2 - n.x * k, y: this.h / 2 - n.y * k };
    const duration = this.reduced ? 0 : 420;
    const t0 = performance.now();
    this.root.classList.add('leaving');
    const step = (now) => {
      const t = duration ? Math.min(1, (now - t0) / duration) : 1;
      const e = 1 - (1 - t) ** 3;
      this.view = { k: start.k + (end.k - start.k) * e, x: start.x + (end.x - start.x) * e, y: start.y + (end.y - start.y) * e };
      this.render();
      if (t < 1) requestAnimationFrame(step);
      else {
        this.hide();
        this.onOpen(id);
      }
    };
    requestAnimationFrame(step);
  }

  #bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.busy) return;
      c.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        if (!this.drag.moved && Math.hypot(dx, dy) > 4) {
          this.drag.moved = true;
          c.classList.add('dragging');
          this.#showTip(null);
        }
        if (this.drag.moved) {
          this.view.x = this.drag.vx + dx;
          this.view.y = this.drag.vy + dy;
          this.#schedule();
        }
        return;
      }
      const hit = this.busy ? null : this.#hit(e.clientX, e.clientY);
      if (hit !== this.hover) {
        this.hover = hit;
        c.classList.toggle('hovering', Boolean(hit));
        this.#schedule();
      }
      this.#showTip(hit, e.clientX, e.clientY);
    });
    c.addEventListener('pointerup', (e) => {
      const drag = this.drag;
      this.drag = null;
      c.classList.remove('dragging');
      if (drag && !drag.moved) {
        const hit = this.#hit(e.clientX, e.clientY);
        if (hit) this.pick(hit.id);
      }
    });
    c.addEventListener('pointerleave', () => {
      if (this.drag) return;
      this.hover = null;
      this.#showTip(null);
      this.#schedule();
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const k = clamp(this.view.k * Math.exp(-e.deltaY * 0.0015), 0.2, 5);
        const ratio = k / this.view.k;
        this.view = { k, x: e.clientX - (e.clientX - this.view.x) * ratio, y: e.clientY - (e.clientY - this.view.y) * ratio };
        this.#showTip(null);
        this.#schedule();
      },
      { passive: false },
    );
    this.input.addEventListener('input', () => {
      this.query = this.input.value.trim().toLowerCase();
      this.#schedule();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const match = this.nodes.find((n) => this.query && this.#matches(n));
      if (match) this.pick(match.id);
    });
    this.root.querySelector('#atlas-close').addEventListener('click', () => this.hide());
    this.root.querySelector('#atlas-new').addEventListener('click', () => {
      this.hide();
      this.onCreate();
    });
    document.addEventListener('keydown', (e) => {
      if (this.isOpen && e.key === 'Escape' && !document.querySelector('#overlays .scrim')) {
        e.preventDefault();
        this.hide();
      }
    });
    addEventListener('resize', () => {
      if (!this.isOpen) return;
      this.#resize();
      this.render();
    });
  }
}

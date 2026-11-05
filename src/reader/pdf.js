// PDF through pdf.js (the legacy build: it carries its own polyfills, so older Android WebViews read
// it too). Pages are laid out at once as empty frames and drawn only near the view; pages far away
// give their canvases back, so a 500-page book fits in a phone's memory. A transparent text layer
// over each page makes the words selectable, for quotes.

import { AnnotationMode, getDocument, PDFWorker, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerSource from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
import { createPager } from './pager.js';
import { mergeRects, pickLine } from '../marks.js';
import { familyOf, loadFaces } from './pdffonts.js';
import { findIn, foldText, MAX_HITS, queryPattern, snippet } from './search.js';

let worker = null;

// One worker for every document, started from the bundle itself (a blob: URL), so no file has to
// be served next to it. Handed to each document explicitly, so closing one does not stop it.
function sharedWorker() {
  if (!worker) {
    const port = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));
    worker = new PDFWorker({ port });
  }
  return worker;
}

export function loadPdf(bytes) {
  // pdf.js takes the buffer over: hand it a copy
  // fontExtraProperties: the fonts' own names reach the page, so a rewritten line can tell bold
  return getDocument({ data: bytes.slice(), worker: sharedWorker(), useSystemFonts: true, enableXfa: false, stopAtErrors: false, fontExtraProperties: true }).promise;
}

export const closeDoc = (doc) => doc.loadingTask.destroy().catch(() => {});

// "Microsoft Word - report.docx", "untitled" and the like are not titles
const NOT_A_TITLE = /^(microsoft (word|powerpoint|excel) - |untitled|document\d*$|slide \d+$)|\.(docx?|pptx?|xlsx?|pdf|tex|indd)$/i;
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Title, author, page count and a small picture of the first page. */
/** sample: also some text of the first pages (Apocrypha guesses the language from it). */
export async function pdfInfo(bytes, coverWidth = 240, { sample = false } = {}) {
  const doc = await loadPdf(bytes);
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const title = clean(meta?.info?.Title);
    let cover = null;
    try {
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: coverWidth / page.getViewport({ scale: 1 }).width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, annotationMode: AnnotationMode.DISABLE }).promise;
      cover = canvas.toDataURL('image/jpeg', 0.8);
    } catch {
      // no picture: the card shows the format instead
    }
    let text = '';
    for (let n = 1; sample && n <= Math.min(doc.numPages, 4) && text.length < 6000; n++) {
      try {
        const content = await (await doc.getPage(n)).getTextContent();
        text += ` ${content.items.map((item) => item.str ?? '').join(' ')}`;
      } catch {
        break;
      }
    }
    const lang = String(meta?.info?.Language ?? '');
    return { title: NOT_A_TITLE.test(title) ? '' : title, author: clean(meta?.info?.Author), pages: doc.numPages, cover, text: text.trim(), lang };
  } finally {
    closeDoc(doc);
  }
}

/**
 * Two ways to read: one column of pages to scroll, or one page at a time, fitted to the screen and
 * turned left to right (pager.js). The frames stay the same elements in both; only their size and
 * the strip they sit in change.
 */
export async function openPdf(host, bytes, { position, scale = 1, mode = 'scroll', turn = 'flip', onPosition } = {}) {
  const doc = await loadPdf(bytes);
  const first = (await doc.getPage(1)).getViewport({ scale: 1 });
  const firstRatio = first.width / first.height;
  const wrap = document.createElement('div');
  wrap.className = 'reader-pdf';
  wrap.style.setProperty('--pdf-zoom', String(scale));
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const frame = document.createElement('div');
    frame.className = 'pdf-page';
    frame.dataset.page = String(i);
    frame.style.aspectRatio = `${first.width} / ${first.height}`;
    pages.push(frame);
    wrap.append(frame);
  }
  host.replaceChildren(wrap);

  const drawn = new Map(); // page number → { width, canvas, text, task, layer, cancelled }
  const near = new Set();
  let pager = null;
  let currentTurn = turn;

  // the screen is measured once for all the pages: reading it between two pages' new sizes would make
  // the browser lay all the pages out again for every one of them (minutes, for a thousand pages)
  const roomNow = () => ({ width: host.clientWidth, height: host.clientHeight });

  /** In page mode a frame fills the screen as far as its shape allows, centred in a slot one screen wide. */
  function fit(frame, room = roomNow()) {
    const ratio = Number(frame.dataset.ratio) || firstRatio;
    const w = Math.max(40, Math.min(room.width - 16, (room.height - 16) * ratio));
    const h = w / ratio;
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
    frame.style.margin = `${(room.height - h) / 2}px ${(room.width - w) / 2}px`;
  }

  function release(n) {
    const entry = drawn.get(n);
    if (!entry) return;
    entry.cancelled = true;
    entry.task?.cancel();
    entry.layer?.cancel();
    if (entry.canvas) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
      entry.canvas.remove();
    }
    entry.text?.remove();
    drawn.delete(n);
  }

  async function draw(n) {
    const frame = pages[n - 1];
    if (!frame.clientWidth || Math.abs((drawn.get(n)?.width ?? -10) - frame.clientWidth) < 2) return;
    release(n);
    const entry = { width: frame.clientWidth, cancelled: false };
    drawn.set(n, entry);
    try {
      const page = await doc.getPage(n);
      if (entry.cancelled) return;
      const base = page.getViewport({ scale: 1 });
      frame.dataset.ratio = String(base.width / base.height);
      frame.style.aspectRatio = `${base.width} / ${base.height}`;
      if (pager) fit(frame);
      const width = frame.clientWidth;
      entry.width = width;
      const cssScale = width / base.width;
      const ratio = Math.min(window.devicePixelRatio || 1, innerWidth < 700 ? 1.75 : 2);
      const viewport = page.getViewport({ scale: cssScale * ratio });
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      entry.canvas = canvas;
      frame.append(canvas);
      // highlights, notes and drawings other PDF programs left in the file are drawn with the page
      entry.task = page.render({ canvasContext: canvas.getContext('2d'), viewport, annotationMode: AnnotationMode.ENABLE });
      await entry.task.promise;
      if (entry.cancelled) return;
      const text = document.createElement('div');
      text.className = 'textLayer';
      frame.style.setProperty('--total-scale-factor', String(cssScale));
      entry.text = text;
      frame.append(text);
      entry.layer = new TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: page.getViewport({ scale: cssScale }) });
      await entry.layer.render();
      // as in pdf.js' own viewer: while a selection is being made, an empty block spreads over the page
      // below the words, so dragging between lines widens the selection instead of jumping about
      const end = document.createElement('div');
      end.className = 'endOfContent';
      text.append(end);
      text.addEventListener('pointerdown', () => {
        text.classList.add('selecting');
        const done = () => text.classList.remove('selecting');
        window.addEventListener('pointerup', done, { once: true });
        window.addEventListener('pointercancel', done, { once: true });
      });
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException' && !entry.cancelled) console.warn(`pdf page ${n}:`, err);
    }
  }

  // pages near the view (above, below, or beside it in page mode) are drawn; the rest give their memory back
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const n = Number(e.target.dataset.page);
        if (e.isIntersecting) {
          near.add(n);
          draw(n);
        } else {
          near.delete(n);
          release(n);
        }
      }
    },
    { root: host, rootMargin: '120% 120%' },
  );
  pages.forEach((frame) => observer.observe(frame));

  const viewTop = () => host.getBoundingClientRect().top;
  function current() {
    if (pager) return { page: pager.index + 1, frac: 0 };
    const top = viewTop() + 1;
    let lo = 0;
    let hi = pages.length - 1;
    let found = pages.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pages[mid].getBoundingClientRect().bottom > top) {
        found = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    const r = pages[found].getBoundingClientRect();
    return { page: found + 1, frac: Math.round(Math.max(0, Math.min(1, (viewTop() - r.top) / r.height)) * 1000) / 1000 };
  }
  function restore(pos) {
    const index = Math.max(0, Math.min(pages.length - 1, (pos?.page ?? 1) - 1));
    if (pager) {
      pager.go(index, { animate: false });
      return;
    }
    if (!pos) return;
    const r = pages[index].getBoundingClientRect();
    host.scrollTop += r.top - viewTop() + (pos.frac || 0) * r.height;
  }
  const progress = () => {
    const { page, frac } = current();
    return pages.length > 1 ? Math.min(1, (page - 1 + frac) / (pages.length - 1)) : 1;
  };
  const goToPage = (index) => {
    if (pager) pager.go(index);
    else if (pages[index]) host.scrollTop += pages[index].getBoundingClientRect().top - viewTop();
  };
  const report = () => onPosition?.(current(), progress());

  function setMode(next, pos = current()) {
    if ((next === 'pages') === Boolean(pager)) return;
    if (next === 'pages') {
      host.classList.add('paged');
      wrap.classList.add('paged');
      host.scrollTop = 0;
      pager = createPager({
        host,
        strip: wrap,
        frameFor: (i) => pages[i],
        layout: () => {
          const room = roomNow();
          for (const frame of pages) fit(frame, room);
          return { step: room.width, count: pages.length };
        },
        onTurn: report,
      });
      pager.setTurn(currentTurn);
    } else {
      pager.destroy();
      pager = null;
      host.classList.remove('paged');
      wrap.classList.remove('paged');
      for (const frame of pages) {
        frame.style.width = '';
        frame.style.height = '';
        frame.style.margin = '';
      }
    }
    restore(pos);
    requestAnimationFrame(() => near.forEach(draw));
    report();
  }

  function relayout() {
    const pos = current();
    pager?.relayout();
    restore(pos);
    near.forEach(draw);
  }

  if (mode === 'pages') setMode('pages', position);
  else restore(position);

  let timer = 0;
  const onScroll = () => {
    if (pager) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      report();
    }, 300);
  };
  host.addEventListener('scroll', onScroll, { passive: true });

  let resizeTimer = 0;
  let lastSize = `${host.clientWidth}x${host.clientHeight}`;
  const resized = new ResizeObserver(() => {
    const size = `${host.clientWidth}x${host.clientHeight}`;
    if (size === lastSize) return;
    lastSize = size;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 150);
  });
  resized.observe(host);

  const toc = [];
  try {
    const walk = (items, level) => {
      for (const item of items ?? []) {
        // the page an entry leads to (0-based), found once and kept: for the jump and the number shown
        let target = null;
        const pageIndex = () =>
          (target ??= (async () => {
            let dest = item.dest;
            if (typeof dest === 'string') dest = await doc.getDestination(dest);
            if (!Array.isArray(dest)) return null;
            return typeof dest[0] === 'object' ? await doc.getPageIndex(dest[0]) : dest[0];
          })().catch(() => null));
        toc.push({
          level,
          text: clean(item.title).slice(0, 160),
          async go() {
            const index = await pageIndex();
            if (Number.isInteger(index)) goToPage(index);
          },
          pageNumber: async () => {
            const index = await pageIndex();
            return Number.isInteger(index) ? index + 1 : null;
          },
        });
        walk(item.items, level + 1);
      }
    };
    walk(await doc.getOutline(), 1);
  } catch {
    // no outline
  }
  if (!toc.length && pages.length > 1) {
    // no outline: a page list, thinned out for long files, so a long file can still be crossed quickly
    const step = pages.length > 60 ? 10 : pages.length > 20 ? 5 : 1;
    for (let i = 0; i < pages.length; i += step) toc.push({ level: 1, page: i + 1, go: () => goToPage(i) });
  }

  // ---------- marks: boxes as fractions of the page, drawn under the (transparent) text layer ----------

  let marks = [];
  const markLayers = new Map(); // page number → its layer of boxes
  function anchorOf(range) {
    if (!range || range.collapsed || !wrap.contains(range.commonAncestorContainer)) return null;
    const boxes = [];
    const frames = [...drawn.keys()].map((n) => [n, pages[n - 1].getBoundingClientRect()]);
    for (const r of range.getClientRects()) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = frames.find(([, f]) => cx >= f.left && cx <= f.right && cy >= f.top && cy <= f.bottom);
      if (!hit) continue;
      const [n, f] = hit;
      // the text layer's end-of-content box spans the page: not a line of text
      if (r.height / f.height > 0.2) continue;
      boxes.push([n, (r.left - f.left) / f.width, (r.top - f.top) / f.height, r.width / f.width, r.height / f.height]);
    }
    const rects = mergeRects(boxes).slice(0, 400);
    return rects.length ? { rects } : null;
  }
  function paintMarks(activeId = null) {
    for (const layer of markLayers.values()) layer.replaceChildren();
    for (const m of marks) {
      for (const [n, x, y, w, h] of m.anchor?.rects ?? []) {
        const frame = pages[n - 1];
        if (!frame) continue;
        let layer = markLayers.get(n);
        if (!layer) {
          layer = document.createElement('div');
          layer.className = 'pdf-marks';
          frame.append(layer);
          markLayers.set(n, layer);
        }
        const box = document.createElement('div');
        box.className = `pdf-mark${m.note ? ' noted' : ''}${m.id === activeId ? ' active' : ''}`;
        box.dataset.color = m.color;
        box.dataset.mark = m.id;
        Object.assign(box.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
        layer.append(box);
      }
    }
  }
  function goToMark(id) {
    const m = marks.find((x) => x.id === id);
    const first = m?.anchor?.rects?.[0];
    if (!first) return false;
    const index = first[0] - 1;
    if (!pages[index]) return false;
    if (pager) pager.go(index);
    else {
      const f = pages[index].getBoundingClientRect();
      host.scrollTop += f.top + first[2] * f.height - viewTop() - host.clientHeight / 3;
    }
    return true;
  }

  // ---------- texts: words written on a page, over the page's own text (so they can be clicked) ----------

  let written = []; // the texts on the pages (setTexts)
  const textLayers = new Map(); // page number → its layer of texts
  function paintTexts(activeId = null) {
    for (const layer of textLayers.values()) layer.replaceChildren();
    for (const item of written) {
      const frame = pages[item.page - 1];
      if (!frame) continue;
      let layer = textLayers.get(item.page);
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'pdf-texts';
        frame.append(layer);
        textLayers.set(item.page, layer);
      }
      const box = document.createElement('div');
      box.className = `pdf-text${item.id === activeId ? ' active' : ''}${item.text.trim() ? '' : ' empty'}`;
      box.dataset.text = item.id;
      box.dataset.color = item.color;
      box.textContent = item.text;
      Object.assign(box.style, { left: `${item.x * 100}%`, top: `${item.y * 100}%`, width: `${item.w * 100}%`, fontSize: `calc(100cqw * ${item.size})` });
      layer.append(box);
    }
  }
  /** The page under a point of the screen, and the point on it as fractions of the page. */
  function pointAt(x, y) {
    for (const [i, frame] of pages.entries()) {
      const f = frame.getBoundingClientRect();
      if (x >= f.left && x <= f.right && y >= f.top && y <= f.bottom && f.width > 0) return { page: i + 1, x: (x - f.left) / f.width, y: (y - f.top) / f.height };
    }
    return null;
  }
  function goToText(id) {
    const item = written.find((x) => x.id === id);
    const index = (item?.page ?? 0) - 1;
    if (!pages[index]) return false;
    if (pager) pager.go(index);
    else {
      const f = pages[index].getBoundingClientRect();
      host.scrollTop += f.top + item.y * f.height - viewTop() - host.clientHeight / 3;
    }
    return true;
  }

  // ---------- edits: lines of the page's own text, rewritten; drawn in SVG so the words sit on the line ----------

  let edits = [];
  let hiddenEdit = null; // the edit being typed into: its field stands in its place
  const editLayers = new Map(); // page number → its <svg>
  const SVG = 'http://www.w3.org/2000/svg';
  const svgEl = (name, attrs) => {
    const el = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };
  // the cover reaches a little past the old letters, which can overhang their box
  const coverOf = (e) => ({ x: e.x - e.size * 0.08, y: e.y, w: e.w + e.size * 0.16, h: e.h });

  function paintEdits() {
    for (const layer of editLayers.values()) layer.replaceChildren();
    for (const e of edits) {
      const frame = pages[e.page - 1];
      if (!frame || e.id === hiddenEdit) continue;
      const ratio = Number(frame.dataset.ratio) || firstRatio;
      const height = 1000 / ratio;
      let layer = editLayers.get(e.page);
      if (!layer) {
        layer = svgEl('svg', { class: 'pdf-edits', viewBox: `0 0 1000 ${height}`, preserveAspectRatio: 'none' });
        frame.append(layer);
        editLayers.set(e.page, layer);
      }
      layer.setAttribute('viewBox', `0 0 1000 ${height}`);
      const c = coverOf(e);
      const g = svgEl('g', { class: 'pdf-edit', 'data-edit': e.id });
      g.append(svgEl('rect', { x: c.x * 1000, y: c.y * height, width: c.w * 1000, height: c.h * height, fill: e.bg }));
      if (e.text) {
        const text = svgEl('text', { x: e.x * 1000, y: e.base * height, fill: e.ink, 'font-size': e.size * 1000, 'font-weight': e.bold ? 700 : 400, 'xml:space': 'preserve' });
        text.style.fontFamily = familyOf(e.font);
        text.textContent = e.text;
        g.append(text);
      }
      layer.append(g);
    }
  }

  /** Average colour of a canvas's pixels in a box, the darkest of them too. */
  function sample(canvas, x0, y0, x1, y1) {
    const w = Math.max(1, Math.round(x1 - x0));
    const h = Math.max(1, Math.round(y1 - y0));
    const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(Math.round(x0), Math.round(y0), w, h).data;
    let dark = null;
    let darkest = Infinity;
    // the commonest colour: pixels grouped by a coarse key, then the exact average of the biggest group
    const groups = new Map(); // key → [count, r, g, b]
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      const lum = r * 0.3 + g * 0.59 + b * 0.11;
      if (lum < darkest) {
        darkest = lum;
        dark = [r, g, b];
      }
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const sum = groups.get(key) ?? [0, 0, 0, 0];
      sum[0]++;
      sum[1] += r;
      sum[2] += g;
      sum[3] += b;
      groups.set(key, sum);
    }
    let best = null;
    for (const sum of groups.values()) if (!best || sum[0] > best[0]) best = sum;
    best ??= [1, 255, 255, 255];
    const common = [best[1], best[2], best[3]].map((v) => Math.round(v / best[0]));
    return { common, dark: dark ?? [0, 0, 0] };
  }
  const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

  /**
   * The line of the page's text under a point of the screen, ready to be rewritten:
   * { page, x, y, w, h, base, size, font, bold, ink, bg, original } (see marks.js), or null.
   */
  async function lineAt(clientX, clientY) {
    const at = pointAt(clientX, clientY);
    if (!at) return null;
    const content = await pageText(at.page);
    const { viewport } = content;
    if (!viewport) return null;
    const page = await doc.getPage(at.page);
    const runs = [];
    for (const item of content.items) {
      if (!item.str) continue;
      const [a, b, c, d, x, y] = item.transform;
      const along = Math.hypot(a, b) || 1;
      const size = item.height || Math.hypot(c, d) || 1;
      const w = item.width || size * item.str.length * 0.5;
      const [x0, y0] = viewport.convertToViewportPoint(x, y);
      const [x1, y1] = viewport.convertToViewportPoint(x + (a / along) * w, y + (b / along) * w);
      // only lines that read left to right as the page is shown
      if (x1 <= x0 || Math.abs(y1 - y0) > size * 0.2) continue;
      let bold = false;
      try {
        bold = /bold|black|heavy|semibold|demi/i.test(page.commonObjs.get(item.fontName)?.name ?? '');
      } catch {
        // the font is not loaded yet: regular
      }
      const font = /mono|courier/i.test(item.font) ? 'mono' : /serif/i.test(item.font) && !/sans/i.test(item.font) ? 'serif' : 'sans';
      runs.push({ str: item.str, left: x0, right: x1, base: y0, top: y0 - size * 0.95, bottom: y0 + size * 0.28, size, font, bold });
    }
    const line = pickLine(runs, at.x * viewport.width, at.y * viewport.height);
    if (!line?.text) return null;
    const vw = viewport.width;
    const vh = viewport.height;
    const pad = line.size * 0.08;
    const box = { x: line.left / vw, y: (line.top - pad) / vh, w: (line.right - line.left) / vw, h: (line.bottom - line.top + pad * 2) / vh };
    let ink = [0, 0, 0];
    let bg = [255, 255, 255];
    // colours come from the page as drawn: wait for a drawing still going on (it starts all white)
    const entry = drawn.get(at.page);
    await entry?.task?.promise?.catch(() => {});
    const canvas = drawn.get(at.page)?.canvas;
    if (canvas?.width && !drawn.get(at.page)?.cancelled) {
      const sx = canvas.width;
      const sy = canvas.height;
      ink = sample(canvas, box.x * sx, box.y * sy, (box.x + box.w) * sx, (box.y + box.h) * sy).dark;
      // the page's colour: just above the line
      const strip = (line.size / vh) * 0.3 * sy;
      bg = sample(canvas, box.x * sx, Math.max(0, box.y * sy - strip), (box.x + box.w) * sx, Math.max(1, box.y * sy)).common;
    }
    const lum = ([r, g, b]) => r * 0.3 + g * 0.59 + b * 0.11;
    // words that would not stand out from the page (a page caught half drawn): dark on light, or light on dark
    if (Math.abs(lum(ink) - lum(bg)) < 60) ink = lum(bg) > 128 ? [0, 0, 0] : [255, 255, 255];
    await loadFaces();
    return { page: at.page, ...box, base: line.base / vh, size: line.size / vw, font: line.font, bold: line.bold, ink: hex(ink), bg: hex(bg), original: line.text };
  }

  // ---------- finding words: every page's text, read a few pages at a time; matches as boxes like the marks ----------

  const texts = new Map(); // page number → Promise of { text, folded, items: [{ start, end, str, transform, width, height }], viewport }
  function pageText(n) {
    if (!texts.has(n)) {
      texts.set(
        n,
        (async () => {
          const page = await doc.getPage(n);
          const content = await page.getTextContent();
          let text = '';
          const items = [];
          for (const item of content.items) {
            if (typeof item.str !== 'string') continue;
            const font = content.styles?.[item.fontName]?.fontFamily || 'sans-serif';
            items.push({ start: text.length, end: text.length + item.str.length, str: item.str, transform: item.transform, width: item.width, height: item.height, font, fontName: item.fontName });
            text += item.str;
            if (item.hasEOL) text += '\n';
          }
          return { text, folded: foldText(text), items, viewport: page.getViewport({ scale: 1 }) };
        })().catch(() => ({ text: '', folded: foldText(''), items: [], viewport: null })),
      );
    }
    return texts.get(n);
  }

  // how far into a run of text a character starts, as a share of the run: measured in the font the
  // text layer uses for it, as pdf.js stretches that to the run's width too
  let measurer = null;
  function shareAt(item, i) {
    if (i <= 0) return 0;
    if (i >= item.str.length) return 1;
    measurer ??= document.createElement('canvas').getContext('2d');
    measurer.font = `100px ${item.font}`;
    const whole = measurer.measureText(item.str).width;
    return whole > 0 ? measurer.measureText(item.str.slice(0, i)).width / whole : i / item.str.length;
  }

  /** Boxes [page, x, y, w, h] (fractions of the page) over characters [s, e) of a page's text. */
  function boxesOf(n, { items, viewport }, s, e) {
    const boxes = [];
    if (!viewport) return boxes;
    for (const item of items) {
      if (item.end <= s || item.start >= e || !item.str.length) continue;
      const [a, b, c, d, x, y] = item.transform;
      const along = Math.hypot(a, b) || 1;
      const up = Math.hypot(c, d) || 1;
      const [ux, uy] = [a / along, b / along];
      const [vx, vy] = [c / up, d / up];
      const size = item.height || up;
      const w = item.width || size * item.str.length * 0.5;
      const i0 = shareAt(item, Math.max(s, item.start) - item.start);
      const i1 = shareAt(item, Math.min(e, item.end) - item.start);
      const xs = [];
      const ys = [];
      for (const t of [i0, i1]) {
        for (const k of [-0.25, 0.95]) {
          const [px, py] = viewport.convertToViewportPoint(x + ux * w * t + vx * size * k, y + uy * w * t + vy * size * k);
          xs.push(px);
          ys.push(py);
        }
      }
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      boxes.push([n, left / viewport.width, top / viewport.height, (Math.max(...xs) - left) / viewport.width, (Math.max(...ys) - top) / viewport.height]);
    }
    return mergeRects(boxes);
  }

  let findRun = 0; // a new search stops the one before
  let foundBoxes = []; // match → its boxes (elements)
  let foundAt = []; // match → [page, x, y, w, h] of its first box
  let foundNow = -1;
  const findLayers = new Map(); // page number → its layer of boxes
  function clearFind() {
    findRun++;
    for (const layer of findLayers.values()) layer.remove();
    findLayers.clear();
    foundBoxes = [];
    foundAt = [];
    foundNow = -1;
  }
  function paintHit(rects) {
    const elements = [];
    for (const [n, x, y, w, h] of rects) {
      let layer = findLayers.get(n);
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'pdf-finds';
        pages[n - 1].append(layer);
        findLayers.set(n, layer);
      }
      const box = document.createElement('div');
      box.className = 'pdf-found';
      Object.assign(box.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
      layer.append(box);
      elements.push(box);
    }
    foundBoxes.push(elements);
    foundAt.push(rects[0] ?? null);
  }
  /**
   * Every match of a query, page after page: [{ before, text, after, place (page number), page }].
   * onProgress({ done, total, hits }) tells how far it has got, with the matches so far; null when a
   * newer search took over.
   */
  async function find(query, onProgress) {
    clearFind();
    const run = findRun;
    const pattern = queryPattern(query);
    const hits = [];
    let anyText = false;
    let lastReport = performance.now();
    const AHEAD = 6;
    for (let n = 1; n <= pages.length && pattern; n++) {
      for (let k = n; k <= Math.min(pages.length, n + AHEAD); k++) pageText(k);
      const content = await pageText(n);
      if (run !== findRun) return null;
      if (content.folded.text.trim()) anyText = true;
      for (const [s, e] of findIn(content.folded, pattern, MAX_HITS - hits.length)) {
        const [before, match, after] = snippet(content.text, s, e);
        hits.push({ before, text: match, after, place: n, page: n });
        paintHit(boxesOf(n, content, s, e));
      }
      if (hits.length >= MAX_HITS) break;
      if (performance.now() - lastReport > 120) {
        onProgress?.({ done: n, total: pages.length, hits });
        // let the window breathe between portions
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (run !== findRun) return null;
        lastReport = performance.now();
      }
    }
    return { hits, noText: Boolean(pattern) && !anyText && hits.length === 0 };
  }
  function showFound(i) {
    const at = foundAt[i];
    if (!at) return false;
    foundBoxes[foundNow]?.forEach((box) => box.classList.remove('now'));
    foundNow = i;
    foundBoxes[i].forEach((box) => box.classList.add('now'));
    const index = at[0] - 1;
    if (pager) pager.go(index, { animate: false });
    else {
      const f = pages[index].getBoundingClientRect();
      const top = f.top + at[2] * f.height;
      const view = host.getBoundingClientRect();
      if (top < view.top + 40 || top + at[4] * f.height > view.bottom - 40) host.scrollTop += top - viewTop() - host.clientHeight / 3;
      const left = f.left + at[1] * f.width;
      if (left < view.left || left > view.right - 40) host.scrollLeft += left - view.left - host.clientWidth / 3;
    }
    report();
    return true;
  }

  let rezoom = 0;
  return {
    kind: 'pdf',
    toc,
    position: current,
    progress,
    get paged() {
      return Boolean(pager);
    },
    pages: () => (pager ? { index: pager.index, count: pages.length, first: pager.index === 0, last: pager.index >= pages.length - 1 } : null),
    pageCount: pages.length,
    setMode: (next) => setMode(next),
    setTurn(value) {
      currentTurn = value;
      pager?.setTurn(value);
    },
    relayout,
    next: () => (pager ? pager.next() : host.scrollBy({ top: host.clientHeight - 48, behavior: 'smooth' })),
    prev: () => (pager ? pager.prev() : host.scrollBy({ top: -(host.clientHeight - 48), behavior: 'smooth' })),
    /** Zoom, in the scrolling column; a page in page mode always fits the screen. */
    setScale(value) {
      wrap.style.setProperty('--pdf-zoom', String(value));
      if (pager) return;
      const pos = current();
      restore(pos);
      clearTimeout(rezoom);
      rezoom = setTimeout(() => near.forEach(draw), 180);
    },
    where(node) {
      const target = node?.nodeType === 1 ? node : node?.parentElement;
      return { page: Number(target?.closest('.pdf-page')?.dataset.page) || current().page };
    },
    anchorOf,
    setMarks(list = [], activeId = null) {
      marks = list;
      paintMarks(activeId);
    },
    markAt(x, y) {
      let found = null;
      for (const layer of markLayers.values()) {
        for (const box of layer.children) {
          const b = box.getBoundingClientRect();
          if (x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2) found = box.dataset.mark;
        }
      }
      return found;
    },
    goToMark,
    /** The reader is leaving: the place on screen is told now, even if the scrolling has not stopped. */
    keep() {
      clearTimeout(timer);
      timer = 0;
      report();
    },
    setTexts(list = [], activeId = null) {
      written = list;
      paintTexts(activeId);
    },
    pointAt,
    goToText,
    lineAt,
    /** Rewritten lines over the pages; `hidden` is the one being typed into. */
    setEdits(list = [], hidden = null) {
      edits = list;
      hiddenEdit = hidden;
      if (list.length) loadFaces().then(paintEdits);
      paintEdits();
    },
    find,
    showFound,
    clearFind,
    goTo(pos) {
      restore(pos);
      report();
    },
    describe: (pos) => ({ page: pos?.page ?? current().page, snippet: '' }),
    close() {
      clearFind();
      observer.disconnect();
      resized.disconnect();
      pager?.destroy();
      host.classList.remove('paged');
      host.removeEventListener('scroll', onScroll);
      clearTimeout(timer);
      clearTimeout(rezoom);
      clearTimeout(resizeTimer);
      [...drawn.keys()].forEach(release);
      closeDoc(doc);
      host.replaceChildren();
    },
  };
}

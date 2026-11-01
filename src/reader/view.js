// Shows a book (see model.js) either as one scrolling column or as pages turned left to right, and
// keeps track of where the reader is: the position is "block number + how far into it", so it
// survives a change of font size, window, or reading mode.
//
// Pages are CSS columns: the text is one column as tall as the frame, the rest overflow to the
// right, and the pager (pager.js) moves them past the frame one column at a time. Laying a whole
// long novel out in columns takes the browser minutes, so in page mode the book is cut into parts
// of a few dozen pages, at chapter starts where it can: only the part being read is laid out, the
// rest is display: none, and turning past its last page puts the next part in place.

import { CLASSES, safeHref, TAGS } from './model.js';
import { createPager } from './pager.js';
import { MARK_COLORS } from '../marks.js';
import { findIn, foldText, queryPattern, snippet } from './search.js';

const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, pre, figure, tr, dt, dd, hr';
// a part's size in characters of text (a picture counts as a paragraph): a new chapter may start a
// part once it holds SOFT, a part is closed at TARGET when it can be, and never grows past HARD
const PART = { soft: 15_000, target: 36_000, hard: 60_000 };
const PICTURE_WEIGHT = 600;

export function renderBook(host, book, { position, scale = 1, mode = 'scroll', turn = 'flip', onPosition, onLink } = {}) {
  const urls = new Map();
  const urlOf = (ref) => {
    if (!urls.has(ref)) {
      const res = book.resources.get(ref);
      urls.set(ref, res ? URL.createObjectURL(new Blob([res.bytes], { type: res.type ?? '' })) : null);
    }
    return urls.get(ref);
  };

  const build = (node) => {
    if (typeof node === 'string') return document.createTextNode(node);
    if (!TAGS.has(node.tag)) return document.createTextNode('');
    const { id, href, ref, alt, colspan, rowspan } = node.attrs;
    if (node.tag === 'img') {
      const src = ref ? urlOf(ref) : null;
      if (!src) return document.createTextNode(alt ? `[${alt}]` : '');
      const img = document.createElement('img');
      img.src = src;
      img.alt = alt ?? '';
      img.loading = 'lazy';
      img.decoding = 'async';
      return img;
    }
    const e = document.createElement(node.tag);
    if (id) e.id = `rd-${id}`;
    if (CLASSES.has(node.attrs.class)) e.className = `rd-${node.attrs.class}`;
    if (colspan) e.colSpan = Number(colspan);
    if (rowspan) e.rowSpan = Number(rowspan);
    if (node.tag === 'a') {
      const target = safeHref(href);
      if (target) {
        e.href = target.startsWith('#') ? '#' : target;
        e.dataset.target = target;
      }
    }
    for (const c of node.children) e.append(build(c));
    return e;
  };

  const page = document.createElement('article');
  page.className = 'reader-book';
  if (book.lang) page.lang = book.lang;
  const fragment = document.createDocumentFragment();
  for (const block of book.blocks) fragment.append(build(block));
  page.append(fragment);
  // the sheet is the page the reader looks at; in page mode the book moves behind it
  const sheet = document.createElement('div');
  sheet.className = 'rd-sheet';
  sheet.append(page);
  host.style.setProperty('--reader-scale', String(scale));
  host.replaceChildren(sheet);

  const blocks = [...page.querySelectorAll(BLOCKS)];
  const headings = [...page.querySelectorAll('h1, h2, h3, h4, h5, h6')];

  // ---------- parts, for page mode ----------

  // units: what a part is made of — every block-level child, sections opened up to their contents
  const units = [];
  const sections = [];
  (function collect(parent) {
    for (const child of parent.children) {
      if (child.tagName === 'SECTION') {
        sections.push(child);
        collect(child);
      } else units.push(child);
    }
  })(page);

  const parts = []; // { start (characters before it), size, first unit, last unit }
  const unitPart = new Array(units.length);
  let total = 0;
  for (const [i, unit] of units.entries()) {
    const size = unit.textContent.length + unit.querySelectorAll('img').length * PICTURE_WEIGHT + 40;
    const last = parts[parts.length - 1];
    const chapter = /^H[1-3]$/.test(unit.tagName);
    const afterHeading = /^H[1-6]$/.test(units[i - 1]?.tagName ?? '');
    if (!last || last.size >= PART.hard || (chapter && last.size >= PART.soft) || (last.size >= PART.target && !afterHeading)) {
      parts.push({ start: total, size: 0, first: i, last: i });
    }
    const part = parts[parts.length - 1];
    part.size += size;
    part.last = i;
    unitPart[i] = parts.length - 1;
    total += size;
  }
  if (!parts.length) parts.push({ start: 0, size: 1, first: 0, last: -1 });
  const unitIndex = new Map(units.map((unit, i) => [unit, i]));
  /** The part an element of the book is in. */
  function partOf(el) {
    for (let node = el; node && node !== page; node = node.parentElement) {
      const i = unitIndex.get(node);
      if (i !== undefined) return unitPart[i];
    }
    return 0;
  }
  // each part's blocks are one run of the block list: [lo, hi]
  const blockPart = blocks.map(partOf);
  const partBlocks = parts.map(() => ({ lo: -1, hi: -1 }));
  blockPart.forEach((p, i) => {
    if (partBlocks[p].lo < 0) partBlocks[p].lo = i;
    partBlocks[p].hi = i;
  });
  // a section stays shown while it holds something of the part on screen (nested ones widen their parents)
  const sectionIndex = new Map(sections.map((section, i) => [section, i]));
  const sectionParts = sections.map(() => ({ lo: Infinity, hi: -1 }));
  units.forEach((unit, i) => {
    for (let node = unit.parentElement; node && node !== page; node = node.parentElement) {
      const span = sectionParts[sectionIndex.get(node)];
      if (span) {
        span.lo = Math.min(span.lo, unitPart[i]);
        span.hi = Math.max(span.hi, unitPart[i]);
      }
    }
  });

  let shown = -1; // the part laid out in page mode; -1: the whole book (scroll mode)

  function showPart(p) {
    if (p === shown) return;
    units.forEach((unit, i) => unit.classList.toggle('rd-off', unitPart[i] !== p));
    sections.forEach((section, i) => section.classList.toggle('rd-off', !(sectionParts[i].lo <= p && p <= sectionParts[i].hi)));
    // its pictures load now, so the page count does not change under the reader later
    for (let i = parts[p].first; i <= parts[p].last; i++) units[i].querySelectorAll('img').forEach((img) => (img.loading = 'eager'));
    shown = p;
  }

  function showAll() {
    if (shown < 0) return;
    units.forEach((unit) => unit.classList.remove('rd-off'));
    sections.forEach((section) => section.classList.remove('rd-off'));
    shown = -1;
  }

  let pager = null;
  let currentTurn = turn;

  // ---------- where the reader is ----------

  /** The first block in [lo, hi] whose box reaches past `edge` (its bottom in a column, its right in pages). */
  function firstPast(edge, side, lo = 0, hi = blocks.length - 1) {
    let found = hi;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].getBoundingClientRect()[side] > edge) {
        found = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return found;
  }

  // in pages: which column a point on screen falls in
  function columns() {
    const style = getComputedStyle(page);
    const pad = parseFloat(style.paddingLeft) || 0;
    return { pad, step: page.clientWidth - 2 * pad + (parseFloat(style.columnGap) || 0) };
  }
  function pageAt(x) {
    const { pad, step } = columns();
    return Math.max(0, Math.floor((x - page.getBoundingClientRect().left - pad + 2) / step));
  }
  const startOf = (el) => (el.getClientRects()[0] ?? el.getBoundingClientRect()).left;

  function layoutPages() {
    const { step } = columns();
    const last = blocks[partBlocks[shown]?.hi];
    const rects = last?.getClientRects();
    return { step, count: rects?.length ? pageAt(rects[rects.length - 1].left) + 1 : 1 };
  }

  function current() {
    if (!blocks.length) return { at: 0, frac: 0 };
    if (pager) {
      // the first block reaching into this page; one carried over from the page before gives way to
      // the next if that starts here, else the page is told by how far it is into the long block
      const { lo, hi } = partBlocks[shown];
      if (lo < 0) return { at: 0, frac: 0 };
      const at = firstPast(sheet.getBoundingClientRect().left + 1, 'right', lo, hi);
      const here = pager.index;
      const from = pageAt(startOf(blocks[at]));
      if (from < here && at < hi && pageAt(startOf(blocks[at + 1])) === here) return { at: at + 1, frac: 0 };
      return { at, frac: 0, skip: Math.max(0, here - from) };
    }
    const top = host.getBoundingClientRect().top;
    const at = firstPast(top + 1, 'bottom');
    const r = blocks[at].getBoundingClientRect();
    return { at, frac: r.height ? Math.round(Math.max(0, Math.min(1, (top - r.top) / r.height)) * 1000) / 1000 : 0 };
  }

  let restoring = false;
  let settling = true; // see settle() below

  /** In page mode: the page that holds `el` (or `skip` pages after its start), its part put in place first. */
  function goToElement(el, { skip = 0, animate = false } = {}) {
    const p = partOf(el);
    if (p !== shown) {
      showPart(p);
      pager.relayout();
    }
    pager.go(pageAt(startOf(el)) + skip, { animate });
  }

  function restore(pos) {
    const block = blocks[pos?.at];
    if (pager) {
      restoring = true;
      if (block) goToElement(block, { skip: pos.skip || 0 });
      else pager.go(0, { animate: false });
      restoring = false;
      return;
    }
    if (!block) return;
    const r = block.getBoundingClientRect();
    host.scrollTop += r.top - host.getBoundingClientRect().top + (pos.frac || 0) * r.height;
  }

  const progress = () => {
    if (pager) {
      const part = parts[shown];
      if (shown === parts.length - 1 && pager.index >= pager.count - 1) return 1;
      return Math.min(1, (part.start + (pager.index / Math.max(1, pager.count)) * part.size) / total);
    }
    const room = host.scrollHeight - host.clientHeight;
    return room > 0 ? Math.min(1, host.scrollTop / room) : 1;
  };

  // Page numbers for the whole book. Only the part on screen is laid out, so the rest is counted from
  // its text: characters per page are measured on the first part read, and every part learns the
  // number of its first page — from the part before when the reader turns into it (so the numbers
  // run on without a gap), else from that measure. Any new layout (size, font, window) starts over.
  let perPage = 0;
  const firstPage = new Map(); // part → number of its first page
  function learn() {
    if (pager && !perPage && pager.count >= 3) perPage = parts[shown].size / pager.count;
  }
  function forget() {
    perPage = 0;
    firstPage.clear();
  }
  function pages() {
    if (!pager) return null;
    const first = shown === 0 && pager.index === 0;
    const last = shown === parts.length - 1 && pager.index >= pager.count - 1;
    if (parts.length === 1) return { index: pager.index, count: pager.count, first, last };
    const per = perPage || parts[shown].size / Math.max(1, pager.count);
    if (!firstPage.has(shown)) {
      const fromNext = firstPage.has(shown + 1) ? firstPage.get(shown + 1) - pager.count : null;
      firstPage.set(shown, Math.max(0, fromNext ?? Math.round(parts[shown].start / per)));
    }
    const index = firstPage.get(shown) + pager.index;
    const rest = parts.slice(shown + 1).reduce((n, part) => n + part.size, 0);
    return { index, count: last ? index + 1 : Math.max(index + 2, index + (pager.count - pager.index) + Math.round(rest / per)), first, last };
  }

  function jump(id) {
    const target = page.querySelector(`#${CSS.escape(`rd-${id}`)}`);
    if (!target) return;
    if (pager) goToElement(target, { animate: true });
    else host.scrollTop += target.getBoundingClientRect().top - host.getBoundingClientRect().top - 12;
  }

  // ---------- marks: block number + character offsets, drawn with the CSS Custom Highlight API ----------
  // Nothing is added to the text: the highlights are painted over it, so pages and positions stay as they were.

  const blockIndex = new Map(blocks.map((b, i) => [b, i]));
  /** The innermost block a node is in, or -1. */
  function blockOf(node) {
    for (let e = node?.nodeType === 1 ? node : node?.parentElement; e && e !== page; e = e.parentElement) {
      const i = blockIndex.get(e);
      if (i !== undefined) return i;
    }
    return -1;
  }
  function offsetIn(block, container, offset) {
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(container, offset);
    return r.toString().length;
  }
  /** The text node and offset `offset` characters into a block. */
  function pointAt(block, offset) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let left = offset;
    let last = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (left <= n.data.length) return [n, left];
      left -= n.data.length;
      last = n;
    }
    return last ? [last, last.data.length] : [block, block.childNodes.length];
  }
  function anchorOf(range) {
    if (!range || range.collapsed || !page.contains(range.commonAncestorContainer)) return null;
    let a = blockOf(range.startContainer);
    let ao = a >= 0 ? offsetIn(blocks[a], range.startContainer, range.startOffset) : 0;
    let b = blockOf(range.endContainer);
    let bo = b >= 0 ? offsetIn(blocks[b], range.endContainer, range.endOffset) : 0;
    // an end on the edge of a block (a triple click, a selection to the end of a chapter): the nearest whole block
    if (a < 0) a = blocks.findIndex((bl) => range.intersectsNode(bl));
    if (b < 0) {
      b = blocks.findLastIndex((bl) => range.intersectsNode(bl));
      if (b >= 0) bo = blocks[b].textContent.length;
    }
    if (a < 0 || b < 0 || b < a || (a === b && bo <= ao)) return null;
    return { a, ao, b, bo };
  }
  function rangeOf(anchor) {
    const start = blocks[anchor?.a];
    const end = blocks[anchor?.b];
    if (!start || !end) return null;
    const r = document.createRange();
    try {
      r.setStart(...pointAt(start, anchor.ao));
      r.setEnd(...pointAt(end, anchor.bo));
    } catch {
      return null;
    }
    return r.collapsed ? null : r;
  }

  let marks = [];
  const markRanges = new Map(); // mark id → Range
  const HIGHLIGHTS = [...MARK_COLORS, 'noted', 'active'].map((c) => `atlas-mark-${c}`);
  function paintMarks(activeId = null) {
    if (!window.CSS?.highlights || typeof Highlight !== 'function') return;
    const groups = new Map();
    const add = (name, r) => (groups.get(name) ?? groups.set(name, []).get(name)).push(r);
    for (const m of marks) {
      const r = markRanges.get(m.id);
      if (!r) continue;
      add(`atlas-mark-${m.color}`, r);
      if (m.note) add('atlas-mark-noted', r);
      if (m.id === activeId) add('atlas-mark-active', r);
    }
    for (const name of HIGHLIGHTS) {
      if (groups.has(name)) CSS.highlights.set(name, new Highlight(...groups.get(name)));
      else CSS.highlights.delete(name);
    }
  }
  const hits = (r, x, y) => [...r.getClientRects()].some((b) => b.width > 0 && x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2);

  let focusMark = null; // a mark asked for while the book is still settling: settle() shows it, not the old place

  /** Shows a mark: its page in page mode, the passage a third down the screen when scrolling. */
  function goToMark(id) {
    if (settling) focusMark = id;
    return showMark(id);
  }
  function showMark(id) {
    const m = marks.find((x) => x.id === id);
    const r = markRanges.get(id);
    if (!m || !r) return false;
    if (pager) {
      const p = partOf(blocks[m.anchor.a]);
      if (p !== shown) {
        showPart(p);
        pager.relayout();
      }
      const box = r.getClientRects()[0] ?? r.getBoundingClientRect();
      pager.go(pageAt(box.left + 1), { animate: !settling });
    } else {
      const box = r.getBoundingClientRect();
      host.scrollTop += box.top - host.getBoundingClientRect().top - host.clientHeight / 3;
    }
    return true;
  }

  // ---------- finding words: the whole text at once, matches painted as highlights like the marks ----------

  let textIndex = null; // { text, folded, segments: [{ node, start, block, heading }] }, made at the first search
  function indexText() {
    if (textIndex) return textIndex;
    let text = '';
    const segments = [];
    let heading = '';
    let lastBlock = -2;
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.data) continue;
      const block = blockOf(node);
      if (block !== lastBlock) {
        // blocks apart: a phrase may run on from one to the next, but words do not join
        if (text) text += '\n\n';
        lastBlock = block;
        const h = /^H[1-6]$/.test(blocks[block]?.tagName) ? blocks[block] : null;
        if (h) heading = h.textContent.replace(/\s+/g, ' ').trim();
      }
      segments.push({ node, start: text.length, block, heading });
      text += node.data;
    }
    textIndex = { text, folded: foldText(text), segments };
    return textIndex;
  }
  /** The segment an offset of the text falls in. */
  function segmentAt(offset) {
    const { segments } = textIndex;
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].start <= offset) lo = mid;
      else hi = mid - 1;
    }
    return segments[lo];
  }

  let found = []; // Range per match
  let foundNow = -1;
  function paintFound() {
    if (!window.CSS?.highlights || typeof Highlight !== 'function') return;
    if (found.length) CSS.highlights.set('atlas-find', new Highlight(...found));
    else CSS.highlights.delete('atlas-find');
    const now = found[foundNow];
    if (now) {
      const h = new Highlight(now);
      h.priority = 1;
      CSS.highlights.set('atlas-find-now', h);
    } else CSS.highlights.delete('atlas-find-now');
  }
  function clearFind() {
    found = [];
    foundNow = -1;
    paintFound();
  }
  /** Every match of a query: [{ before, text, after, place (block number), heading }]; { noText } when there are no words to look in. */
  async function find(query) {
    // the first search reads the whole book: let "searching" show first
    if (!textIndex) await new Promise((resolve) => setTimeout(resolve, 0));
    const { text, folded } = indexText();
    clearFind();
    if (!folded.text.trim()) return { hits: [], noText: true };
    const hits = [];
    for (const [s, e] of findIn(folded, queryPattern(query))) {
      const a = segmentAt(s);
      const b = segmentAt(e - 1);
      const r = document.createRange();
      try {
        r.setStart(a.node, s - a.start);
        r.setEnd(b.node, Math.min(b.node.data.length, e - b.start));
      } catch {
        continue;
      }
      found.push(r);
      const [before, match, after] = snippet(text, s, e);
      hits.push({ before, text: match, after, place: a.block, heading: a.heading });
    }
    paintFound();
    return { hits };
  }
  /** Shows match `i` (its page, or the passage a third down the screen) and marks it as the current one. */
  function showFound(i) {
    const r = found[i];
    if (!r) return false;
    foundNow = i;
    paintFound();
    settling = false;
    if (pager) {
      const p = partOf(r.startContainer.parentElement);
      if (p !== shown) {
        showPart(p);
        pager.relayout();
      }
      const box = r.getClientRects()[0] ?? r.getBoundingClientRect();
      pager.go(pageAt(box.left + 1), { animate: false });
    } else {
      const box = r.getBoundingClientRect();
      const view = host.getBoundingClientRect();
      if (box.top < view.top + 40 || box.bottom > view.bottom - 40) host.scrollTop += box.top - view.top - host.clientHeight / 3;
    }
    report();
    return true;
  }

  const report = () => onPosition?.(current(), progress());

  function setMode(next, pos = current()) {
    if ((next === 'pages') === Boolean(pager)) return;
    if (next === 'pages') {
      host.classList.add('paged');
      host.scrollTop = 0;
      forget();
      showPart(blocks[pos?.at] ? blockPart[pos.at] : 0);
      pager = createPager({
        host,
        strip: page,
        frameFor: () => sheet,
        layout: layoutPages,
        onTurn: () => {
          // a page turned by the reader (not by restore()) ends the settling below: the place is theirs now
          if (!restoring) settling = false;
          learn();
          report();
        },
        canCross: (dir) => shown + dir >= 0 && shown + dir < parts.length,
        cross(dir) {
          // turning on into the next part: its pages are numbered on from this one's
          if (dir > 0 && !firstPage.has(shown + 1)) {
            pages();
            firstPage.set(shown + 1, firstPage.get(shown) + pager.count);
          }
          showPart(shown + dir);
        },
      });
      pager.setTurn(currentTurn);
      learn();
    } else {
      pager.destroy();
      pager = null;
      host.classList.remove('paged');
      showAll();
    }
    restore(pos);
    report();
  }

  /** After anything that moves the text (size, font, spacing, window): the same place again. */
  function relayout() {
    const pos = current();
    forget();
    pager?.relayout();
    restore(pos);
    learn();
  }

  page.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-target]');
    if (!link) return;
    e.preventDefault();
    const target = link.dataset.target;
    if (target.startsWith('#')) jump(target.slice(1));
    else onLink?.(target);
  });

  if (mode === 'pages') setMode('pages', position);
  else restore(position);

  // fonts and pictures settle a moment after the first layout: until the reader moves, keep the place
  const settle = () => {
    if (!settling) return;
    if (pager) {
      forget();
      pager.relayout();
    }
    if (!(focusMark && showMark(focusMark))) restore(position);
    learn();
  };
  requestAnimationFrame(settle);
  document.fonts?.ready.then(settle);
  setTimeout(() => {
    settle();
    settling = false;
  }, 900);
  const stopSettling = () => (settling = false);
  host.addEventListener('pointerdown', stopSettling, { once: true });
  host.addEventListener('wheel', stopSettling, { once: true, passive: true });
  host.addEventListener('keydown', stopSettling, { once: true });

  // a picture arriving in the part on screen moves the text: lay the part out again, same place
  let pictureTimer = 0;
  page.addEventListener(
    'load',
    (e) => {
      if (e.target.tagName !== 'IMG' || (!settling && !pager)) return;
      clearTimeout(pictureTimer);
      pictureTimer = setTimeout(settling ? settle : relayout, 120);
    },
    true,
  );

  let timer = 0;
  const onScroll = () => {
    if (pager) return;
    clearTimeout(timer);
    timer = setTimeout(report, 300);
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

  return {
    kind: 'book',
    toc: book.toc.map((entry) => ({ level: entry.level, text: entry.text, go: () => jump(entry.id) })),
    position: current,
    progress,
    get paged() {
      return Boolean(pager);
    },
    /** { index, count, first, last } of the pages, in page mode (across parts, counted from their text). */
    pages,
    setMode: (next) => setMode(next),
    setTurn(value) {
      currentTurn = value;
      pager?.setTurn(value);
    },
    relayout,
    next: () => (pager ? pager.next() : host.scrollBy({ top: host.clientHeight - 48, behavior: 'smooth' })),
    prev: () => (pager ? pager.prev() : host.scrollBy({ top: -(host.clientHeight - 48), behavior: 'smooth' })),
    setScale(value) {
      const pos = current();
      host.style.setProperty('--reader-scale', String(value));
      forget();
      pager?.relayout();
      restore(pos);
      learn();
    },
    /** Where a piece of the text is: the nearest heading above it. */
    where(node) {
      const target = node?.nodeType === 1 ? node : node?.parentElement;
      let found = null;
      for (const heading of headings) {
        if (heading === target || heading.contains(target) || heading.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) found = heading;
        else break;
      }
      return { heading: found?.textContent.replace(/\s+/g, ' ').trim() ?? '' };
    },
    /** A selection as a place in the book, or null. */
    anchorOf,
    setMarks(list = [], activeId = null) {
      marks = list;
      markRanges.clear();
      for (const m of list) {
        const r = m.anchor && !m.anchor.rects ? rangeOf(m.anchor) : null;
        if (r) markRanges.set(m.id, r);
      }
      paintMarks(activeId);
    },
    /** The mark under a point on screen (the newest, where they overlap), or null. */
    markAt(x, y) {
      for (let i = marks.length - 1; i >= 0; i--) {
        const r = markRanges.get(marks[i].id);
        if (r && hits(r, x, y)) return marks[i].id;
      }
      return null;
    },
    goToMark,
    find,
    showFound,
    clearFind,
    /** Back to a place kept earlier (a bookmark). */
    goTo(pos) {
      if (settling) {
        position = pos;
        focusMark = null;
      }
      restore(pos);
      report();
    },
    /** What a bookmark at `pos` is called: the chapter, and the words it starts with. */
    describe(pos) {
      const block = blocks[pos?.at];
      if (!block) return { heading: '', snippet: '' };
      return { ...this.where(block), snippet: block.textContent.replace(/\s+/g, ' ').trim().slice(0, 160) };
    },
    close() {
      for (const name of [...HIGHLIGHTS, 'atlas-find', 'atlas-find-now']) window.CSS?.highlights?.delete(name);
      resized.disconnect();
      pager?.destroy();
      host.classList.remove('paged');
      host.removeEventListener('scroll', onScroll);
      clearTimeout(timer);
      clearTimeout(resizeTimer);
      clearTimeout(pictureTimer);
      for (const url of urls.values()) if (url) URL.revokeObjectURL(url);
      host.replaceChildren();
    },
  };
}

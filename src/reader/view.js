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
    restore(position);
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
    close() {
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

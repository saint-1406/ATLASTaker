// Shows a book (see model.js) either as one scrolling column or as pages turned left to right, and
// keeps track of where the reader is: the position is "block number + how far into it", so it
// survives a change of font size, window, or reading mode.
//
// Pages are CSS columns: the book is one column as tall as the frame, the rest overflow to the right,
// and the pager (pager.js) moves them past the frame one column at a time.

import { CLASSES, safeHref, TAGS } from './model.js';
import { createPager } from './pager.js';

const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, pre, figure, tr, dt, dd, hr';

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
  let pager = null;
  let currentTurn = turn;

  // ---------- where the reader is ----------

  /** The first block whose box reaches past `edge` (its bottom in a column, its right in pages). */
  function firstPast(edge, side) {
    let lo = 0;
    let hi = blocks.length - 1;
    let found = blocks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].getBoundingClientRect()[side] > edge) {
        found = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return found;
  }

  function current() {
    if (!blocks.length) return { at: 0, frac: 0 };
    if (pager) {
      // the first block reaching into this page; one carried over from the page before gives way to
      // the next if that starts here, else the page is told by how far it is into the long block
      const at = firstPast(sheet.getBoundingClientRect().left + 1, 'right');
      const here = pager.index;
      const from = pageAt(startOf(blocks[at]));
      if (from < here && blocks[at + 1] && pageAt(startOf(blocks[at + 1])) === here) return { at: at + 1, frac: 0 };
      return { at, frac: 0, skip: Math.max(0, here - from) };
    }
    const top = host.getBoundingClientRect().top;
    const at = firstPast(top + 1, 'bottom');
    const r = blocks[at].getBoundingClientRect();
    return { at, frac: r.height ? Math.round(Math.max(0, Math.min(1, (top - r.top) / r.height)) * 1000) / 1000 : 0 };
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
    const last = blocks[blocks.length - 1];
    const rects = last?.getClientRects();
    return { step, count: rects?.length ? pageAt(rects[rects.length - 1].left) + 1 : 1 };
  }

  let restoring = false;
  let settling = true; // see settle() below
  function restore(pos) {
    const block = blocks[pos?.at];
    if (pager) {
      restoring = true;
      pager.go(block ? pageAt(startOf(block)) + (pos.skip || 0) : 0, { animate: false });
      restoring = false;
      return;
    }
    if (!block) return;
    const r = block.getBoundingClientRect();
    host.scrollTop += r.top - host.getBoundingClientRect().top + (pos.frac || 0) * r.height;
  }

  const progress = () => {
    if (pager) return pager.count > 1 ? pager.index / (pager.count - 1) : 1;
    const room = host.scrollHeight - host.clientHeight;
    return room > 0 ? Math.min(1, host.scrollTop / room) : 1;
  };

  function jump(id) {
    const target = page.querySelector(`#${CSS.escape(`rd-${id}`)}`);
    if (!target) return;
    if (pager) pager.go(pageAt(startOf(target)));
    else host.scrollTop += target.getBoundingClientRect().top - host.getBoundingClientRect().top - 12;
  }

  const report = () => onPosition?.(current(), progress());
  // a page turned by the reader (not by restore()) ends the settling below: the place is theirs now
  const turned = () => {
    if (!restoring) settling = false;
    report();
  };

  function setMode(next) {
    if ((next === 'pages') === Boolean(pager)) return;
    const pos = current();
    if (next === 'pages') {
      host.classList.add('paged');
      host.scrollTop = 0;
      pager = createPager({ host, strip: page, frameFor: () => sheet, layout: layoutPages, onTurn: turned });
      pager.setTurn(currentTurn);
    } else {
      pager.destroy();
      pager = null;
      host.classList.remove('paged');
    }
    restore(pos);
    report();
  }

  /** After anything that moves the text (size, font, spacing, window): the same place again. */
  function relayout() {
    const pos = current();
    pager?.relayout();
    restore(pos);
  }

  page.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-target]');
    if (!link) return;
    e.preventDefault();
    const target = link.dataset.target;
    if (target.startsWith('#')) jump(target.slice(1));
    else onLink?.(target);
  });

  if (mode === 'pages') setMode('pages');

  // fonts and pictures settle a moment after the first layout: until the reader moves, keep the place
  const settle = () => {
    if (!settling) return;
    pager?.relayout();
    restore(position);
  };
  restore(position);
  requestAnimationFrame(settle);
  document.fonts?.ready.then(settle);
  page.querySelectorAll('img').forEach((img) => img.addEventListener('load', settle, { once: true }));
  setTimeout(() => {
    settle();
    settling = false;
  }, 900);
  const stopSettling = () => (settling = false);
  host.addEventListener('pointerdown', stopSettling, { once: true });
  host.addEventListener('wheel', stopSettling, { once: true, passive: true });
  host.addEventListener('keydown', stopSettling, { once: true });

  let timer = 0;
  const onScroll = () => {
    if (pager) return;
    clearTimeout(timer);
    timer = setTimeout(report, 300);
  };
  host.addEventListener('scroll', onScroll, { passive: true });

  let resizeTimer = 0;
  let lastSize = '';
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
    /** { index, count } of the pages, in page mode. */
    pages: () => (pager ? { index: pager.index, count: pager.count } : null),
    setMode,
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
      pager?.relayout();
      restore(pos);
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
      for (const url of urls.values()) if (url) URL.revokeObjectURL(url);
      host.replaceChildren();
    },
  };
}

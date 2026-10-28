// Shows a book (see model.js) as one scrolling column and keeps track of where the reader is: the
// position is "block number + how far into it", so it survives a change of font size or window.

import { CLASSES, safeHref, TAGS } from './model.js';

const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, pre, figure, tr, dt, dd, hr';

export function renderBook(host, book, { position, scale = 1, onPosition, onLink } = {}) {
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
  host.style.setProperty('--reader-scale', String(scale));
  host.replaceChildren(page);

  const blocks = [...page.querySelectorAll(BLOCKS)];
  const headings = [...page.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  const viewTop = () => host.getBoundingClientRect().top;

  /** The first block not yet scrolled past. */
  function firstVisible() {
    const top = viewTop() + 1;
    let lo = 0;
    let hi = blocks.length - 1;
    let found = blocks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].getBoundingClientRect().bottom > top) {
        found = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return found;
  }

  function current() {
    if (!blocks.length) return { at: 0, frac: 0 };
    const at = firstVisible();
    const r = blocks[at].getBoundingClientRect();
    return { at, frac: r.height ? Math.round(Math.max(0, Math.min(1, (viewTop() - r.top) / r.height)) * 1000) / 1000 : 0 };
  }

  function restore(pos) {
    const block = blocks[pos?.at];
    if (!block) return;
    const r = block.getBoundingClientRect();
    host.scrollTop += r.top - viewTop() + (pos.frac || 0) * r.height;
  }

  const progress = () => {
    const room = host.scrollHeight - host.clientHeight;
    return room > 0 ? Math.min(1, host.scrollTop / room) : 1;
  };

  function jump(id) {
    const target = page.querySelector(`#${CSS.escape(`rd-${id}`)}`);
    if (target) host.scrollTop += target.getBoundingClientRect().top - viewTop() - 12;
  }

  page.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-target]');
    if (!link) return;
    e.preventDefault();
    const target = link.dataset.target;
    if (target.startsWith('#')) jump(target.slice(1));
    else onLink?.(target);
  });

  // fonts and pictures settle a moment after the first layout: until the reader moves, keep the place
  let settling = true;
  const settle = () => settling && restore(position);
  restore(position);
  requestAnimationFrame(settle);
  document.fonts?.ready.then(settle);
  setTimeout(() => {
    settle();
    settling = false;
  }, 700);

  let timer = 0;
  const onScroll = () => {
    clearTimeout(timer);
    timer = setTimeout(() => onPosition?.(current(), progress()), 300);
  };
  host.addEventListener('scroll', onScroll, { passive: true });
  host.addEventListener('pointerdown', () => (settling = false), { once: true });
  host.addEventListener('wheel', () => (settling = false), { once: true, passive: true });

  return {
    kind: 'book',
    toc: book.toc.map((entry) => ({ level: entry.level, text: entry.text, go: () => jump(entry.id) })),
    position: current,
    progress,
    setScale(value) {
      const pos = current();
      host.style.setProperty('--reader-scale', String(value));
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
      host.removeEventListener('scroll', onScroll);
      clearTimeout(timer);
      for (const url of urls.values()) if (url) URL.revokeObjectURL(url);
      host.replaceChildren();
    },
  };
}

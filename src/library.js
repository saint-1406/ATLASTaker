// The library: documents to read next to the notes — PDF, EPUB, FB2, DOCX, Markdown, text, HTML.
// The shelf lists them as cards (cover, title, how far read); the reader opens one over the app,
// remembers the place and sends a selected passage, as a quote, to the document's own note.
// The reader's code (dist/reader.js, with pdf.js) is loaded the first time it is needed.

import { h, toast, confirmDialog, showMenu, isOverlayOpen } from './overlays.js';
import { count, t } from './i18n.js';

const ACCEPT = '.pdf,.epub,.fb2,.zip,.docx,.doc,.md,.markdown,.txt,.text,.html,.htm,.xhtml,.rtf,.odt';
const MAX_SIZE = 300 * 1024 * 1024;
const BOOK_SCALE = { min: 0.7, max: 2.2, step: 0.1 };
const PDF_SCALE = { min: 0.5, max: 4, step: 0.25 };

let readerCode = null;

/** window.AtlasReader: already there in the single-file build, else dist/reader.js next to the page. */
function loadReader() {
  if (window.AtlasReader) return Promise.resolve(window.AtlasReader);
  readerCode ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'dist/reader.js';
    script.onload = () => (window.AtlasReader ? resolve(window.AtlasReader) : reject(new Error(t('library.loadFailed'))));
    script.onerror = () => {
      readerCode = null;
      script.remove();
      reject(new Error(t('library.loadFailed')));
    };
    document.head.append(script);
  });
  return readerCode;
}

/**
 * api: the bridge (api.library holds the documents). onQuote(doc, text, where) → { id, title } of
 * the note the quote went to; onOpenNote(id) shows a note; onLink(url) opens a web link; onClose()
 * runs when the shelf goes away.
 */
export function createLibrary({ api, phone = false, onQuote, onOpenNote, onLink, onClose }) {
  const lib = api.library;
  let docs = [];
  let reading = null; // { doc, controller, closed }
  let saveTimer = 0;
  let pendingSave = null;

  // ---------- the shelf ----------

  const grid = h('ol', { class: 'lib-grid' });
  const emptyNote = h('p', { class: 'lib-empty', hidden: true });
  const filter = h('input', { class: 'field lib-filter', type: 'search', spellcheck: 'false' });
  const heading = h('span', { class: 'lib-heading-text' });
  const counter = h('span', { class: 'lib-count' });
  const shelfBack = h('button', { type: 'button', class: 'tb-btn icon lib-back', onclick: () => close() }, '←');
  const addLabel = h('span', { class: 'lib-add-text' });
  const addButton = h('button', { type: 'button', class: 'tb-btn accent lib-add', onclick: pickFiles }, h('span', { 'aria-hidden': 'true' }, '＋'), addLabel);
  const dropHint = h('div', { class: 'lib-drop', 'aria-hidden': 'true' });
  const shelf = h(
    'section',
    { class: 'library', hidden: true },
    h('header', { class: 'lib-head' }, shelfBack, h('h2', { class: 'lib-heading' }, heading, counter), filter, addButton),
    h('div', { class: 'lib-body' }, grid, emptyNote),
    dropHint,
  );

  // ---------- the reader ----------

  const scroll = h('div', { class: 'rd-scroll', tabindex: '-1' });
  const title = h('span', { class: 'rd-title' });
  const subtitle = h('span', { class: 'rd-sub' });
  const percent = h('span', { class: 'rd-pct' });
  const readerBack = h('button', { type: 'button', class: 'tb-btn icon', onclick: () => closeReader() }, '←');
  const smaller = h('button', { type: 'button', class: 'tb-btn icon rd-size', onclick: () => zoom(-1) }, 'A−');
  const larger = h('button', { type: 'button', class: 'tb-btn icon rd-size', onclick: () => zoom(1) }, 'A+');
  const tocButton = h('button', { type: 'button', class: 'tb-btn icon', onclick: () => toggleToc() }, '☰');
  const status = h('div', { class: 'rd-status', role: 'status' });
  const line = h('div', { class: 'rd-line', 'aria-hidden': 'true' }, h('i'));
  const quoteText = h('span');
  const quoteButton = h('button', { type: 'button', class: 'rd-quote', hidden: true, onclick: quote }, h('span', { 'aria-hidden': 'true' }, '❝'), quoteText);
  const tocHead = h('div', { class: 'rd-toc-head' });
  const tocList = h('ol', { class: 'rd-toc-list' });
  const tocPanel = h('aside', { class: 'rd-toc', hidden: true }, tocHead, tocList);
  const reader = h(
    'section',
    { class: 'reader', hidden: true },
    h('header', { class: 'rd-head' }, readerBack, h('div', { class: 'rd-titles' }, title, subtitle), percent, smaller, larger, tocButton),
    scroll,
    status,
    line,
    quoteButton,
    tocPanel,
  );

  document.body.append(shelf, reader);

  function localize() {
    heading.textContent = t('library.title');
    filter.placeholder = t('library.find');
    filter.setAttribute('aria-label', t('library.find'));
    addLabel.textContent = t('library.add');
    addButton.title = t('library.addTitle');
    for (const [button, key] of [
      [shelfBack, 'library.back'],
      [readerBack, 'reader.back'],
      [smaller, 'reader.smaller'],
      [larger, 'reader.larger'],
      [tocButton, 'reader.toc'],
    ]) {
      button.title = t(key);
      button.setAttribute('aria-label', t(key));
    }
    dropHint.textContent = t('library.drop');
    quoteText.textContent = t('reader.quote');
    quoteButton.title = t('reader.quoteTitle');
    tocHead.textContent = t('reader.toc');
  }

  const nameOf = (doc) => doc.title || doc.name;

  function card(doc) {
    const pct = Math.round((doc.progress || 0) * 100);
    const state = !doc.opened ? t('library.notOpened') : pct >= 99 ? t('library.finished') : t('library.progress', pct);
    const more = h('button', { type: 'button', class: 'lib-more', title: t('library.actions'), 'aria-label': t('library.actions') }, '⋯');
    const cover = doc.cover
      ? h('img', { class: 'lib-cover-img', src: doc.cover, alt: '' })
      : h('span', { class: 'lib-cover-blank' }, h('span', { class: 'lib-cover-title' }, nameOf(doc)));
    const bar = h('span', { class: 'lib-progress', 'aria-hidden': 'true' }, h('i'));
    bar.firstChild.style.transform = `scaleX(${Math.min(1, doc.progress || 0)})`;
    const li = h(
      'li',
      { class: 'lib-card', tabindex: '0', role: 'button', 'data-id': doc.id },
      h('span', { class: 'lib-cover' }, cover, h('span', { class: 'lib-format' }, doc.format.toUpperCase()), bar),
      h('span', { class: 'lib-card-title' }, nameOf(doc)),
      doc.author ? h('span', { class: 'lib-card-author' }, doc.author) : null,
      h('span', { class: 'lib-card-state' }, state),
      more,
    );
    const menu = (x, y) =>
      showMenu(x, y, [
        { icon: '↗', text: t('library.read'), run: () => read(doc.id) },
        '-',
        { icon: '✕', text: t('library.remove'), kbd: 'Del', className: 'danger', run: () => remove(doc.id) },
      ]);
    li.addEventListener('click', (e) => {
      if (!e.target.closest('.lib-more')) read(doc.id);
    });
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        read(doc.id);
      } else if (e.key === 'Delete') remove(doc.id);
    });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      menu(e.clientX, e.clientY);
    });
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      menu(r.left, r.bottom + 4);
    });
    return li;
  }

  function render() {
    const q = filter.value.trim().toLowerCase();
    const sorted = [...docs].sort((a, b) => (b.opened || b.added) - (a.opened || a.added));
    const shown = q ? sorted.filter((d) => `${d.title} ${d.author} ${d.name}`.toLowerCase().includes(q)) : sorted;
    grid.replaceChildren(...shown.map(card));
    counter.textContent = docs.length ? String(docs.length) : '';
    emptyNote.textContent = t(phone ? 'library.emptyPhone' : 'library.empty');
    emptyNote.hidden = docs.length > 0;
  }

  async function refresh() {
    try {
      docs = await lib.list();
    } catch (err) {
      toast(err.message);
    }
  }

  /** The notes stay under the library, out of reach of clicks, Tab and screen readers. */
  function cover(on) {
    shelf.hidden = !on;
    document.documentElement.classList.toggle('library-open', on);
    document.getElementById('app')?.toggleAttribute('inert', on);
  }

  async function open() {
    localize();
    cover(true);
    await refresh();
    render();
    (grid.querySelector('.lib-card') ?? addButton).focus({ preventScroll: true });
  }

  function close() {
    if (reading) closeReader();
    if (shelf.hidden) return;
    cover(false);
    onClose?.();
  }

  // ---------- adding and removing ----------

  function pickFiles() {
    const input = h('input', { type: 'file', multiple: true, accept: ACCEPT });
    input.addEventListener('change', () => addFiles([...input.files]));
    input.click();
  }

  /** Puts files on the shelf; with openSingle, a single file opens in the reader straight away. */
  async function addFiles(files, { openSingle = false } = {}) {
    if (!files.length) return [];
    let code;
    try {
      code = await loadReader();
    } catch (err) {
      toast(err.message);
      return [];
    }
    if (!docs.length) await refresh();
    const out = [];
    const problems = []; // shown together at the end, so one does not hide another
    let added = 0;
    for (const [i, file] of files.entries()) {
      if (files.length > 1) toast(t('library.adding', i + 1, files.length), { timeout: 60_000 });
      const same = docs.find((d) => d.name === file.name && d.size === file.size);
      if (same) {
        out.push(same);
        if (!openSingle) problems.push(t('library.already', nameOf(same)));
        continue;
      }
      if (file.size > MAX_SIZE) {
        problems.push(t('library.tooBig', file.name));
        continue;
      }
      try {
        const info = await code.inspect(file.name, new Uint8Array(await file.arrayBuffer()));
        let doc = await lib.add(file, { name: file.name, format: info.format });
        doc = await lib.update(doc.id, { title: info.title || '', author: info.author || '', cover: info.cover ?? null });
        docs.push(doc);
        out.push(doc);
        added++;
      } catch (err) {
        console.error(err);
        if (err.unsupported === 'doc') problems.push(t('library.oldWord', file.name));
        else if (err.unsupported) problems.push(t('library.unsupported', file.name, err.unsupported));
        else problems.push(t('library.failed', file.name, err.message));
      }
    }
    if (!shelf.hidden) render();
    const summary = [added && files.length > 1 ? t('library.added', count(added, 'doc')) : '', ...problems].filter(Boolean);
    if (summary.length) toast(summary.join(' · '), { timeout: problems.length ? 10_000 : 4200 });
    if (openSingle && files.length === 1 && out.length === 1) await read(out[0].id);
    return out;
  }

  async function remove(id) {
    const doc = docs.find((d) => d.id === id);
    if (!doc) return;
    const ok = await confirmDialog({
      kicker: t('library.title'),
      title: t('library.removeTitle', nameOf(doc)),
      text: t(api.kind === 'server' ? 'library.removeDisk' : 'library.removeHere'),
      ok: t('library.removeOk'),
      danger: true,
    });
    if (!ok) return;
    try {
      await lib.remove(id);
    } catch (err) {
      toast(err.message);
      return;
    }
    docs = docs.filter((d) => d.id !== id);
    render();
    toast(t('library.removed', nameOf(doc)));
  }

  // ---------- reading ----------

  function showProgress(value) {
    const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
    percent.textContent = t('library.progress', pct);
    line.firstChild.style.transform = `scaleX(${pct / 100})`;
  }

  /** The place is kept a moment after the scrolling stops, and right away when the reader closes. */
  function remember(session, position, progress) {
    if (session.closed) return;
    Object.assign(session.doc, { position, progress });
    showProgress(progress);
    pendingSave = { id: session.doc.id, patch: { position, progress, scale: session.doc.scale } };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 1500);
  }

  function flush() {
    clearTimeout(saveTimer);
    if (!pendingSave) return;
    const { id, patch } = pendingSave;
    pendingSave = null;
    lib.update(id, patch).catch((err) => console.error(err));
  }

  async function read(id) {
    if (!docs.some((d) => d.id === id)) await refresh();
    const doc = docs.find((d) => d.id === id);
    if (!doc) return;
    if (reading) closeReader();
    localize();
    if (shelf.hidden) {
      cover(true);
      render();
    }
    reader.hidden = false;
    tocPanel.hidden = true;
    quoteButton.hidden = true;
    title.textContent = nameOf(doc);
    subtitle.textContent = doc.author || '';
    showProgress(doc.progress || 0);
    status.textContent = t('reader.opening');
    status.hidden = false;
    scroll.replaceChildren();
    scroll.scrollTop = 0;
    const session = { doc, controller: null, closed: false };
    reading = session;
    try {
      const code = await loadReader();
      const bytes = await lib.bytes(doc.id);
      if (session.closed) return;
      const controller = await code.open(scroll, {
        name: doc.name,
        bytes,
        format: doc.format,
        position: doc.position,
        scale: doc.scale || 1,
        onPosition: (position, progress) => remember(session, position, progress),
        onLink,
      });
      if (session.closed) {
        controller.close();
        return;
      }
      session.controller = controller;
      status.hidden = true;
      showProgress(controller.progress());
      fillToc(controller.toc);
      scroll.focus({ preventScroll: true });
      doc.opened = Date.now();
      lib.update(doc.id, { opened: doc.opened }).catch(() => {});
    } catch (err) {
      console.error(err);
      if (!session.closed) status.textContent = t('reader.failed', err.message);
    }
  }

  function closeReader() {
    if (!reading) return;
    flush();
    reading.closed = true;
    reading.controller?.close();
    reading = null;
    reader.hidden = true;
    quoteButton.hidden = true;
    tocPanel.hidden = true;
    render();
    grid.querySelector('.lib-card')?.focus({ preventScroll: true });
  }

  function zoom(direction) {
    if (!reading?.controller) return;
    const range = reading.controller.kind === 'pdf' ? PDF_SCALE : BOOK_SCALE;
    const next = direction === 0 ? 1 : (reading.doc.scale || 1) + direction * range.step;
    reading.doc.scale = Math.round(Math.min(range.max, Math.max(range.min, next)) * 100) / 100;
    reading.controller.setScale(reading.doc.scale);
    remember(reading, reading.controller.position(), reading.controller.progress());
  }

  function fillToc(entries) {
    tocList.replaceChildren(
      ...(entries.length
        ? entries.map((entry) =>
            h(
              'li',
              { class: `rd-toc-item level-${Math.min(entry.level, 4)}` },
              h(
                'button',
                {
                  type: 'button',
                  onclick: () => {
                    tocPanel.hidden = true;
                    entry.go();
                    scroll.focus({ preventScroll: true });
                  },
                },
                entry.text || t('reader.pageN', entry.page),
              ),
            ),
          )
        : [h('li', { class: 'rd-toc-empty' }, t('reader.noToc'))]),
    );
  }

  function toggleToc(show = tocPanel.hidden) {
    tocPanel.hidden = !show;
    if (show) tocPanel.querySelector('button')?.focus({ preventScroll: true });
  }

  // a selection inside the document offers to become a quote
  document.addEventListener('selectionchange', () => {
    if (!reading?.controller) {
      quoteButton.hidden = true;
      return;
    }
    const sel = document.getSelection();
    quoteButton.hidden = !(sel && !sel.isCollapsed && scroll.contains(sel.anchorNode) && sel.toString().trim());
  });

  async function quote() {
    const sel = document.getSelection();
    if (!reading?.controller || !sel || sel.isCollapsed) return;
    const { doc, controller } = reading;
    const raw = sel.toString();
    // a PDF's lines are broken where the page broke them: one paragraph
    const text = (controller.kind === 'pdf' ? raw.replace(/\s+/g, ' ') : raw.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n')).trim().slice(0, 5000);
    if (!text) return;
    const where = controller.where(sel.anchorNode);
    quoteButton.disabled = true;
    try {
      const note = await onQuote(doc, text, where.page ? t('reader.page', where.page) : where.heading);
      if (note.id !== doc.notesId) {
        doc.notesId = note.id;
        lib.update(doc.id, { notesId: note.id }).catch(() => {});
      }
      sel.removeAllRanges();
      quoteButton.hidden = true;
      toast(t('reader.quoted', note.title), {
        timeout: 6000,
        action: {
          text: t('reader.openNote'),
          run: () => {
            close();
            onOpenNote(note.id);
          },
        },
      });
    } catch (err) {
      console.error(err);
      toast(t('reader.quoteFailed', err.message));
    } finally {
      quoteButton.disabled = false;
    }
  }

  // ---------- dropping files ----------

  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  shelf.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    shelf.classList.add('dropping');
  });
  shelf.addEventListener('dragleave', (e) => {
    if (!shelf.contains(e.relatedTarget)) shelf.classList.remove('dropping');
  });
  shelf.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    shelf.classList.remove('dropping');
    addFiles([...e.dataTransfer.files]);
  });
  filter.addEventListener('input', render);

  /** One step back: the contents list, then the reader, then the shelf. False when nothing was open. */
  function back() {
    if (!tocPanel.hidden) {
      tocPanel.hidden = true;
      return true;
    }
    if (reading) {
      closeReader();
      return true;
    }
    if (!shelf.hidden) {
      close();
      return true;
    }
    return false;
  }

  /** Keys while the library is open; the notes' own shortcuts wait until it closes. */
  function onKey(e) {
    if (isOverlayOpen()) return;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    let handled = true;
    if (e.key === 'Escape') {
      if (e.target === filter && filter.value) {
        filter.value = '';
        render();
      } else back();
    } else if (mod && e.code === 'KeyO') close();
    else if (reading && mod && (e.code === 'Equal' || e.code === 'NumpadAdd')) zoom(1);
    else if (reading && mod && (e.code === 'Minus' || e.code === 'NumpadSubtract')) zoom(-1);
    else if (reading && mod && (e.code === 'Digit0' || e.code === 'Numpad0')) zoom(0);
    else if (!reading && mod && e.code === 'KeyF') filter.focus();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  return {
    open,
    close,
    toggle: () => (shelf.hidden ? open() : close()),
    isOpen: () => !shelf.hidden,
    pickFiles: async () => {
      await open();
      pickFiles();
    },
    /** Files handed over by another app (Android "Open with" / "Share"). */
    receive: (files) => addFiles(files, { openSingle: true }),
    back,
    onKey,
    flush,
  };
}

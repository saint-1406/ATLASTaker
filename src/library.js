// The library: documents to read next to the notes — PDF, EPUB, FB2, DOCX, Markdown, text, HTML.
// The shelf lists them as cards (cover, title, how far read); the reader opens one over the app,
// remembers the place and sends a selected passage, as a quote, to the document's own note.
// The reader's code (dist/reader.js, with pdf.js) is loaded the first time it is needed.

import { h, toast, confirmDialog, showMenu, isOverlayOpen } from './overlays.js';
import { count, t } from './i18n.js';
import { LEADINGS, READ_FONTS, READ_MODES, THEMES, TURNS } from './skins.js';

const ACCEPT = '.pdf,.epub,.fb2,.zip,.docx,.doc,.md,.markdown,.txt,.text,.html,.htm,.xhtml,.rtf,.odt';
const MAX_SIZE = 300 * 1024 * 1024;
const BOOK_SCALE = { min: 0.7, max: 2.2, step: 0.1 };
// keys that turn a page in page mode: forward, back, or (space) forward unless Shift is held
const PAGE_KEYS = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1, ' ': 'shift-aware' };
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
 * api: the bridge (api.library holds the documents). getReading() / onReading(patch): how books are
 * shown (skins.js: readMode, readTurn, readFont, readLeading), kept by the app; getTheme() /
 * onTheme(theme): the app's theme, which the reader's view panel can change too. onQuote(doc, text,
 * where) → { id, title } of the note the quote went to; onOpenNote(id) shows a note; onLink(url)
 * opens a web link; onClose() runs when the shelf goes away.
 */
export function createLibrary({ api, phone = false, getReading, onReading, getTheme, onTheme, onQuote, onOpenNote, onLink, onClose }) {
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
  const viewButton = h('button', { type: 'button', class: 'tb-btn icon rd-size', onclick: () => toggleView() }, 'Aa');
  const tocButton = h('button', { type: 'button', class: 'tb-btn icon', onclick: () => toggleToc() }, '☰');
  const prevButton = h('button', { type: 'button', class: 'rd-nav rd-nav-prev', onclick: () => reading?.controller?.prev() }, '‹');
  const nextButton = h('button', { type: 'button', class: 'rd-nav rd-nav-next', onclick: () => reading?.controller?.next() }, '›');
  const viewPanel = h('aside', { class: 'rd-view', hidden: true });
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
    h('header', { class: 'rd-head' }, readerBack, h('div', { class: 'rd-titles' }, title, subtitle), percent, viewButton, tocButton),
    scroll,
    status,
    line,
    prevButton,
    nextButton,
    quoteButton,
    tocPanel,
    viewPanel,
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
      [viewButton, 'reader.viewTitle'],
      [tocButton, 'reader.toc'],
      [prevButton, 'reader.prevPage'],
      [nextButton, 'reader.nextPage'],
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

  /** How far into the book: the page number in page mode, a percentage when scrolling. */
  function showProgress(value) {
    const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
    const pages = reading?.controller?.pages?.();
    percent.textContent = pages ? t('reader.pageOf', pages.index + 1, pages.count) : t('library.progress', pct);
    line.firstChild.style.transform = `scaleX(${pct / 100})`;
    prevButton.disabled = !pages || pages.index === 0;
    nextButton.disabled = !pages || pages.index >= pages.count - 1;
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
    viewPanel.hidden = true;
    quoteButton.hidden = true;
    const look = getReading();
    reader.dataset.font = look.readFont;
    reader.dataset.leading = look.readLeading;
    reader.dataset.format = doc.format;
    reader.classList.remove('is-paged');
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
        mode: look.readMode,
        turn: look.readTurn,
        onPosition: (position, progress) => remember(session, position, progress),
        onLink,
      });
      if (session.closed) {
        controller.close();
        return;
      }
      session.controller = controller;
      reader.classList.toggle('is-paged', controller.paged);
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
    viewPanel.hidden = true;
    reader.classList.remove('is-paged');
    render();
    grid.querySelector('.lib-card')?.focus({ preventScroll: true });
  }

  // a PDF page in page mode always fits the screen: no zoom there
  const canZoom = () => Boolean(reading?.controller) && !(reading.controller.kind === 'pdf' && reading.controller.paged);

  function zoom(direction) {
    if (!canZoom()) return;
    const range = reading.controller.kind === 'pdf' ? PDF_SCALE : BOOK_SCALE;
    const next = direction === 0 ? 1 : (reading.doc.scale || 1) + direction * range.step;
    reading.doc.scale = Math.round(Math.min(range.max, Math.max(range.min, next)) * 100) / 100;
    reading.controller.setScale(reading.doc.scale);
    remember(reading, reading.controller.position(), reading.controller.progress());
    if (!viewPanel.hidden) drawView();
  }

  // ---------- the view panel: size, pages or scroll, page turn, font, spacing, theme ----------

  function choices(label, options, current, words, pick) {
    return h(
      'section',
      { class: 'rdv-group' },
      h('div', { class: 'set-label' }, label),
      h(
        'div',
        { class: 'seg', role: 'radiogroup', 'aria-label': label },
        options.map((option) =>
          h('button', { type: 'button', class: 'seg-btn', role: 'radio', 'aria-checked': String(option === current), onclick: () => pick(option) }, words(option)),
        ),
      ),
    );
  }

  function drawView() {
    const look = getReading();
    const controller = reading?.controller;
    const pdf = controller?.kind === 'pdf';
    const sizeNote = !canZoom() && pdf ? h('div', { class: 'set-note' }, t('reader.pdfFit')) : null;
    const size = h(
      'section',
      { class: 'rdv-group' },
      h('div', { class: 'set-label' }, t('reader.size')),
      h(
        'div',
        { class: 'set-size' },
        h('button', { type: 'button', class: 'seg-btn', disabled: !canZoom() || null, 'aria-label': t('reader.smaller'), onclick: () => zoom(-1) }, 'A−'),
        h('span', { class: 'set-size-value' }, `${Math.round((reading?.doc.scale || 1) * 100)}%`),
        h('button', { type: 'button', class: 'seg-btn', disabled: !canZoom() || null, 'aria-label': t('reader.larger'), onclick: () => zoom(1) }, 'A+'),
        h('button', { type: 'button', class: 'seg-btn seg-reset', disabled: !canZoom() || null, onclick: () => zoom(0) }, t('settings.reset')),
      ),
      sizeNote,
    );
    const themes = h(
      'section',
      { class: 'rdv-group' },
      h('div', { class: 'set-label' }, t('reader.theme')),
      h(
        'div',
        { class: 'rdv-themes', role: 'radiogroup', 'aria-label': t('reader.theme') },
        THEMES.map((theme) =>
          h(
            'button',
            { type: 'button', class: 'rdv-theme', role: 'radio', 'data-swatch': theme, 'aria-checked': String(getTheme() === theme), onclick: () => pickTheme(theme) },
            h('span', { class: 'rdv-theme-chip', 'aria-hidden': 'true' }, 'Aa'),
            h('span', { class: 'rdv-theme-name' }, t(`themes.${theme}`)),
          ),
        ),
      ),
    );
    viewPanel.replaceChildren(
      h('div', { class: 'rd-toc-head' }, t('reader.view')),
      size,
      choices(t('reader.mode'), READ_MODES, look.readMode, (m) => t(`reader.modes.${m}`), (readMode) => setReading({ readMode })),
      look.readMode === 'pages' ? choices(t('reader.turn'), TURNS, look.readTurn, (k) => t(`reader.turns.${k}`), (readTurn) => setReading({ readTurn })) : null,
      pdf ? null : choices(t('reader.font'), READ_FONTS, look.readFont, (f) => t(`reader.fonts.${f}`), (readFont) => setReading({ readFont })),
      pdf ? null : choices(t('reader.leading'), LEADINGS, look.readLeading, (l) => t(`reader.leadings.${l}`), (readLeading) => setReading({ readLeading })),
      themes,
    );
  }

  /** A reading preference changed: the app keeps it, the open book shows it at once. */
  function setReading(patch) {
    onReading(patch);
    const controller = reading?.controller;
    if ('readFont' in patch) reader.dataset.font = patch.readFont;
    if ('readLeading' in patch) reader.dataset.leading = patch.readLeading;
    if (controller) {
      if ('readMode' in patch) {
        controller.setMode(patch.readMode);
        reader.classList.toggle('is-paged', controller.paged);
      }
      if ('readTurn' in patch) controller.setTurn(patch.readTurn);
      if ('readFont' in patch || 'readLeading' in patch) controller.relayout();
      showProgress(controller.progress());
    }
    drawView();
  }

  function pickTheme(theme) {
    onTheme(theme);
    drawView();
  }

  function toggleView(show = viewPanel.hidden) {
    tocPanel.hidden = true;
    viewPanel.hidden = !show;
    if (show) {
      drawView();
      viewPanel.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
    }
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
    viewPanel.hidden = true;
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

  // the contents and view panels close on a press anywhere else in the reader
  reader.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.rd-view, .rd-toc, .rd-head')) {
      viewPanel.hidden = true;
      tocPanel.hidden = true;
    }
  });

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
    if (!tocPanel.hidden || !viewPanel.hidden) {
      tocPanel.hidden = true;
      viewPanel.hidden = true;
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
    else if (reading?.controller?.paged && !mod && !e.altKey && !e.target.closest?.('input, .rd-view, .rd-toc') && PAGE_KEYS[e.key] !== undefined) {
      if (PAGE_KEYS[e.key] === 'shift-aware') (e.shiftKey ? reading.controller.prev : reading.controller.next)();
      else if (PAGE_KEYS[e.key] > 0) reading.controller.next();
      else reading.controller.prev();
    } else if (reading && mod && (e.code === 'Equal' || e.code === 'NumpadAdd')) zoom(1);
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

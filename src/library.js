// The library: documents to read next to the notes — PDF, EPUB, FB2, DOCX, Markdown, text, HTML.
// The shelf lists them as cards (cover, title, how far read); the reader opens one over the app,
// remembers the place and sends a selected passage, as a quote, to the document's own note.
// The reader's code (dist/reader.js, with pdf.js) is loaded the first time it is needed.

import { h, toast, confirmDialog, showMenu, isOverlayOpen } from './overlays.js';
import { count, t } from './i18n.js';
import { LEADINGS, READ_FONTS, READ_MODES, THEMES, TURNS } from './skins.js';
import { MARK_COLORS, MAX_BOOKMARKS, MAX_NOTE, MAX_TEXT, newBookmarkId, newMarkId, remapPdf, sortMarks } from './marks.js';
import { openPageEditor } from './pageEditor.js';

/** A link from a note back to a place in a document: atlas:<document>#<mark>. */
export const DOC_LINK_RE = /^atlas:(d-[a-z0-9]{6,40})(?:#(m-[a-z0-9]{4,40}))?$/;

const ACCEPT = '.pdf,.epub,.fb2,.zip,.docx,.doc,.odt,.rtf,.md,.markdown,.txt,.text,.html,.htm,.xhtml,.cbz,.jpg,.jpeg,.png,.webp,.gif,.bmp';
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
  let marksTimer = 0;
  let pendingMarks = null;
  let selected = null; // the selection the bar acts on, kept while the bar shows
  let openMarkId = null; // the mark whose card is open

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
  const moreButton = h('button', { type: 'button', class: 'tb-btn icon', onclick: () => openMore() }, '⋯');
  const marksButton = h('button', { type: 'button', class: 'tb-btn icon rd-marks-btn', onclick: () => toggleMarks() }, '✎', h('span', { class: 'rd-marks-count' }));
  const prevButton = h('button', { type: 'button', class: 'rd-nav rd-nav-prev', onclick: () => reading?.controller?.prev() }, '‹');
  const nextButton = h('button', { type: 'button', class: 'rd-nav rd-nav-next', onclick: () => reading?.controller?.next() }, '›');
  const viewPanel = h('aside', { class: 'rd-view', hidden: true });
  const status = h('div', { class: 'rd-status', role: 'status' });
  const line = h('div', { class: 'rd-line', 'aria-hidden': 'true' }, h('i'));
  const quoteText = h('span');
  const quoteButton = h('button', { type: 'button', class: 'rd-quote', onclick: quote }, h('span', { 'aria-hidden': 'true' }, '❝'), quoteText);
  // the bar over a selection: a colour makes a highlight, 💬 a highlight with a comment, ❝ a quote in the note
  const swatches = MARK_COLORS.map((color) => h('button', { type: 'button', class: 'rd-swatch', 'data-color': color, onclick: () => addMark(color) }));
  const commentText = h('span');
  const commentButton = h(
    'button',
    { type: 'button', class: 'rd-sel-btn', onclick: () => addMark(MARK_COLORS[0], { comment: true }) },
    h('span', { 'aria-hidden': 'true' }, '💬'),
    commentText,
  );
  const selBar = h('div', { class: 'rd-selbar', hidden: true, role: 'toolbar' }, h('div', { class: 'rd-swatches' }, swatches), commentButton, quoteButton);
  // the card of one mark: its passage, its comment, its colour
  const markPanel = h('aside', { class: 'rd-markpanel', hidden: true });
  const tocHead = h('div', { class: 'rd-toc-head' });
  const tocList = h('ol', { class: 'rd-toc-list' });
  const tocPanel = h('aside', { class: 'rd-toc', hidden: true }, tocHead, tocList);
  const marksHead = h('div', { class: 'rd-toc-head' });
  const marksList = h('ol', { class: 'rd-marks-list' });
  const marksPanel = h('aside', { class: 'rd-toc rd-marks', hidden: true }, marksHead, marksList);
  const reader = h(
    'section',
    { class: 'reader', hidden: true },
    h('header', { class: 'rd-head' }, readerBack, h('div', { class: 'rd-titles' }, title, subtitle), percent, viewButton, marksButton, tocButton, moreButton),
    scroll,
    status,
    line,
    prevButton,
    nextButton,
    selBar,
    markPanel,
    tocPanel,
    marksPanel,
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
      [marksButton, 'reader.marks.list'],
      [moreButton, 'reader.more'],
      [prevButton, 'reader.prevPage'],
      [nextButton, 'reader.nextPage'],
    ]) {
      button.title = t(key);
      button.setAttribute('aria-label', t(key));
    }
    dropHint.textContent = t('library.drop');
    quoteText.textContent = t('reader.quote');
    quoteButton.title = t('reader.quoteTitle');
    commentText.textContent = t('reader.marks.comment');
    commentButton.title = t('reader.marks.commentTitle');
    selBar.setAttribute('aria-label', t('reader.marks.bar'));
    for (const swatch of swatches) {
      swatch.title = t('reader.marks.highlight', t(`reader.marks.colors.${swatch.dataset.color}`));
      swatch.setAttribute('aria-label', swatch.title);
    }
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
    prevButton.disabled = !pages || pages.first;
    nextButton.disabled = !pages || pages.last;
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
    flushMarks();
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
    marksPanel.hidden = true;
    viewPanel.hidden = true;
    hideSelBar();
    markPanel.hidden = true;
    openMarkId = null;
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
      controller.setMarks?.(marksOf(doc));
      showMarkCount();
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
    closeMark();
    flush();
    reading.closed = true;
    reading.controller?.close();
    reading = null;
    reader.hidden = true;
    hideSelBar();
    tocPanel.hidden = true;
    marksPanel.hidden = true;
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
    marksPanel.hidden = true;
    tocPanel.hidden = true;
    marksPanel.hidden = true;
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
                    marksPanel.hidden = true;
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
    marksPanel.hidden = true;
    tocPanel.hidden = !show;
    if (show) tocPanel.querySelector('button')?.focus({ preventScroll: true });
  }

  // a selection inside the document offers a highlight, a comment or a quote
  document.addEventListener('selectionchange', () => {
    if (!reading?.controller) return hideSelBar();
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount && scroll.contains(sel.anchorNode) && sel.toString().trim()) {
      selected = sel.getRangeAt(0).cloneRange();
      selBar.hidden = false;
      closeMark();
    } else if (!selBar.contains(document.activeElement)) hideSelBar();
  });

  function hideSelBar() {
    selBar.hidden = true;
    selected = null;
  }

  /** The words of a passage, tidied: a PDF's lines are broken where the page broke them, so they become one paragraph. */
  function passage(controller, raw, max = 5000) {
    return (controller.kind === 'pdf' ? raw.replace(/\s+/g, ' ') : raw.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n')).trim().slice(0, max);
  }
  const whereText = (where) => (where.page ? t('reader.page', where.page) : where.heading) || '';

  /** Sends a passage to the document's note as a quote; true when it got there. */
  async function sendQuote(doc, text, where, markId) {
    try {
      const note = await onQuote(doc, text, where, `atlas:${doc.id}${markId ? `#${markId}` : ''}`);
      if (note.id !== doc.notesId) {
        doc.notesId = note.id;
        lib.update(doc.id, { notesId: note.id }).catch(() => {});
      }
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
      return true;
    } catch (err) {
      console.error(err);
      toast(t('reader.quoteFailed', err.message));
      return false;
    }
  }

  async function quote() {
    const range = selected;
    if (!reading?.controller || !range || range.collapsed) return;
    const { doc, controller } = reading;
    const text = passage(controller, range.toString());
    if (!text) return;
    quoteButton.disabled = true;
    try {
      // the quoted passage stays highlighted in the document, and the quote links back to it
      const mark = makeMark(controller, range, MARK_COLORS[0]);
      if (mark) {
        marksOf(doc).push(mark);
        saveMarks();
      }
      if (await sendQuote(doc, text, whereText(controller.where(range.startContainer)), mark?.id)) {
        document.getSelection()?.removeAllRanges();
        hideSelBar();
      }
    } finally {
      quoteButton.disabled = false;
    }
  }

  // ---------- marks ----------

  const marksOf = (doc) => (Array.isArray(doc.marks) ? doc.marks : (doc.marks = []));

  /** The marks changed: drawn again at once, kept a moment later (all of the document's marks in one go). */
  function saveMarks(session = reading) {
    if (!session || session.closed) return;
    session.controller?.setMarks?.(marksOf(session.doc), openMarkId);
    showMarkCount();
    if (!marksPanel.hidden) fillMarks();
    pendingMarks = { id: session.doc.id, marks: marksOf(session.doc) };
    clearTimeout(marksTimer);
    marksTimer = setTimeout(flushMarks, 500);
  }

  function flushMarks() {
    clearTimeout(marksTimer);
    if (!pendingMarks) return;
    const { id, marks } = pendingMarks;
    pendingMarks = null;
    lib.update(id, { marks }).catch((err) => {
      console.error(err);
      toast(t('reader.marks.failed', err.message));
    });
  }

  /** A new mark over a selection, or null where none can go. */
  function makeMark(controller, range, color) {
    const anchor = controller?.anchorOf?.(range);
    if (!anchor) return null;
    return {
      id: newMarkId(),
      color,
      note: '',
      text: passage(controller, range.toString(), MAX_TEXT),
      where: whereText(controller.where(range.startContainer)).slice(0, 300),
      anchor,
      created: Date.now(),
    };
  }

  function addMark(color, { comment = false } = {}) {
    const range = selected;
    if (!reading?.controller || !range) return;
    const mark = makeMark(reading.controller, range, color);
    if (!mark) {
      toast(t('reader.marks.noPlace'));
      return;
    }
    marksOf(reading.doc).push(mark);
    document.getSelection()?.removeAllRanges();
    hideSelBar();
    if (comment) openMark(mark.id, { focus: true });
    else saveMarks();
  }

  const findMark = (id) => (reading ? marksOf(reading.doc).find((m) => m.id === id) : null);

  function closeMark() {
    if (!openMarkId) return;
    const mark = findMark(openMarkId);
    markPanel.hidden = true;
    openMarkId = null;
    if (mark) mark.note = mark.note.trim();
    saveMarks();
  }

  function removeMark(id) {
    if (!reading) return;
    const session = reading;
    const list = marksOf(session.doc);
    const index = list.findIndex((m) => m.id === id);
    if (index < 0) return;
    const [mark] = list.splice(index, 1);
    markPanel.hidden = true;
    openMarkId = null;
    saveMarks();
    toast(t('reader.marks.removed'), {
      timeout: 6000,
      action: {
        text: t('reader.marks.undo'),
        run: () => {
          if (session.closed) return;
          const again = marksOf(session.doc);
          again.splice(Math.min(index, again.length), 0, mark);
          saveMarks(session);
        },
      },
    });
  }

  function openMark(id, { focus = false } = {}) {
    const mark = findMark(id);
    if (!mark) return;
    if (openMarkId && openMarkId !== id) closeMark();
    openMarkId = id;
    hideSelBar();
    tocPanel.hidden = true;
    marksPanel.hidden = true;
    viewPanel.hidden = true;
    const note = h('textarea', {
      class: 'field rd-mark-note',
      rows: '3',
      maxlength: String(MAX_NOTE),
      placeholder: t('reader.marks.placeholder'),
      'aria-label': t('reader.marks.comment'),
    });
    note.value = mark.note;
    note.addEventListener('input', () => {
      mark.note = note.value.slice(0, MAX_NOTE);
      mark.edited = Date.now();
      saveMarks();
    });
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        e.stopPropagation();
        closeMark();
        scroll.focus({ preventScroll: true });
      }
    });
    const colors = MARK_COLORS.map((color) =>
      h('button', {
        type: 'button',
        class: 'rd-swatch',
        'data-color': color,
        'aria-pressed': String(mark.color === color),
        title: t(`reader.marks.colors.${color}`),
        'aria-label': t(`reader.marks.colors.${color}`),
        onclick: () => {
          mark.color = color;
          mark.edited = Date.now();
          for (const b of colors) b.setAttribute('aria-pressed', String(b.dataset.color === color));
          saveMarks();
        },
      }),
    );
    const toNote = h(
      'button',
      {
        type: 'button',
        class: 'tb-btn',
        title: t('reader.quoteTitle'),
        onclick: () => sendQuote(reading.doc, mark.note.trim() ? `${mark.text}\n\n💬 ${mark.note.trim()}` : mark.text, mark.where, mark.id),
      },
      '❝ ',
      t('reader.quote'),
    );
    markPanel.replaceChildren(
      h(
        'div',
        { class: 'rd-mark-head' },
        h('div', { class: 'rd-swatches' }, colors),
        h('span', { class: 'rd-mark-where' }, mark.where || ''),
        h('button', { type: 'button', class: 'tb-btn icon', title: t('reader.marks.close'), 'aria-label': t('reader.marks.close'), onclick: () => closeMark() }, '✕'),
      ),
      h('blockquote', { class: 'rd-mark-text' }, mark.text),
      note,
      h(
        'div',
        { class: 'rd-mark-actions' },
        toNote,
        h('button', { type: 'button', class: 'tb-btn rd-mark-remove', onclick: () => removeMark(mark.id) }, t('reader.marks.remove')),
        h('button', { type: 'button', class: 'tb-btn accent', onclick: () => closeMark() }, t('reader.marks.done')),
      ),
    );
    markPanel.hidden = false;
    reading.controller?.setMarks?.(marksOf(reading.doc), id);
    if (focus) note.focus({ preventScroll: true });
  }

  // ---------- the file: download it, and a PDF's pages and marks ----------

  const MIME = { odt: 'application/vnd.oasis.opendocument.text', rtf: 'application/rtf', cbz: 'application/vnd.comicbook+zip', pdf: 'application/pdf', epub: 'application/epub+zip', fb2: 'application/xml', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', md: 'text/markdown', txt: 'text/plain', html: 'text/html' };

  function openMore() {
    if (!reading?.controller) return;
    const { doc } = reading;
    const r = moreButton.getBoundingClientRect();
    const items = [];
    if (doc.format === 'pdf') {
      items.push(
        { icon: '▦', text: t('pages.edit'), run: editPages },
        { icon: '⤓', text: t('pages.exportMarked'), disabled: !marksOf(doc).length, title: marksOf(doc).length ? undefined : t('pages.noMarks'), run: exportMarked },
        '-',
      );
    }
    items.push({ icon: '⤓', text: t('library.download'), run: downloadFile });
    showMenu(Math.max(8, r.right - 260), r.bottom + 4, items);
  }

  const baseOf = (doc) => doc.name.replace(/\.[^.]+$/, '') || 'document';

  async function downloadFile() {
    const doc = reading?.doc;
    if (!doc) return;
    try {
      api.download(doc.name, await lib.bytes(doc.id), MIME[doc.format] ?? 'application/octet-stream');
    } catch (err) {
      toast(err.message);
    }
  }

  async function exportMarked() {
    const doc = reading?.doc;
    if (!doc) return;
    flush();
    toast(t('pages.exporting'));
    try {
      const code = await loadReader();
      const out = await code.pdfWithMarks(await lib.bytes(doc.id), marksOf(doc));
      api.download(`${baseOf(doc)} ${t('pages.markedSuffix')}.pdf`, out, 'application/pdf');
    } catch (err) {
      console.error(err);
      toast(err.encrypted ? t('pages.encrypted') : t('pages.failed', err.message));
    }
  }

  async function editPages() {
    const session = reading;
    if (!session?.controller || session.doc.format !== 'pdf') return;
    const { doc } = session;
    flush();
    let code;
    let bytes;
    try {
      code = await loadReader();
      bytes = await lib.bytes(doc.id);
    } catch (err) {
      toast(err.message);
      return;
    }
    const saved = await openPageEditor({
      code,
      bytes,
      title: nameOf(doc),
      async onSave(out, plan) {
        const kept = remapPdf({ marks: marksOf(doc), bookmarks: bookmarksOf(doc) }, plan);
        const at = plan.findIndex((p) => p.src === 0 && p.page === doc.position?.page) + 1 || 1;
        await lib.replace(doc.id, out);
        const info = await code.inspect(doc.name, out).catch(() => null);
        const patch = {
          marks: kept.marks,
          bookmarks: kept.bookmarks,
          position: { page: at, frac: 0 },
          progress: plan.length > 1 ? (at - 1) / (plan.length - 1) : 0,
          ...(info?.cover ? { cover: info.cover } : {}),
        };
        Object.assign(doc, patch, { size: out.length });
        await lib.update(doc.id, patch);
      },
    });
    if (!saved) return;
    toast(t('pages.saved'));
    if (reading === session) await read(doc.id);
  }

  // ---------- the list of marks ----------

  const bookmarksOf = (doc) => (Array.isArray(doc.bookmarks) ? doc.bookmarks : (doc.bookmarks = []));

  function showMarkCount() {
    const n = reading ? marksOf(reading.doc).length + bookmarksOf(reading.doc).length : 0;
    marksButton.lastChild.textContent = n ? String(n) : '';
  }

  let bookmarksTimer = 0;
  function saveBookmarks(session = reading) {
    if (!session || session.closed) return;
    showMarkCount();
    if (!marksPanel.hidden) fillMarks();
    clearTimeout(bookmarksTimer);
    const { id } = session.doc;
    const bookmarks = bookmarksOf(session.doc);
    bookmarksTimer = setTimeout(() => lib.update(id, { bookmarks }).catch((err) => toast(t('reader.marks.failed', err.message))), 300);
  }

  /** A bookmark where the reader is now (Ctrl+D). */
  function addBookmark() {
    const controller = reading?.controller;
    if (!controller?.describe) return;
    const list = bookmarksOf(reading.doc);
    if (list.length >= MAX_BOOKMARKS) return;
    const position = controller.position();
    const progress = Math.min(1, Math.max(0, controller.progress()));
    const about = controller.describe(position);
    const pages = controller.pages?.();
    const label = (about.page ? t('reader.pageN', about.page) : [about.heading, pages ? t('reader.pageN', pages.index + 1) : t('library.progress', Math.round(progress * 100))].filter(Boolean).join(' · ')).slice(0, 300);
    list.push({ id: newBookmarkId(), position, progress, label, snippet: about.snippet.slice(0, 300), created: Date.now() });
    list.sort((x, y) => x.progress - y.progress || x.created - y.created);
    saveBookmarks();
    toast(t('reader.bookmarks.added', label));
  }

  function removeBookmark(id) {
    if (!reading) return;
    const list = bookmarksOf(reading.doc);
    const index = list.findIndex((b) => b.id === id);
    if (index >= 0) list.splice(index, 1);
    saveBookmarks();
  }

  function goToBookmark(bookmark) {
    marksPanel.hidden = true;
    reading?.controller?.goTo?.(bookmark.position);
    scroll.focus({ preventScroll: true });
  }

  function fillMarks() {
    const doc = reading?.doc;
    const marks = doc ? sortMarks(marksOf(doc).filter((m) => m.anchor)) : [];
    const bookmarks = doc ? bookmarksOf(doc) : [];
    marksHead.textContent = t('reader.marks.list');
    const add = h('button', { type: 'button', class: 'tb-btn rd-bm-add', title: t('reader.bookmarks.addTitle'), onclick: addBookmark }, '🔖 ', t('reader.bookmarks.add'));
    const bookmarkItems = bookmarks.map((b) =>
      h(
        'li',
        { class: 'rd-marks-item rd-bm-item' },
        h(
          'button',
          { type: 'button', onclick: () => goToBookmark(b) },
          h('span', { class: 'rd-bm-icon', 'aria-hidden': 'true' }, '🔖'),
          h('span', { class: 'rd-marks-body' }, h('span', { class: 'rd-marks-text' }, b.label), b.snippet ? h('span', { class: 'rd-marks-where' }, b.snippet) : null),
        ),
        h('button', { type: 'button', class: 'rd-bm-remove', title: t('reader.bookmarks.remove'), 'aria-label': t('reader.bookmarks.remove'), onclick: () => removeBookmark(b.id) }, '✕'),
      ),
    );
    const markItems = marks.map((mark) =>
      h(
        'li',
        { class: 'rd-marks-item' },
        h(
          'button',
          { type: 'button', 'data-color': mark.color, onclick: () => showMark(mark.id) },
          h('span', { class: 'rd-marks-dot', 'aria-hidden': 'true' }),
          h(
            'span',
            { class: 'rd-marks-body' },
            h('span', { class: 'rd-marks-text' }, mark.text),
            mark.note ? h('span', { class: 'rd-marks-note' }, `💬 ${mark.note}`) : null,
            mark.where ? h('span', { class: 'rd-marks-where' }, mark.where) : null,
          ),
        ),
      ),
    );
    marksList.replaceChildren(
      h('li', { class: 'rd-bm-actions' }, add),
      h('li', { class: 'rd-marks-section' }, `${t('reader.bookmarks.title')}${bookmarks.length ? ` · ${bookmarks.length}` : ''}`),
      ...(bookmarkItems.length ? bookmarkItems : [h('li', { class: 'rd-toc-empty' }, t('reader.bookmarks.none'))]),
      h('li', { class: 'rd-marks-section' }, `${t('reader.marks.title')}${marks.length ? ` · ${marks.length}` : ''}`),
      ...(markItems.length ? markItems : [h('li', { class: 'rd-toc-empty' }, t('reader.marks.none'))]),
    );
  }

  function toggleMarks(show = marksPanel.hidden) {
    viewPanel.hidden = true;
    tocPanel.hidden = true;
    closeMark();
    marksPanel.hidden = !show;
    if (show) {
      fillMarks();
      marksPanel.querySelector('button')?.focus({ preventScroll: true });
    }
  }

  /** Takes the reader to a mark and opens its card. */
  function showMark(id) {
    marksPanel.hidden = true;
    if (!reading?.controller?.goToMark?.(id)) {
      toast(t('reader.marks.notFound'));
      return;
    }
    openMark(id);
  }

  /** Follows a link from a note (atlas:<document>#<mark>): opens the document there. */
  async function openLink(url) {
    const [, docId, markId] = DOC_LINK_RE.exec(url) ?? [];
    if (!docId) return false;
    if (!docs.some((d) => d.id === docId)) await refresh();
    if (!docs.some((d) => d.id === docId)) {
      toast(t('reader.marks.noDoc'));
      return true;
    }
    if (reading?.doc.id !== docId || !reading.controller) await read(docId);
    if (markId && reading?.doc.id === docId && reading.controller) showMark(markId);
    return true;
  }

  // a short tap on a mark opens its card (caught before the pager can take the tap as a page turn)
  let tap = null;
  scroll.addEventListener(
    'pointerdown',
    (e) => {
      tap = e.button === 0 ? { x: e.clientX, y: e.clientY, at: performance.now() } : null;
    },
    true,
  );
  scroll.addEventListener(
    'pointerup',
    (e) => {
      const start = tap;
      tap = null;
      if (!start || !reading?.controller?.markAt || performance.now() - start.at > 500 || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) return;
      const sel = document.getSelection();
      if ((sel && !sel.isCollapsed && scroll.contains(sel.anchorNode)) || e.target.closest?.('a[data-target]')) return;
      const id = reading.controller.markAt(e.clientX, e.clientY);
      if (!id) return;
      e.stopPropagation();
      openMark(id);
    },
    true,
  );

  // the contents and view panels close on a press anywhere else in the reader
  reader.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.rd-view, .rd-toc, .rd-head')) {
      viewPanel.hidden = true;
      tocPanel.hidden = true;
      marksPanel.hidden = true;
    }
    if (!e.target.closest('.rd-markpanel, .rd-selbar, .rd-head')) closeMark();
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
    if (openMarkId) {
      closeMark();
      return true;
    }
    if (!tocPanel.hidden || !marksPanel.hidden || !viewPanel.hidden) {
      tocPanel.hidden = true;
      marksPanel.hidden = true;
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
    else if (reading?.controller?.paged && !mod && !e.altKey && !e.target.closest?.('input, textarea, .rd-view, .rd-toc, .rd-markpanel') && PAGE_KEYS[e.key] !== undefined) {
      if (PAGE_KEYS[e.key] === 'shift-aware') (e.shiftKey ? reading.controller.prev : reading.controller.next)();
      else if (PAGE_KEYS[e.key] > 0) reading.controller.next();
      else reading.controller.prev();
    } else if (reading && mod && (e.code === 'Equal' || e.code === 'NumpadAdd')) zoom(1);
    else if (reading && mod && (e.code === 'Minus' || e.code === 'NumpadSubtract')) zoom(-1);
    else if (reading && mod && (e.code === 'Digit0' || e.code === 'Numpad0')) zoom(0);
    else if (reading?.controller && mod && e.code === 'KeyD') addBookmark();
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
    /** atlas:<document>#<mark> from a note; false when the link is not one of these. */
    openLink,
    back,
    onKey,
    flush,
    /** Cards changed elsewhere (sync): read them again. */
    async reload() {
      await refresh();
      if (!shelf.hidden) render();
    },
    /** The document open in the reader, if any: sync leaves it for later. */
    openDocId: () => (reading && !reading.closed ? reading.doc.id : null),
  };
}

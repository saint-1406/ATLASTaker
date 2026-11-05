// The Apocrypha screen: what the Apocrypha tab opens. A search, the kinds as chips, the language and
// the order, then the shared files as cards. A tap opens a file's card: download it into the library,
// report it, or (for its owner) stop sharing it; the app's owner can hide it. The ⋯ button lists what
// this person shared and, for the app's owner, the reports.
// share(doc) is the library's "Share to Apocrypha": the checks, the form, the warning and the tick.

import { h, toast, confirmDialog, openDialog, showMenu } from '../overlays.js';
import { currentLocale, formatDay, formatNumber, t } from '../i18n.js';
import { ApocryphaError, createApocrypha } from './client.js';
import { checkFile, formatSize, kindOf, KINDS, languageOf, MAX_SHARE, sha256Hex, ShareCheckError } from './checks.js';

const MINE_KEY = 'atlas.apocrypha.mine'; // ids this device shared: their cards offer "Stop sharing"
const ADMIN_KEY = 'atlas.apocrypha.admin'; // the catalogue said this account is the app's owner
const COMMON_LANGS = ['ru', 'en', 'uk', 'be', 'kk', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'cs', 'tr', 'ja', 'zh', 'ko', 'ar', 'he', 'la', 'und'];
const REASONS = ['rights', 'illegal', 'broken', 'spam', 'other'];

const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // private mode: only this session remembers
    }
  },
};

/** "Русский", "English"… in the interface's language; '—' for a language nobody knows. */
export function langName(code) {
  if (!code || code === 'und') return '—';
  try {
    const name = new Intl.DisplayNames([currentLocale()], { type: 'language' }).of(code);
    return name ? name[0].toLocaleUpperCase(currentLocale()) + name.slice(1) : code;
  } catch {
    return code;
  }
}

/** A file name for a download: the title, and the format's extension (zipped FB2 keeps .fb2.zip). */
export function fileNameOf(item, bytes) {
  const base = String(item.title || 'apocrypha').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'apocrypha';
  const zipped = bytes?.[0] === 0x50 && bytes?.[1] === 0x4b;
  return `${base}.${item.format === 'fb2' && zipped ? 'fb2.zip' : item.format}`;
}

/** The words for something that went wrong. */
export function messageOf(err) {
  if (err instanceof ShareCheckError) {
    if (err.code === 'format') return t('apocrypha.badFormat', err.detail ? err.detail.toUpperCase() : '?');
    if (err.code === 'size') return t('apocrypha.tooBig', formatSize(MAX_SHARE));
    return t('apocrypha.emptyFile');
  }
  const code = err?.code;
  if (code === 'needs-consent') return t('apocrypha.consent');
  if (code === 'auth' && !err.status) return t('apocrypha.signIn');
  if (code === 'cancelled') return t('apocrypha.cancelled');
  if (code === 'needs-update') return t('apocrypha.updateApp');
  if (code === 'duplicate') return t(err.hidden ? 'apocrypha.duplicateHidden' : 'apocrypha.duplicate');
  const known = code && t(`apocrypha.errors.${code}`);
  if (known && known !== `apocrypha.errors.${code}`) return known;
  return t('apocrypha.failed', err?.message || String(err));
}

/** The library card's picture, small enough for the catalogue (it takes up to 120 KB). */
async function smallCover(src) {
  if (!src) return null;
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const width = Math.min(220, img.naturalWidth);
    const height = Math.round((img.naturalHeight * width) / img.naturalWidth);
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    for (const quality of [0.8, 0.65, 0.5]) {
      const out = canvas.toDataURL('image/jpeg', quality);
      if (out.length < 110_000) return out;
    }
  } catch {
    // no picture: the card shows the format
  }
  return null;
}

/**
 * api: the app's storage (api.sync gives Google tokens, api.library the files); getReader(): the
 * reader's code (detectFormat, inspect); addToLibrary(file) → the library cards made;
 * readDoc(id); onBack(); onShown(open): the tab bar follows.
 */
export function createApocryphaScreen({ api, getReader, addToLibrary, readDoc, onBack, onShown = () => {} }) {
  const available = Boolean(api.sync?.token);

  async function getToken(force = false) {
    let answer;
    try {
      answer = await api.sync.token(force);
    } catch {
      throw new ApocryphaError('offline');
    }
    if (answer?.ok && answer.token) return answer.token;
    throw new ApocryphaError(answer?.error || 'auth');
  }
  const client = createApocrypha({ getToken });

  let mine = new Set(store.get(MINE_KEY, []));
  let admin = Boolean(store.get(ADMIN_KEY, false));
  const remember = () => store.set(MINE_KEY, [...mine]);

  // ---------- the screen ----------
  const filters = { q: '', kind: '', lang: '', sort: 'new' };
  let page = 0;
  let pages = 1;
  let items = [];
  let loading = null;
  let loadedOnce = false;
  let token = 0; // a newer search makes an older answer moot

  const heading = h('span', { class: 'notes-heading-text' });
  const counter = h('span', { class: 'notes-count' });
  const backButton = h('button', { type: 'button', class: 'tb-btn icon notes-back', onclick: () => onBack() }, '←');
  const moreMenu = h('button', { type: 'button', class: 'tb-btn icon apo-menu', 'aria-haspopup': 'menu' }, '⋯');
  moreMenu.addEventListener('click', () => {
    const r = moreMenu.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, [
      { icon: '☰', text: t('apocrypha.mine'), run: () => showMine() },
      admin ? { icon: '⚑', text: t('apocrypha.reports'), run: () => showReports() } : null,
    ].filter(Boolean));
  });
  const tagline = h('p', { class: 'apo-tagline' });
  const search = h('input', { class: 'field notes-search apo-search', type: 'search', spellcheck: 'false', enterkeyhint: 'search' });
  let typing = 0;
  search.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      filters.q = search.value.trim();
      reload();
    }, 350);
  });
  const chips = h('div', { class: 'lib-chips notes-chips apo-chips', role: 'tablist' });
  const langSelect = h('select', { class: 'field apo-select' });
  langSelect.addEventListener('change', () => {
    filters.lang = langSelect.value;
    reload();
  });
  const sortNew = h('button', { type: 'button', class: 'seg-btn', onclick: () => setSort('new') });
  const sortPopular = h('button', { type: 'button', class: 'seg-btn', onclick: () => setSort('popular') });
  const tools = h('div', { class: 'apo-tools' }, langSelect, h('div', { class: 'seg apo-sort' }, sortNew, sortPopular));
  const grid = h('ol', { class: 'apo-grid' });
  const note = h('div', { class: 'apo-note', hidden: true });
  const moreButton = h('button', { type: 'button', class: 'btn apo-more', hidden: true, onclick: () => load() });
  const body = h('div', { class: 'notes-body apo-body' }, tagline, search, chips, tools, grid, note, moreButton);
  const node = h('section', { class: 'notes-screen apo-screen', hidden: true }, h('header', { class: 'notes-head apo-head' }, backButton, h('h2', { class: 'notes-heading' }, heading, counter), moreMenu), body);
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      onBack();
    }
  });
  // the next page comes by itself near the end of the list
  body.addEventListener('scroll', () => {
    if (!moreButton.hidden && !loading && body.scrollTop + body.clientHeight > body.scrollHeight - 400) load();
  });

  function setSort(sort) {
    if (filters.sort === sort) return;
    filters.sort = sort;
    reload();
  }

  function localize() {
    heading.textContent = t('apocrypha.title');
    backButton.title = t('apocrypha.back');
    backButton.setAttribute('aria-label', t('apocrypha.back'));
    moreMenu.title = t('apocrypha.mine');
    moreMenu.setAttribute('aria-label', t('apocrypha.mine'));
    tagline.textContent = t('apocrypha.tagline');
    search.placeholder = t('apocrypha.search');
    search.setAttribute('aria-label', t('apocrypha.search'));
    sortNew.textContent = t('apocrypha.sortNew');
    sortPopular.textContent = t('apocrypha.sortPopular');
    moreButton.textContent = t('apocrypha.more');
    if (!langSelect.options.length) langSelect.append(h('option', { value: '' }, t('apocrypha.allLangs')));
    else langSelect.options[0].textContent = t('apocrypha.allLangs');
    langSelect.setAttribute('aria-label', t('apocrypha.fieldLang'));
    drawChips();
  }

  function drawChips() {
    const chip = (kind, text) =>
      h(
        'button',
        {
          type: 'button',
          class: 'lib-chip notes-chip',
          role: 'tab',
          'aria-selected': String(filters.kind === kind),
          onclick: () => {
            filters.kind = kind;
            drawChips();
            reload();
          },
        },
        text,
      );
    chips.replaceChildren(chip('', t('apocrypha.all')), ...KINDS.map((k) => chip(k, t(`apocrypha.kinds.${k}`))));
    sortNew.setAttribute('aria-checked', String(filters.sort === 'new'));
    sortPopular.setAttribute('aria-checked', String(filters.sort === 'popular'));
  }

  async function fillLangs() {
    const langs = await client.langs().catch(() => null);
    if (!langs) return;
    const keep = filters.lang;
    langSelect.replaceChildren(
      h('option', { value: '' }, t('apocrypha.allLangs')),
      ...langs.map(({ lang, count }) => h('option', { value: lang }, `${langName(lang)} · ${formatNumber(count)}`)),
    );
    langSelect.value = keep;
  }

  function reload() {
    page = 0;
    pages = 1;
    items = [];
    grid.replaceChildren();
    drawChips();
    return load();
  }

  async function load() {
    if (page >= pages) return;
    const mineToken = ++token;
    const want = page + 1;
    showNote(page ? '' : t('apocrypha.loading'));
    moreButton.hidden = true;
    loading = client.search({ ...filters, page: want });
    try {
      const answer = await loading;
      if (mineToken !== token) return;
      page = answer.page;
      pages = answer.pages;
      items.push(...answer.items);
      grid.append(...answer.items.map(card));
      counter.textContent = answer.total ? formatNumber(answer.total) : '';
      const searching = filters.q || filters.kind || filters.lang;
      showNote(items.length ? '' : t(searching ? 'apocrypha.nothingFound' : 'apocrypha.empty'));
      moreButton.hidden = page >= pages;
      loadedOnce = true;
    } catch (err) {
      if (mineToken !== token) return;
      showNote(err.code === 'offline' ? t('apocrypha.offline') : messageOf(err), true);
    } finally {
      if (mineToken === token) loading = null;
    }
  }

  function showNote(text, retry = false) {
    note.hidden = !text;
    note.replaceChildren(text ? h('p', {}, text) : '', retry ? h('button', { type: 'button', class: 'btn', onclick: () => reload() }, t('apocrypha.retry')) : '');
  }

  function coverNode(item, className) {
    const blank = () => h('span', { class: `${className} apo-cover-blank` }, item.format.toUpperCase());
    if (!item.cover) return blank();
    const img = h('img', { class: className, src: client.coverUrl(item.id), alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(blank()), { once: true });
    return img;
  }

  const metaLine = (item) => [langName(item.lang), item.format.toUpperCase(), formatSize(item.size)].filter((x) => x && x !== '—').join(' · ');

  function card(item) {
    return h(
      'li',
      {},
      h(
        'button',
        { type: 'button', class: 'apo-card', onclick: () => openItem(item) },
        h('span', { class: 'apo-cover-wrap' }, coverNode(item, 'apo-cover'), h('span', { class: 'lib-format' }, t(`apocrypha.kind.${item.kind}`))),
        h('span', { class: 'apo-card-title' }, item.title),
        item.author ? h('span', { class: 'apo-card-author' }, item.author) : null,
        h('span', { class: 'apo-card-meta' }, metaLine(item)),
      ),
    );
  }

  // ---------- one file ----------

  function openItem(item) {
    openDialog(
      (box, close) => {
        const download = h('button', { type: 'button', class: 'btn primary', 'data-autofocus': true }, t('apocrypha.download'));
        download.addEventListener('click', () => fetchInto(item, download));
        const actions = [
          h('button', { type: 'button', class: 'btn', onclick: () => report(item) }, t('apocrypha.report')),
          mine.has(item.id) || admin
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn danger',
                  onclick: async () => {
                    if (await unpublish(item)) close();
                  },
                },
                t('apocrypha.unpublish'),
              )
            : null,
          admin
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn',
                  onclick: async () => {
                    if (await hide(item, true)) close();
                  },
                },
                t('apocrypha.hide'),
              )
            : null,
        ];
        box.append(
          h('div', { class: 'modal-kicker' }, `${t('apocrypha.title')} · ${t(`apocrypha.kind.${item.kind}`)}`),
          h(
            'div',
            { class: 'apo-detail-head' },
            coverNode(item, 'apo-detail-cover'),
            h(
              'div',
              { class: 'apo-detail-text' },
              h('h2', { class: 'modal-title' }, item.title),
              item.author ? h('p', { class: 'apo-detail-author' }, item.author) : null,
              h('p', { class: 'apo-detail-meta' }, metaLine(item)),
              h('p', { class: 'apo-detail-meta' }, `${t('apocrypha.shared', formatDay(item.created))} · ${t('apocrypha.downloads', formatNumber(item.downloads))}`),
            ),
          ),
          item.description ? h('p', { class: 'modal-text apo-detail-description' }, item.description) : null,
          h('div', { class: 'modal-actions apo-detail-actions' }, ...actions, download),
        );
      },
      { className: 'apo-detail' },
    );
  }

  async function fetchInto(item, button) {
    button.disabled = true;
    try {
      const bytes = await client.download(item, (got, total) => {
        button.textContent = t('apocrypha.downloading', total ? `${Math.min(99, Math.floor((got / total) * 100))}%` : formatSize(got));
      });
      const docs = await addToLibrary(new File([bytes], fileNameOf(item, bytes)));
      item.downloads++;
      if (docs?.[0]) toast(t('apocrypha.downloaded', item.title), { timeout: 7000, action: { text: t('apocrypha.read'), run: () => readDoc(docs[0].id) } });
    } catch (err) {
      toast(messageOf(err), { timeout: 7000 });
    } finally {
      button.disabled = false;
      button.textContent = t('apocrypha.download');
    }
  }

  function report(item) {
    openDialog((box, close) => {
      let reason = '';
      const send = h('button', { type: 'button', class: 'btn primary', disabled: true }, t('apocrypha.reportSend'));
      const text = h('textarea', { class: 'field apo-textarea', maxlength: '500', rows: '3', placeholder: t('apocrypha.reportNote'), 'aria-label': t('apocrypha.reportNote') });
      const options = REASONS.map((r) => {
        const input = h('input', { type: 'radio', name: 'apo-reason', value: r });
        input.addEventListener('change', () => {
          reason = r;
          send.disabled = false;
        });
        return h('label', { class: 'apo-radio' }, input, h('span', {}, t(`apocrypha.reasons.${r}`)));
      });
      send.addEventListener('click', async () => {
        send.disabled = true;
        try {
          await client.report(item.id, reason, text.value.trim());
          close();
          toast(t('apocrypha.reported'));
        } catch (err) {
          send.disabled = false;
          toast(messageOf(err), { timeout: 7000 });
        }
      });
      box.append(
        h('div', { class: 'modal-kicker' }, item.title),
        h('h2', { class: 'modal-title' }, t('apocrypha.reportTitle')),
        h('div', { class: 'apo-radios' }, options),
        text,
        h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => close() }, t('dialog.cancel')), send),
      );
    });
  }

  async function unpublish(item) {
    const ok = await confirmDialog({ kicker: t('apocrypha.title'), title: t('apocrypha.unpublish'), text: t('apocrypha.unpublishAsk', item.title), ok: t('apocrypha.unpublish'), danger: true });
    if (!ok) return false;
    try {
      await client.unpublish(item.id);
    } catch (err) {
      if (err.code !== 'not-found') {
        toast(messageOf(err), { timeout: 7000 });
        return false;
      }
    }
    mine.delete(item.id);
    remember();
    toast(t('apocrypha.unpublished'));
    if (!node.hidden) reload();
    return true;
  }

  async function hide(item, hidden) {
    try {
      await client.hide(item.id, hidden);
      if (!node.hidden) reload();
      return true;
    } catch (err) {
      toast(messageOf(err), { timeout: 7000 });
      return false;
    }
  }

  /** A list in a dialog: this person's shares, or the reports for the app's owner. */
  function listDialog(title, load, row) {
    openDialog(
      (box) => {
        const list = h('ol', { class: 'apo-list' }, h('li', { class: 'apo-list-note' }, t('apocrypha.loading')));
        box.append(h('div', { class: 'modal-kicker' }, t('apocrypha.title')), h('h2', { class: 'modal-title' }, title), list);
        load().then(
          (rows) => list.replaceChildren(...(rows.length ? rows.map(row) : [h('li', { class: 'apo-list-note' }, title === t('apocrypha.mine') ? t('apocrypha.mineEmpty') : t('apocrypha.reportsEmpty'))])),
          (err) => list.replaceChildren(h('li', { class: 'apo-list-note' }, messageOf(err))),
        );
      },
      { className: 'apo-list-dialog' },
    );
  }

  const statusOf = (item) => [item.hidden === 1 ? t('apocrypha.hidden') : item.hidden === 2 ? t('apocrypha.gone') : '', item.reports ? t('apocrypha.complaints', item.reports) : ''].filter(Boolean).join(' · ');

  function showMine() {
    listDialog(
      t('apocrypha.mine'),
      async () => {
        const answer = await client.mine();
        admin = Boolean(answer.admin);
        store.set(ADMIN_KEY, admin);
        mine = new Set(answer.items.map((i) => i.id));
        remember();
        return answer.items;
      },
      (item) => {
        const li = h(
          'li',
          { class: 'apo-list-row' },
          h('span', { class: 'apo-list-text' }, h('b', {}, item.title), h('span', {}, [metaLine(item), t('apocrypha.downloads', formatNumber(item.downloads)), statusOf(item)].filter(Boolean).join(' · '))),
          h(
            'button',
            {
              type: 'button',
              class: 'btn danger',
              onclick: async () => {
                if (await unpublish(item)) li.remove();
              },
            },
            t('apocrypha.unpublish'),
          ),
        );
        return li;
      },
    );
  }

  function showReports() {
    listDialog(
      t('apocrypha.reports'),
      async () => (await client.reports()).items,
      (item) => {
        const li = h('li', { class: 'apo-list-row' });
        const toggle = h('button', { type: 'button', class: 'btn' }, t(item.hidden === 1 ? 'apocrypha.unhide' : 'apocrypha.hide'));
        toggle.addEventListener('click', async () => {
          const next = item.hidden !== 1;
          if (await hide(item, next)) {
            item.hidden = next ? 1 : 0;
            toggle.textContent = t(next ? 'apocrypha.unhide' : 'apocrypha.hide');
          }
        });
        const reasons = (item.complaints ?? []).map((c) => `${t(`apocrypha.reasons.${c.reason}`)}${c.note ? `: ${c.note}` : ''}`);
        li.append(h('span', { class: 'apo-list-text' }, h('b', {}, item.title), h('span', {}, [item.author, statusOf(item)].filter(Boolean).join(' · ')), ...reasons.map((r) => h('span', { class: 'apo-list-reason' }, r))), toggle);
        return li;
      },
    );
  }

  // ---------- sharing a book from the library ----------

  async function share(doc) {
    if (!available) {
      toast(t('apocrypha.unavailable'));
      return;
    }
    toast(t('apocrypha.checking'), { timeout: 30_000 });
    let found;
    try {
      const reader = await getReader();
      const bytes = await api.library.bytes(doc.id);
      const format = checkFile(doc.name, bytes, reader.detectFormat);
      const sha256 = await sha256Hex(bytes);
      const same = await client.lookup(sha256);
      if (same.item || same.hidden) {
        toast(t(same.hidden ? 'apocrypha.duplicateHidden' : 'apocrypha.duplicate'), {
          timeout: 8000,
          action: same.item ? { text: t('apocrypha.open'), run: () => show().then(() => openItem(same.item)) } : undefined,
        });
        return;
      }
      const info = await reader.inspect(doc.name, bytes, { sample: true }).catch(() => ({}));
      const title = doc.title || info.title || doc.name;
      found = { bytes, format, sha256, lang: languageOf({ meta: info.lang, text: info.text, title }), title, author: doc.author || info.author || '' };
    } catch (err) {
      toast(messageOf(err), { timeout: 8000 });
      return;
    }
    toast(t('apocrypha.checking'), { timeout: 1 });
    shareDialog(doc, found);
  }

  function shareDialog(doc, found) {
    openDialog(
      (box, close) => {
        const field = (label, input) => h('label', { class: 'apo-field' }, h('span', { class: 'apo-field-label' }, label), input);
        const title = h('input', { class: 'field', type: 'text', maxlength: '300', value: found.title });
        const author = h('input', { class: 'field', type: 'text', maxlength: '300', value: found.author });
        const kind = h('select', { class: 'field' }, KINDS.map((k) => h('option', { value: k }, t(`apocrypha.kind.${k}`))));
        kind.value = kindOf(found.format);
        const langs = [...new Set([found.lang, ...COMMON_LANGS])];
        const lang = h('select', { class: 'field' }, langs.map((l) => h('option', { value: l }, langName(l))));
        lang.value = found.lang;
        const description = h('textarea', { class: 'field apo-textarea', maxlength: '2000', rows: '3' });
        const tick = h('input', { type: 'checkbox' });
        const status = h('p', { class: 'apo-status', hidden: true });
        const publish = h('button', { type: 'button', class: 'btn primary', disabled: true }, t('apocrypha.publish'));
        tick.addEventListener('change', () => (publish.disabled = !tick.checked || !title.value.trim()));
        title.addEventListener('input', () => (publish.disabled = !tick.checked || !title.value.trim()));

        const say = (text, action = null) => {
          status.hidden = !text;
          status.replaceChildren(text, action ? h('button', { type: 'button', class: 'btn', onclick: action.run }, action.text) : '');
        };

        publish.addEventListener('click', async () => {
          publish.disabled = true;
          publish.textContent = t('apocrypha.publishing');
          say('');
          try {
            const item = await client.publish({
              name: doc.name,
              bytes: found.bytes,
              meta: {
                sha256: found.sha256,
                size: found.bytes.length,
                format: found.format,
                kind: kind.value,
                lang: lang.value,
                title: title.value.trim(),
                author: author.value.trim(),
                description: description.value.trim(),
                cover: await smallCover(doc.cover),
              },
            });
            mine.add(item.id);
            remember();
            close();
            toast(t('apocrypha.published', item.title), { timeout: 7000, action: { text: t('apocrypha.open'), run: () => show().then(() => openItem(item)) } });
            if (!node.hidden) reload();
          } catch (err) {
            console.error(err);
            publish.disabled = !tick.checked;
            publish.textContent = t('apocrypha.publish');
            if (err.code === 'needs-consent' || (err.status === 403 && /scope|permission/i.test(err.message))) {
              // Windows: an account signed in before sharing existed signs in once more
              say(t('apocrypha.consent'), { text: t('apocrypha.signInAgain'), run: () => api.sync.signIn?.().catch(() => {}) });
            } else say(messageOf(err));
          }
        });

        box.append(
          h('div', { class: 'modal-kicker' }, `${t('apocrypha.title')} · ${found.format.toUpperCase()} · ${formatSize(found.bytes.length)}`),
          h('h2', { class: 'modal-title' }, t('apocrypha.shareTitle')),
          h('p', { class: 'apo-warning' }, t('apocrypha.warning')),
          field(t('apocrypha.fieldTitle'), title),
          field(t('apocrypha.fieldAuthor'), author),
          h('div', { class: 'apo-field-row' }, field(t('apocrypha.fieldKind'), kind), field(t('apocrypha.fieldLang'), lang)),
          field(t('apocrypha.fieldDescription'), description),
          h('label', { class: 'apo-check' }, tick, h('span', {}, t('apocrypha.rightsCheck'))),
          status,
          h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => close() }, t('dialog.cancel')), publish),
        );
      },
      { className: 'apo-share', dismissable: true },
    );
  }

  // ---------- showing ----------

  async function show() {
    localize();
    node.hidden = false;
    document.body.classList.add('at-apocrypha');
    onShown(true);
    if (!available) {
      showNote(t('apocrypha.unavailable'));
      return;
    }
    if (!loadedOnce && !loading) {
      fillLangs();
      await reload();
    }
  }

  function hide_() {
    if (node.hidden) return;
    node.hidden = true;
    document.body.classList.remove('at-apocrypha');
    onShown(false);
  }

  return {
    node,
    available,
    show,
    hide: hide_,
    isOpen: () => !node.hidden,
    share,
    relocalize: () => {
      if (!node.hidden) localize();
    },
  };
}

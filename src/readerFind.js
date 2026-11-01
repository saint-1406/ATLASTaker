// Finding a word or a phrase in the open document: a bar under the reader's header (Ctrl+F), with
// how many matches there are, the way from one to the next (Enter / Shift+Enter, F3), and a list of
// them with the words around each. The searching itself is the controller's (reader/view.js for
// books, reader/pdf.js for PDF): find(query, onProgress), showFound(i), clearFind().

import { h } from './overlays.js';
import { t } from './i18n.js';
import { MAX_HITS } from './reader/search.js';

const LIST_MAX = 400; // matches listed; the counter still counts them all

/** getController() → the open document's controller or null; onList() runs as the list opens (other panels close). */
export function createFind({ reader, getController, onList }) {
  const input = h('input', { class: 'field rd-find-input', type: 'search', spellcheck: 'false', autocomplete: 'off' });
  const counter = h('span', { class: 'rd-find-count', 'aria-live': 'polite' });
  const bar_ = h('i');
  const progress = h('div', { class: 'rd-find-progress', hidden: true }, bar_);
  const prevButton = h('button', { type: 'button', class: 'tb-btn icon', onclick: () => step(-1) }, '↑');
  const nextButton = h('button', { type: 'button', class: 'tb-btn icon', onclick: () => step(1) }, '↓');
  const listButton = h('button', { type: 'button', class: 'tb-btn icon', onclick: () => toggleList() }, '≡');
  const closeButton = h('button', { type: 'button', class: 'tb-btn icon', onclick: () => close() }, '×');
  const bar = h('div', { class: 'rd-find', role: 'search', hidden: true }, input, counter, prevButton, nextButton, listButton, closeButton, progress);
  const listHead = h('div', { class: 'rd-toc-head' });
  const listItems = h('ol', { class: 'rd-find-items' });
  const list = h('aside', { class: 'rd-toc rd-find-list', hidden: true }, listHead, listItems);

  let hits = [];
  let now = -1;
  let searching = false;
  let noText = false;
  let run = 0;
  let timer = 0;
  let searched = ''; // the query the hits are for

  function localize() {
    input.placeholder = t('reader.find.placeholder');
    input.setAttribute('aria-label', t('reader.find.placeholder'));
    for (const [button, key] of [
      [prevButton, 'reader.find.prev'],
      [nextButton, 'reader.find.next'],
      [listButton, 'reader.find.list'],
      [closeButton, 'reader.find.close'],
    ]) {
      button.title = t(key);
      button.setAttribute('aria-label', t(key));
    }
    showCount();
  }

  const many = () => (hits.length >= MAX_HITS ? `${MAX_HITS}+` : String(hits.length));
  function showCount(done = 0) {
    const query = input.value.trim();
    counter.classList.toggle('none', Boolean(query) && !searching && !hits.length);
    if (!query) counter.textContent = '';
    else if (noText) counter.textContent = t('reader.find.noText');
    else if (searching && !hits.length) counter.textContent = t('reader.find.searching', Math.round(done * 100));
    else if (!hits.length) counter.textContent = t('reader.find.none');
    else counter.textContent = t('reader.find.count', now + 1, many()) + (searching ? '…' : '');
    prevButton.disabled = nextButton.disabled = !hits.length || (hits.length === 1 && now === 0);
    listButton.disabled = !hits.length;
  }

  function where(hit) {
    if (hit.page) return t('reader.find.page', hit.page);
    return hit.heading || '';
  }

  function fillList() {
    if (list.hidden) return;
    listHead.textContent = hits.length ? t('reader.find.listHead', many()) : t('reader.find.none');
    listItems.replaceChildren(
      ...hits.slice(0, LIST_MAX).map((hit, i) =>
        h(
          'li',
          { class: `rd-find-item${i === now ? ' now' : ''}` },
          h(
            'button',
            {
              type: 'button',
              onclick: () => {
                go(i);
                // on a phone the list covers the page: get out of the way of the place found
                if (innerWidth < 700) toggleList(false);
              },
            },
            where(hit) ? h('span', { class: 'rd-find-where' }, where(hit)) : null,
            h('span', { class: 'rd-find-snippet' }, hit.before, h('mark', {}, hit.text), hit.after),
          ),
        ),
      ),
      hits.length > LIST_MAX ? h('li', { class: 'rd-toc-empty' }, t('reader.find.more', hits.length - LIST_MAX)) : null,
    );
  }

  function toggleList(show = list.hidden) {
    if (show && !hits.length) return;
    if (show) onList?.();
    list.hidden = !show;
    listButton.classList.toggle('on', show);
    fillList();
    if (show) list.querySelector('.now button, button')?.scrollIntoView({ block: 'nearest' });
  }

  function go(i) {
    const controller = getController();
    if (!controller || !hits[i]) return;
    now = i;
    controller.showFound(i);
    showCount();
    if (!list.hidden) {
      list.querySelectorAll('.rd-find-item.now').forEach((li) => li.classList.remove('now'));
      const li = listItems.children[i];
      li?.classList.add('now');
      li?.scrollIntoView({ block: 'nearest' });
    }
  }

  /** The first match at or after the place being read. */
  function nearest(here, final) {
    const i = hits.findIndex((hit) => hit.place >= here);
    return i >= 0 ? i : final && hits.length ? 0 : -1;
  }

  async function search() {
    clearTimeout(timer);
    const controller = getController();
    const query = input.value;
    searched = query;
    const mine = ++run;
    hits = [];
    now = -1;
    noText = false;
    if (!controller?.find || !query.trim()) {
      controller?.clearFind?.();
      searching = false;
      progress.hidden = true;
      showCount();
      toggleList(false);
      return;
    }
    const pos = controller.position();
    const here = pos?.page ?? pos?.at ?? 0;
    searching = true;
    showCount();
    const jump = (final) => {
      if (now >= 0) return;
      const i = nearest(here, final);
      if (i >= 0) go(i);
    };
    const result = await controller.find(query, ({ done, total, hits: sofar }) => {
      if (mine !== run) return;
      hits = sofar;
      progress.hidden = false;
      bar_.style.width = `${(done / total) * 100}%`;
      jump(false);
      showCount(done / total);
    });
    if (mine !== run || !result) return;
    hits = result.hits;
    noText = Boolean(result.noText);
    searching = false;
    progress.hidden = true;
    jump(true);
    showCount();
    if (!hits.length) toggleList(false);
    else fillList();
  }

  function step(dir) {
    if (input.value !== searched || timer) return search();
    if (!hits.length) return;
    go(now < 0 ? nearest(0, true) : (now + dir + hits.length) % hits.length);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    // a long document is searched once the typing pauses
    timer = setTimeout(() => {
      timer = 0;
      search();
    }, 220);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'F3') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else return;
    e.stopPropagation();
  });

  function open() {
    if (!getController()) return;
    const was = bar.hidden;
    bar.hidden = false;
    reader.classList.add('finding');
    input.focus();
    input.select();
    if (was && input.value.trim()) search();
  }

  function close({ keepText = true } = {}) {
    clearTimeout(timer);
    timer = 0;
    run++;
    const wasOpen = !bar.hidden;
    bar.hidden = true;
    list.hidden = true;
    reader.classList.remove('finding');
    getController()?.clearFind?.();
    hits = [];
    now = -1;
    searching = false;
    noText = false;
    searched = '';
    progress.hidden = true;
    if (!keepText) input.value = '';
    showCount();
    if (wasOpen && reader.contains(document.activeElement)) reader.querySelector('.rd-scroll')?.focus({ preventScroll: true });
    return wasOpen;
  }

  return {
    bar,
    list,
    localize,
    open,
    close,
    isOpen: () => !bar.hidden,
    hideList: () => toggleList(false),
    listOpen: () => !list.hidden,
    /** F3 / Shift+F3 from anywhere in the reader. */
    step: (dir) => (bar.hidden ? open() : step(dir)),
  };
}

// The notes screen: what the Notes tab opens. Folders on top (All, each folder, No folder, + New
// folder), the notes of the chosen one below as cards (title, a piece of the text, the date), a search
// and a New note button. A tap opens a note; a long press (or right click) on a folder renames or
// removes it, on a note moves it to a folder or deletes it. Folders: noteFolders.js.

import { h, toast, confirmDialog, showMenu, openDialog } from './overlays.js';
import { count, currentLocale, t } from './i18n.js';
import { ALL, NONE, addFolder, folderCounts, folderList, inFolder, pickNotes, preview, renameFolder } from './noteFolders.js';

/**
 * getNotes(): [{ id, content, updated, folder }]; getSaved() / saveFolders(list): the folder list in
 * the app's state; moveNote(id, folder) and deleteNote(id) (→ true when it went) do the storage;
 * onOpen(id); onCreate(folder); onBack().
 */
export function createNotesScreen({ getNotes, getSaved, saveFolders, moveNote, deleteNote, onOpen, onCreate, onBack }) {
  let folder = ALL;
  let query = '';

  const backButton = h(
    'button',
    {
      type: 'button',
      class: 'tb-btn icon notes-back',
      onclick: () => onBack(),
    },
    '←',
  );
  const heading = h('span', { class: 'notes-heading-text' });
  const counter = h('span', { class: 'notes-count' });
  const search = h('input', {
    class: 'field notes-search',
    type: 'search',
    spellcheck: 'false',
  });
  // a new note leads the folder row and stays where it is while the folders scroll beside it
  const newLabel = h('span', { class: 'notes-new-text' });
  const newNote = h('button', { type: 'button', class: 'lib-chip notes-new', onclick: () => onCreate(folderForNew()) }, h('span', { 'aria-hidden': 'true' }, '＋'), newLabel);
  const chips = h('div', { class: 'lib-chips notes-chips', role: 'tablist' });
  const list = h('ol', { class: 'notes-list' });
  const empty = h('div', { class: 'notes-empty', hidden: true });
  const node = h(
    'section',
    { class: 'notes-screen', hidden: true },
    h('header', { class: 'notes-head' }, backButton, h('h2', { class: 'notes-heading' }, heading, counter)),
    h('div', { class: 'notes-body' }, search, h('div', { class: 'notes-chip-row' }, newNote, chips), list, empty),
  );

  search.addEventListener('input', () => {
    query = search.value;
    drawList();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.stopPropagation();
      search.value = '';
      query = '';
      drawList();
    }
  });

  const folders = () => folderList(getSaved(), getNotes());
  const folderForNew = () => (folder === ALL || folder === NONE ? '' : folder);

  function render() {
    const names = folders();
    if (folder !== ALL && folder !== NONE && !names.includes(folder)) folder = ALL;
    heading.textContent = t('notesScreen.title');
    backButton.title = t('notesScreen.back');
    backButton.setAttribute('aria-label', t('notesScreen.back'));
    search.placeholder = t('notesScreen.search');
    search.setAttribute('aria-label', t('notesScreen.search'));
    newLabel.textContent = t('notesScreen.newNote');
    newNote.title = t('notesScreen.newNote');
    drawChips(names);
    drawList();
  }

  function drawChips(names) {
    const counts = folderCounts(getNotes(), names);
    const chip = (label, key, { menu = false } = {}) => {
      const node = h(
        'button',
        {
          type: 'button',
          class: 'lib-chip notes-chip',
          role: 'tab',
          'aria-selected': String(folder === key),
          onclick: () => {
            folder = key;
            render();
          },
        },
        h('span', { class: 'notes-chip-name' }, label),
        h('span', { class: 'notes-chip-count' }, String(counts[key] ?? 0)),
      );
      if (menu) {
        // a long press (or right click) on a folder: rename it, remove it
        node.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          folderMenu(key, e.clientX, e.clientY);
        });
      }
      return node;
    };
    if (!names.length && folder === NONE) folder = ALL;
    // a new folder is the rarer thing: at the end of the row
    chips.replaceChildren(
      ...[
        chip(t('notesScreen.all'), ALL),
        ...names.map((name) => chip(name, name, { menu: true })),
        counts[NONE] && names.length ? chip(t('notesScreen.none'), NONE) : null,
        h('button', { type: 'button', class: 'lib-chip add', onclick: () => newFolder() }, '＋ ', t('notesScreen.newFolder')),
      ].filter(Boolean),
    );
  }

  function drawList() {
    const names = folders();
    const all = getNotes();
    const shown = pickNotes(all, { folder, folders: names, query });
    counter.textContent = count(all.length, 'note');
    list.replaceChildren(...shown.map((note) => card(note, names)));
    empty.hidden = shown.length > 0;
    if (!shown.length) {
      empty.replaceChildren(
        ...[
          h('span', { class: 'notes-empty-art', 'aria-hidden': 'true' }, query ? '⌕' : '✎'),
          h('p', {}, query ? t('notesScreen.nothingFound') : folder === ALL ? t('notesScreen.noNotes') : t('notesScreen.emptyFolder')),
          query
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  class: 'btn primary',
                  onclick: () => onCreate(folderForNew()),
                },
                t('notesScreen.newNote'),
              ),
        ].filter(Boolean),
      );
    }
  }

  function card(note, names) {
    const { title, snippet } = preview(note.content);
    const own = names.find((n) => inFolder(note, n));
    const button = h(
      'button',
      { type: 'button', class: 'notes-card', onclick: () => onOpen(note.id) },
      h('span', { class: 'notes-card-title' }, title || t('untitled')),
      snippet ? h('span', { class: 'notes-card-snippet' }, snippet) : null,
      h(
        'span',
        { class: 'notes-card-foot' },
        h('span', { class: 'notes-card-when' }, when(note.updated)),
        own && folder === ALL ? h('span', { class: 'notes-card-folder' }, own) : null,
      ),
    );
    button.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      noteMenu(note, e.clientX, e.clientY);
    });
    return h('li', {}, button);
  }

  /** A folder name, asked in a small dialog; null when cancelled. */
  function askName({ title, value = '' }) {
    return new Promise((resolve) => {
      openDialog(
        (box, close) => {
          const input = h('input', {
            class: 'field',
            type: 'text',
            maxlength: '60',
            'data-autofocus': true,
            'aria-label': title,
          });
          input.value = value;
          const done = () => close(input.value);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              done();
            }
          });
          box.append(
            h('div', { class: 'modal-kicker' }, t('notesScreen.title')),
            h('h2', { class: 'modal-title' }, title),
            input,
            h(
              'div',
              { class: 'modal-actions' },
              h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, t('dialog.cancel')),
              h('button', { type: 'button', class: 'btn primary', onclick: done }, t('notesScreen.save')),
            ),
          );
        },
        { onClose: (v) => resolve(typeof v === 'string' ? v : null) },
      );
    });
  }

  async function newFolder() {
    const name = await askName({ title: t('notesScreen.newFolder') });
    if (name === null) return null;
    const next = addFolder(folders(), name);
    if (!next) {
      if (name.trim()) toast(t('notesScreen.folderTaken'));
      return null;
    }
    await saveFolders(next);
    folder = next[next.length - 1];
    render();
    return folder;
  }

  function folderMenu(name, x, y) {
    showMenu(x, y, [
      { header: name },
      {
        icon: '✎',
        text: t('notesScreen.renameFolder'),
        run: async () => {
          const to = await askName({
            title: t('notesScreen.renameFolder'),
            value: name,
          });
          if (to === null) return;
          const before = folders();
          const next = renameFolder(before, name, to);
          if (!next) {
            toast(t('notesScreen.folderTaken'));
            return;
          }
          const renamed = next[before.indexOf(name)];
          await saveFolders(next);
          for (const note of getNotes().filter((n) => inFolder(n, name))) await moveNote(note.id, renamed);
          if (folder === name) folder = renamed;
          render();
        },
      },
      {
        icon: '✕',
        text: t('notesScreen.removeFolder'),
        className: 'danger',
        run: async () => {
          const inside = getNotes().filter((n) => inFolder(n, name));
          const ok = await confirmDialog({
            kicker: t('notesScreen.title'),
            title: t('notesScreen.removeFolderTitle', name),
            text: inside.length ? t('notesScreen.removeFolderText', count(inside.length, 'note')) : '',
            ok: t('notesScreen.removeOk'),
            danger: true,
          });
          if (!ok) return;
          await saveFolders(folders().filter((n) => n !== name));
          for (const note of inside) await moveNote(note.id, '');
          if (folder === name) folder = ALL;
          render();
        },
      },
    ]);
  }

  function noteMenu(note, x, y) {
    const title = preview(note.content).title || t('untitled');
    showMenu(x, y, [
      { header: title },
      { icon: '↗', text: t('notesScreen.open'), run: () => onOpen(note.id) },
      {
        icon: '⇄',
        text: t('notesScreen.moveTo'),
        run: () => moveMenu(note, x, y),
      },
      '-',
      {
        icon: '✕',
        text: t('notesScreen.delete'),
        className: 'danger',
        run: async () => {
          if (await deleteNote(note.id)) render();
        },
      },
    ]);
  }

  function moveMenu(note, x, y) {
    const names = folders();
    const move = async (name) => {
      await moveNote(note.id, name);
      render();
      const title = preview(note.content).title || t('untitled');
      toast(name ? t('notesScreen.moved', title, name) : t('notesScreen.unfiled', title));
    };
    showMenu(x, y, [
      { header: t('notesScreen.moveTo') },
      ...names.map((name) => ({
        icon: inFolder(note, name) ? '✓' : '',
        text: name,
        run: () => move(name),
      })),
      {
        icon: inFolder(note, NONE, names) ? '✓' : '',
        text: t('notesScreen.none'),
        run: () => move(''),
      },
      '-',
      {
        icon: '＋',
        text: t('notesScreen.newFolder'),
        run: async () => {
          const name = await newFolder();
          if (name) await move(name);
        },
      },
    ]);
  }

  return {
    node,
    isOpen: () => !node.hidden,
    /** Shows the screen, on the folder chosen last. */
    show({ focus = true } = {}) {
      render();
      node.hidden = false;
      if (focus)
        (node.querySelector('.notes-card') ?? search).focus({
          preventScroll: true,
        });
    },
    hide() {
      node.hidden = true;
    },
    /** Draws it again, if it shows (notes came from sync, the language changed). */
    refresh() {
      if (!node.hidden) render();
    },
  };
}

function when(time) {
  if (!time) return '';
  const date = new Date(time);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(
    currentLocale(),
    sameDay ? { hour: '2-digit', minute: '2-digit' } : sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'short', year: 'numeric' },
  ).format(date);
}

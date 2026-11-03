// The trash: notes, documents, and the marks, comments, bookmarks and texts taken out of documents.
// Everything in it is whole and comes back at any time, on every device that syncs; deleting for good
// happens only here, and asks once more (a second tap) before it does.

import { h, openDialog, toast } from './overlays.js';
import { formatDay, formatTime, t } from './i18n.js';
import { analyze } from './markdown.js';

const TABS = ['notes', 'docs', 'marks'];
const ARMED_FOR = 4000; // a "delete for good" button waits this long for its second tap

/**
 * A button that asks once more: the first tap shows `question()`, a second one within a few seconds
 * does `run`. (A dialog over the trash's own dialog would fight it for Esc.)
 */
function confirmButton({ label, idle = '✕', question, run, className = 'trash-act danger' }) {
  const button = h('button', { type: 'button', class: className, title: label, 'aria-label': label }, idle);
  let timer = 0;
  button.addEventListener('click', async () => {
    if (!button.dataset.armed) {
      button.dataset.armed = '1';
      button.textContent = question();
      timer = setTimeout(() => {
        delete button.dataset.armed;
        button.textContent = idle;
      }, ARMED_FOR);
      return;
    }
    clearTimeout(timer);
    delete button.dataset.armed;
    button.disabled = true;
    await run();
    // still there (it did not go, or it is the "empty" button): ready again
    button.disabled = false;
    button.textContent = idle;
  });
  return button;
}

/**
 * getNotes(): the notes in the trash; restoreNote / purgeNote(id) → true when done.
 * library: trashContent(), restoreDoc / purgeDoc(id), restoreItem / purgeItem(docId, kind, id); or null.
 */
export function createTrash({ getNotes, restoreNote, purgeNote, library }) {
  let redraw = null;
  const newest = (a, b) => (b.trashed ?? 0) - (a.trashed ?? 0);
  const when = (ms) => (ms ? t('trash.deletedAt', `${formatDay(ms)}, ${formatTime(ms)}`) : '');

  async function gather() {
    const lib = library ? await library.trashContent().catch(() => ({ docs: [], items: [] })) : { docs: [], items: [] };
    return {
      notes: getNotes().sort(newest),
      docs: lib.docs.sort(newest),
      marks: lib.items.sort((a, b) => newest(a.item, b.item)),
    };
  }

  function row({ icon, color, title, lines, onRestore, onPurge }) {
    const restore = h('button', { type: 'button', class: 'trash-act', title: t('trash.restore'), 'aria-label': t('trash.restore') }, '↺');
    restore.addEventListener('click', async () => {
      restore.disabled = true;
      if (await onRestore()) redraw?.();
      else restore.disabled = false;
    });
    const purge = confirmButton({
      label: t('trash.purge'),
      question: () => t('trash.purge'),
      run: async () => {
        if (await onPurge()) redraw?.();
      },
    });
    return h(
      'li',
      { class: 'trash-item' },
      h('span', { class: 'trash-icon', 'aria-hidden': 'true', ...(color ? { 'data-color': color } : {}) }, icon),
      h('span', { class: 'trash-body' }, h('span', { class: 'trash-title' }, title), ...lines.filter(Boolean).map((line) => h('span', { class: 'trash-meta' }, line))),
      h('span', { class: 'trash-acts' }, restore, purge),
    );
  }

  const noteRow = (note) => {
    const info = analyze(note.content);
    return row({
      icon: '✎',
      title: info.title || t('untitled'),
      lines: [info.excerpt, [note.folder, when(note.trashed)].filter(Boolean).join(' · ')],
      onRestore: () => restoreNote(note.id),
      onPurge: () => purgeNote(note.id),
    });
  };

  const docRow = (doc) =>
    row({
      icon: '▥',
      title: doc.title,
      lines: [doc.author, when(doc.trashed)],
      onRestore: () => library.restoreDoc(doc.id),
      onPurge: () => library.purgeDoc(doc.id),
    });

  const itemRow = ({ docId, docTitle, kind, item }) => {
    const book = `${t('trash.inBook', docTitle)} · ${when(item.trashed)}`;
    const restore = () => library.restoreItem(docId, kind, item.id);
    const purge = () => library.purgeItem(docId, kind, item.id);
    if (kind === 'mark') {
      return row({ icon: '●', color: item.color, title: item.text, lines: [item.note ? `💬 ${item.note}` : '', book], onRestore: restore, onPurge: purge });
    }
    if (kind === 'bookmark') return row({ icon: '🔖', title: item.snippet || item.label, lines: [item.label, book], onRestore: restore, onPurge: purge });
    return row({ icon: 'T', title: item.text, lines: [t('trash.text'), book], onRestore: restore, onPurge: purge });
  };

  function open(tab = 'notes') {
    let active = TABS.includes(tab) ? tab : 'notes';
    openDialog(
      (box, close) => {
        const tabs = h('div', { class: 'seg trash-tabs', role: 'tablist' });
        const list = h('ul', { class: 'trash-list' });
        let content = { notes: [], docs: [], marks: [] };
        const total = () => content.notes.length + content.docs.length + content.marks.length;
        const emptyAll = confirmButton({
          label: t('trash.emptyAll'),
          idle: t('trash.emptyAll'),
          className: 'btn danger trash-empty',
          question: () => t('trash.emptyAllTitle', total()),
          // everything in the trash right now, deleted for good one by one
          run: async () => {
            for (const note of content.notes) await purgeNote(note.id);
            for (const doc of content.docs) await library.purgeDoc(doc.id);
            for (const { docId, kind, item } of content.marks) await library.purgeItem(docId, kind, item.id);
            toast(t('trash.empty'));
            await redraw?.();
          },
        });

        async function draw() {
          content = await gather();
          tabs.replaceChildren(
            ...TABS.map((id) =>
              h(
                'button',
                {
                  type: 'button',
                  class: 'seg-btn',
                  role: 'tab',
                  'aria-selected': String(active === id),
                  onclick: () => {
                    active = id;
                    draw();
                  },
                },
                `${t(`trash.${id}`)}${content[id].length ? ` · ${content[id].length}` : ''}`,
              ),
            ),
          );
          const rows = active === 'notes' ? content.notes.map(noteRow) : active === 'docs' ? content.docs.map(docRow) : content.marks.map(itemRow);
          list.replaceChildren(...(rows.length ? rows : [h('li', { class: 'trash-none' }, total() ? t('trash.emptyTab') : t('trash.empty'))]));
          emptyAll.disabled = !total();
        }

        if (!library) tabs.hidden = true;
        box.append(
          h('div', { class: 'modal-kicker' }, t('trash.title')),
          h('p', { class: 'modal-text trash-hint' }, t('trash.hint')),
          tabs,
          list,
          h('div', { class: 'modal-actions' }, emptyAll, h('button', { type: 'button', class: 'btn primary', onclick: () => close(null), 'data-autofocus': true }, t('settings.done'))),
        );
        redraw = draw;
        draw();
      },
      { className: 'modal-trash', onClose: () => (redraw = null) },
    );
  }

  return {
    open,
    /** Something went in or out of the trash elsewhere: an open trash shows it. */
    refresh: () => redraw?.(),
  };
}

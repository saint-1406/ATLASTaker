// Tags: #word in a note's text. A selected passage is marked by putting its tag right after it; the
// list of tags gathers them from every note, and a tag leads to the lines it stands on. Tags live in
// the text itself, so they travel with the notes (sync, backups, other editors) and need no store.

import { h, openDialog, toast } from './overlays.js';
import { count, t } from './i18n.js';
import { toText } from './exporters.js';

// # and a word, at the start of a line or after a space or a bracket (not a URL's #part, not a
// heading: "# Title" has a space after #)
export const TAG_RE = /(^|[\s([{«"])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;

/** A tag as typed, made a tag: no #, spaces become _, only letters, digits, _ - / kept. */
export function normalizeTag(text) {
  return String(text ?? '')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_\-/]/gu, '')
    .slice(0, 60);
}

/** The tags of a text, outside code: [{ tag, line (from 0), text: that line }]. */
export function tagsIn(text) {
  const found = [];
  let fence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fence = !fence;
      return;
    }
    if (fence || !line.includes('#')) return;
    const prose = line.replace(/`[^`]*`/g, (code) => ' '.repeat(code.length)); // inline code is not tagged
    for (const m of prose.matchAll(TAG_RE)) found.push({ tag: m[2], line: i, text: line.trim() });
  });
  return found;
}

/**
 * Every tag of the notes, most used first: [{ tag, places: [{ id, title, line, text }] }]. Tags that
 * differ only in case are one ("#Work" and "#work").
 */
export function collectTags(notes) {
  const byKey = new Map();
  for (const note of notes) {
    for (const place of tagsIn(note.content)) {
      const key = place.tag.toLocaleLowerCase();
      if (!byKey.has(key)) byKey.set(key, { tag: place.tag, places: [] });
      byKey.get(key).places.push({ id: note.id, title: note.title, line: place.line, text: place.text });
    }
  }
  return [...byKey.values()].sort((a, b) => b.places.length - a.places.length || a.tag.localeCompare(b.tag));
}

/** Asks for a tag (the ones in use offered as chips); resolves with it, or null. */
export function askTag({ tags, initial = '' }) {
  return new Promise((resolve) => {
    openDialog(
      (box, close) => {
        const input = h('input', { class: 'field', type: 'text', maxlength: '60', placeholder: t('tags.placeholder'), 'data-autofocus': true, 'aria-label': t('tags.ask') });
        input.value = initial;
        const done = (value = input.value) => {
          const tag = normalizeTag(value);
          if (!tag) {
            toast(t('tags.bad'));
            return;
          }
          close(tag);
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            done();
          }
        });
        box.append(
          h('div', { class: 'modal-kicker' }, t('tags.title')),
          h('h2', { class: 'modal-title' }, t('tags.ask')),
          h('p', { class: 'modal-text' }, t('tags.askText')),
          input,
          tags.length ? h('div', { class: 'tag-chips' }, tags.slice(0, 30).map(({ tag }) => h('button', { type: 'button', class: 'tag-chip', onclick: () => done(tag) }, `#${tag}`))) : null,
          h(
            'div',
            { class: 'modal-actions' },
            h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, t('dialog.cancel')),
            h('button', { type: 'button', class: 'btn primary', onclick: () => done() }, t('tags.add')),
          ),
        );
      },
      { onClose: (v) => resolve(typeof v === 'string' ? v : null) },
    );
  });
}

/** The list of tags; a tag shows where it stands, a place opens there (onOpen(id, line)). */
export function openTags({ tags, onOpen }) {
  openDialog(
    (box, close) => {
      const body = h('div', { class: 'tags-body' });
      const heading = h('h2', { class: 'modal-title' }, t('tags.title'));
      const back = h('button', { type: 'button', class: 'btn', hidden: true }, t('tags.back'));

      function all() {
        heading.textContent = t('tags.title');
        back.hidden = true;
        body.replaceChildren(
          tags.length
            ? h(
                'div',
                { class: 'tag-chips' },
                tags.map((entry) => h('button', { type: 'button', class: 'tag-chip', onclick: () => one(entry) }, `#${entry.tag}`, h('span', { class: 'tag-count' }, String(entry.places.length)))),
              )
            : h('p', { class: 'modal-text' }, t('tags.none')),
        );
      }

      function one(entry) {
        heading.textContent = `#${entry.tag}`;
        back.hidden = false;
        body.replaceChildren(
          h('p', { class: 'tags-found' }, t('tags.found', count(entry.places.length, 'line'))),
          h(
            'ol',
            { class: 'tag-places' },
            entry.places.map((place) =>
              h(
                'li',
                {},
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'tag-place',
                    onclick: () => {
                      close(null);
                      onOpen(place.id, place.line);
                    },
                  },
                  h('span', { class: 'tag-place-title' }, place.title || t('untitled')),
                  h('span', { class: 'tag-place-line' }, toText(place.text).trim()),
                ),
              ),
            ),
          ),
        );
      }

      back.addEventListener('click', all);
      box.append(h('div', { class: 'modal-kicker' }, t('noteMenu.title')), heading, body, h('div', { class: 'modal-actions' }, back, h('button', { type: 'button', class: 'btn primary', 'data-autofocus': true, onclick: () => close(null) }, t('versions.close'))));
      all();
    },
    { className: 'modal-tags' },
  );
}

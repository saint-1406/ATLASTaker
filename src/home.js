// The main page: what the app opens on. A greeting, the book read last, the notes, and the way to the
// library, so the person picks where to go. The avatar (top right) opens the menu, as in the notes.

import { h } from './overlays.js';
import { count, currentLocale, t } from './i18n.js';

/** The person's picture, their initial, or a plain figure: for the header and the main page. */
export function avatarNode({ avatar, name }, size = 32) {
  const node = h('span', { class: 'avatar', style: `--avatar: ${size}px`, 'aria-hidden': 'true' });
  if (avatar) node.append(h('img', { src: avatar, alt: '' }));
  else if (name?.trim()) node.append(h('span', { class: 'avatar-letter' }, name.trim()[0].toUpperCase()));
  else node.innerHTML = '<svg viewBox="0 0 16 16"><circle cx="8" cy="5.6" r="2.7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.8 14c.6-2.9 2.7-4.3 5.2-4.3s4.6 1.4 5.2 4.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  return node;
}

/** A picture the person picked, made small and square (a JPEG data: URL), for the avatar. */
export async function shrinkPicture(file, size = 160) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}

function greeting(name) {
  const hour = new Date().getHours();
  const part = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'day' : 'evening';
  return name?.trim() ? t(`home.hello.${part}Name`, name.trim()) : t(`home.hello.${part}`);
}

/**
 * ctx: { profile: { avatar, name }, notes: [{ id, title, updated }] newest first, shelf: { count, last },
 * onMenu(), onNote(id), onNewNote(), onLibrary(), onBook(id), onAddBook() }
 */
export function drawHome(root, ctx) {
  const { profile, notes, shelf } = ctx;
  const today = new Intl.DateTimeFormat(currentLocale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const last = shelf?.last;
  const pct = (v) => `${Math.round(Math.min(1, Math.max(0, v || 0)) * 100)}%`;

  const book = last
    ? h(
        'button',
        { type: 'button', class: 'home-card home-book', onclick: () => ctx.onBook(last.id) },
        last.cover ? h('img', { class: 'home-cover', src: last.cover, alt: '' }) : h('span', { class: 'home-cover home-cover-blank' }, last.format.toUpperCase()),
        h(
          'span',
          { class: 'home-card-text' },
          h('span', { class: 'home-kicker' }, t('home.continue')),
          h('span', { class: 'home-card-title' }, last.name),
          last.author ? h('span', { class: 'home-card-sub' }, last.author) : null,
          h('span', { class: 'home-progress', 'aria-hidden': 'true' }, h('i', { style: `width: ${pct(last.progress)}` })),
          h('span', { class: 'home-card-sub' }, t('home.read', pct(last.progress))),
        ),
      )
    : h(
        'button',
        { type: 'button', class: 'home-card home-book empty', onclick: () => ctx.onAddBook() },
        h('span', { class: 'home-cover home-cover-blank' }, '＋'),
        h('span', { class: 'home-card-text' }, h('span', { class: 'home-kicker' }, t('home.library')), h('span', { class: 'home-card-title' }, t('home.addFirst'))),
      );

  const tile = (glyph, title, sub, run, cls = '') =>
    h('button', { type: 'button', class: `home-tile ${cls}`.trim(), onclick: run }, h('span', { class: 'home-tile-ico', 'aria-hidden': 'true' }, glyph), h('span', { class: 'home-tile-title' }, title), sub ? h('span', { class: 'home-tile-sub' }, sub) : null);

  const recent = notes.slice(0, 5).map((n) =>
    h('li', {}, h('button', { type: 'button', class: 'home-note', onclick: () => ctx.onNote(n.id) }, h('span', { class: 'home-note-title' }, n.title), h('span', { class: 'home-note-when' }, when(n.updated)))),
  );

  root.replaceChildren(
    h(
      'div',
      { class: 'home-top' },
      h('button', { type: 'button', class: 'home-avatar', title: t('chrome.menuKey'), 'aria-label': t('chrome.menu'), onclick: () => ctx.onMenu() }, avatarNode(profile, 36)),
    ),
    h(
      'div',
      { class: 'home-body' },
      h('p', { class: 'home-date' }, today),
      h('h1', { class: 'home-hello' }, greeting(profile.name)),
      h('p', { class: 'home-ask' }, t('home.ask')),
      book,
      h(
        'div',
        { class: 'home-tiles' },
        tile('✎', t('home.notes'), count(notes.length, 'note'), () => ctx.onNote(notes[0]?.id ?? null)),
        tile('＋', t('home.newNote'), t('home.newNoteSub'), () => ctx.onNewNote(), 'accent'),
        tile('▥', t('home.library'), shelf ? count(shelf.count, 'doc') : '', () => ctx.onLibrary()),
        tile('⇡', t('home.addBook'), t('home.addBookSub'), () => ctx.onAddBook()),
      ),
      recent.length ? h('section', { class: 'home-recent' }, h('h2', {}, t('home.recent')), h('ol', {}, recent)) : null,
    ),
  );
}

function when(time) {
  if (!time) return '';
  const date = new Date(time);
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(currentLocale(), sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' }).format(date);
}

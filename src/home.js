// The main page: what the app opens on. A short greeting, the book read last with a play button, today's
// reading goal, the newest books, the library's sections and the latest notes; the person picks where
// to go. The avatar (top right) opens the menu, as in the notes; the tab bar sits at the bottom.

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

// ---------- reading days: minutes read per day, for the goal and the streak ----------

/** "YYYY-MM-DD" of a moment, in local time. */
export const dayKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** Adds minutes to a day; keeps the last `keep` days only. */
export function addReading(days, minutes, date = new Date(), keep = 45) {
  const out = { ...(days ?? {}) };
  const key = dayKey(date);
  out[key] = Math.round(((out[key] ?? 0) + minutes) * 100) / 100;
  const cutoff = new Date(date);
  cutoff.setDate(cutoff.getDate() - keep);
  for (const k of Object.keys(out)) if (k < dayKey(cutoff)) delete out[k];
  return out;
}

/** Days in a row with some reading, up to today (or yesterday, while today has none yet). */
export function streakOf(days, date = new Date()) {
  const has = (d) => (days?.[dayKey(d)] ?? 0) >= 1;
  const day = new Date(date);
  if (!has(day)) day.setDate(day.getDate() - 1);
  let n = 0;
  while (has(day) && n < 400) {
    n++;
    day.setDate(day.getDate() - 1);
  }
  return n;
}

export const GOALS = [10, 15, 20, 30, 45, 60];

function greeting(name) {
  const hour = new Date().getHours();
  const part = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'day' : 'evening';
  return name?.trim() ? t(`home.hello.${part}Name`, name.trim()) : t(`home.hello.${part}`);
}

const pct = (v) => `${Math.round(Math.min(1, Math.max(0, v || 0)) * 100)}%`;

/**
 * ctx: { profile: { avatar, name }, notes: [{ id, title, updated }] newest first,
 * shelf: { count, last, shelves: [{ name, count }], recent: [book] } | null,
 * reading: { today (minutes), goal (minutes), streak (days) },
 * onMenu(), onNote(id), onNewNote(), onLibrary(), onBook(id), onAddBook(), onShelf(name), onGoal(anchor) }
 */
export function drawHome(root, ctx) {
  const { profile, notes, shelf, reading } = ctx;
  const last = shelf?.last;

  const book = last
    ? h(
        'div',
        { class: 'home-card home-book' },
        h(
          'button',
          { type: 'button', class: 'home-book-open', onclick: () => ctx.onBook(last.id), 'aria-label': `${t('home.continue')}: ${last.name}` },
          last.cover ? h('img', { class: 'home-cover', src: last.cover, alt: '' }) : h('span', { class: 'home-cover home-cover-blank' }, last.format.toUpperCase()),
          h(
            'span',
            { class: 'home-card-text' },
            h('span', { class: 'home-kicker' }, t('home.continue')),
            h('span', { class: 'home-card-title' }, last.name),
            last.author ? h('span', { class: 'home-card-sub' }, last.author) : null,
            // the streak sits in the text, under the author: it used to float over long titles
            reading.streak ? h('span', { class: 'home-streak', title: t('home.streakTitle') }, h('span', { 'aria-hidden': 'true' }, '🔥 '), t('home.streak', reading.streak)) : null,
            h('span', { class: 'home-progress-row' }, h('span', { class: 'home-progress', 'aria-hidden': 'true' }, h('i', { style: `width: ${pct(last.progress)}` })), h('span', { class: 'home-pct' }, pct(last.progress))),
          ),
        ),
        h('button', { type: 'button', class: 'home-play', title: t('home.continue'), 'aria-label': t('home.continue'), onclick: () => ctx.onBook(last.id) }, h('span', { 'aria-hidden': 'true' }, '▶')),
      )
    : h(
        'button',
        { type: 'button', class: 'home-card home-book empty', onclick: () => ctx.onAddBook() },
        h('span', { class: 'home-cover home-cover-blank' }, '＋'),
        h('span', { class: 'home-card-text' }, h('span', { class: 'home-kicker' }, t('home.library')), h('span', { class: 'home-card-title' }, t('home.addFirst'))),
      );

  const done = Math.min(reading.today, reading.goal);
  const goal = h(
    'button',
    { type: 'button', class: 'home-card home-goal', title: t('home.goalChange'), onclick: (e) => ctx.onGoal(e.currentTarget) },
    h(
      'span',
      { class: 'home-goal-text' },
      h('span', { class: 'home-goal-head' }, h('span', { class: 'home-goal-ico', 'aria-hidden': 'true' }, '◎'), t('home.goal')),
      h('span', { class: 'home-goal-what' }, t('home.goalWhat', reading.goal)),
      h(
        'span',
        { class: 'home-progress-row' },
        h('span', { class: 'home-progress warm', 'aria-hidden': 'true' }, h('i', { style: `width: ${pct(done / reading.goal)}` })),
        h('span', { class: 'home-goal-count' }, t('home.goalCount', Math.floor(reading.today), reading.goal)),
      ),
    ),
    h('span', { class: 'home-goal-art', 'aria-hidden': 'true' }, reading.today >= reading.goal ? '🏆' : '☕'),
  );

  const recentBooks = (shelf?.recent ?? []).slice(0, 10);
  const books = recentBooks.length
    ? h(
        'section',
        { class: 'home-section' },
        h('div', { class: 'home-section-head' }, h('h2', {}, t('home.newBooks')), h('button', { type: 'button', class: 'home-see-all', onclick: () => ctx.onLibrary() }, t('home.seeAll'), ' ›')),
        h(
          'div',
          { class: 'home-books' },
          recentBooks.map((b) =>
            h(
              'button',
              { type: 'button', class: 'home-mini', onclick: () => ctx.onBook(b.id) },
              b.cover ? h('img', { class: 'home-mini-cover', src: b.cover, alt: '' }) : h('span', { class: 'home-mini-cover home-cover-blank' }, b.format.toUpperCase()),
              !b.progress && !b.finished ? h('span', { class: 'home-new' }, t('home.new')) : null,
              h('span', { class: 'home-mini-title' }, b.name),
              b.author ? h('span', { class: 'home-mini-sub' }, b.author) : null,
            ),
          ),
        ),
      )
    : null;

  const sections = shelf?.shelves?.length
    ? h(
        'section',
        { class: 'home-section' },
        h('div', { class: 'home-section-head' }, h('h2', {}, t('home.sections'))),
        h(
          'div',
          { class: 'home-cats' },
          shelf.shelves.map((s) => h('button', { type: 'button', class: 'home-cat', onclick: () => ctx.onShelf(s.name) }, h('span', { class: 'home-cat-name' }, s.name), h('span', { class: 'home-cat-count' }, String(s.count)))),
        ),
      )
    : null;

  const recentNotes = notes.slice(0, 4).map((n) =>
    h('li', {}, h('button', { type: 'button', class: 'home-note', onclick: () => ctx.onNote(n.id) }, h('span', { class: 'home-note-title' }, n.title), h('span', { class: 'home-note-when' }, when(n.updated)))),
  );
  const notesBlock = h(
    'section',
    { class: 'home-section' },
    h(
      'div',
      { class: 'home-section-head' },
      h('h2', {}, t('home.notes'), h('span', { class: 'home-count' }, count(notes.length, 'note'))),
      h('button', { type: 'button', class: 'home-see-all', onclick: () => ctx.onNewNote() }, '＋ ', t('home.newNote')),
    ),
    recentNotes.length ? h('ol', { class: 'home-notes' }, recentNotes) : h('p', { class: 'home-empty' }, t('home.noNotes')),
  );

  root.replaceChildren(
    h(
      'header',
      { class: 'home-hero' },
      h(
        'div',
        { class: 'home-top' },
        h('button', { type: 'button', class: 'home-avatar', title: t('chrome.menuKey'), 'aria-label': t('chrome.menu'), onclick: () => ctx.onMenu() }, avatarNode(profile, 40)),
      ),
      h('p', { class: 'home-hello' }, greeting(profile.name), h('span', { class: 'home-spark', 'aria-hidden': 'true' }, ' ✦')),
      h('h1', { class: 'home-brand' }, 'ATLAS'),
      h('p', { class: 'home-tagline' }, t('home.tagline')),
    ),
    h('div', { class: 'home-body' }, book, goal, books, sections, notesBlock),
  );
}

function when(time) {
  if (!time) return '';
  const date = new Date(time);
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(currentLocale(), sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' }).format(date);
}

// ---------- the tab bar at the foot of the main page and the library ----------

const TAB_ICONS = {
  home: '<path d="M2.5 7.2 8 2.7l5.5 4.5V13a.8.8 0 0 1-.8.8H9.8V10H6.2v3.8H3.3a.8.8 0 0 1-.8-.8Z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>',
  library: '<path d="M2 3.4c2-.6 4-.5 6 .5v9.6c-2-1-4-1.1-6-.5ZM14 3.4c-2-.6-4-.5-6 .5v9.6c2-1 4-1.1 6-.5Z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>',
  notes: '<path d="M4 1.8h5.5L12.5 5v9.2H4Z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.3 1.9V5h3M6 8h4.5M6 10.5h3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  profile: '<circle cx="8" cy="5.4" r="2.7" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M2.8 14c.6-2.9 2.7-4.3 5.2-4.3s4.6 1.4 5.2 4.3" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>',
};
export const TABS = ['home', 'library', 'notes', 'profile'];

/** onPick(tab); returns { node, select(tab) }. */
export function createTabBar(onPick) {
  const buttons = TABS.map((tab) => {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = TAB_ICONS[tab]; // fixed markup from this file
    const label = h('span', { class: 'tabbar-label' });
    const button = h('button', { type: 'button', class: 'tabbar-btn', 'data-tab': tab, onclick: () => onPick(tab) }, icon, label);
    return button;
  });
  const node = h('nav', { class: 'tabbar', hidden: true }, buttons);
  return {
    node,
    select(tab) {
      for (const b of buttons) {
        b.lastChild.textContent = t(`home.tabs.${b.dataset.tab}`);
        b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false');
      }
    },
  };
}

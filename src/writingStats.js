// The statistics strip over a note (characters, words, sentences, paragraphs, reading time, typing
// speed) and, behind a tap on it, the writing statistics: this note, how much was written and how the
// text grew today, this week and this month, the days in a row, and a heat map of the last half year.

import { h, openDialog } from './overlays.js';
import { count, currentLocale, t } from './i18n.js';
import { heatCells, lastDays, writingStreak } from './writing.js';

const number = (n) => new Intl.NumberFormat(currentLocale()).format(Math.round(n));
const minutes = (m) => (m < 1 ? t('stats.underMinute') : t('stats.minutes', Math.round(m)));

/** The strip. onOpen(): the writing statistics. */
export function createStatsStrip({ onOpen }) {
  const node = h('button', { type: 'button', class: 'stats-strip', hidden: true, onclick: () => onOpen() });
  const cell = (key) => {
    const value = h('b', { class: 'stats-value' });
    const label = h('span', { class: 'stats-label' });
    return { key, value, label, node: h('span', { class: 'stats-cell' }, value, label) };
  };
  const cells = ['chars', 'words', 'sentences', 'paragraphs', 'read', 'pace'].map(cell);
  node.append(...cells.map((c) => c.node));

  return {
    node,
    /** stats: textStats(); pace: characters typed in the last minute. */
    update(stats, pace) {
      const values = {
        chars: number(stats.chars),
        words: number(stats.words),
        sentences: number(stats.sentences),
        paragraphs: number(stats.paragraphs),
        read: minutes(stats.readMinutes),
        pace: t('stats.perMinute', number(pace)),
      };
      for (const c of cells) {
        c.value.textContent = values[c.key];
        c.label.textContent = t(`stats.${c.key}`);
      }
      node.title = t('stats.open');
    },
  };
}

/** The writing statistics. stats: this note's textStats(); log: { writeDays, growDays }. */
export function openWritingStats({ title, stats, log }) {
  openDialog(
    (box, close) => {
      const today = new Date();
      const written = (n) => lastDays(log.writeDays, n, today);
      const grown = (n) => lastDays(log.growDays, n, today);
      const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${number(Math.abs(n))}`;
      const row = (label, a, b) => h('tr', {}, h('th', { scope: 'row' }, label), h('td', {}, a), h('td', {}, b));
      const cells = heatCells(log.writeDays, 26, today);
      const heat = h(
        'div',
        { class: 'heat', role: 'img', 'aria-label': t('stats.heatLabel') },
        ...cells.map((c) => (c ? h('i', { class: `heat-cell l${c.level}`, title: c.value ? `${c.day}: ${count(c.value, 'char')}` : c.day }) : h('i', { class: 'heat-cell none' }))),
      );
      const streak = writingStreak(log.writeDays, today);
      box.append(
        h('div', { class: 'modal-kicker' }, t('stats.title')),
        h('h2', { class: 'modal-title' }, title),
        h(
          'div',
          { class: 'stats-note' },
          ...[
            ['chars', number(stats.chars)],
            ['charsNoSpaces', number(stats.charsNoSpaces)],
            ['words', number(stats.words)],
            ['sentences', number(stats.sentences)],
            ['paragraphs', number(stats.paragraphs)],
            ['read', minutes(stats.readMinutes)],
          ].map(([key, value]) => h('span', { class: 'stats-cell' }, h('b', { class: 'stats-value' }, value), h('span', { class: 'stats-label' }, t(`stats.${key}`)))),
        ),
        h('h3', { class: 'stats-head' }, t('stats.writing')),
        h(
          'table',
          { class: 'stats-table' },
          h('thead', {}, h('tr', {}, h('th'), h('th', { scope: 'col' }, t('stats.written')), h('th', { scope: 'col' }, t('stats.grown')))),
          h('tbody', {}, row(t('stats.today'), number(written(1)), signed(grown(1))), row(t('stats.week'), number(written(7)), signed(grown(7))), row(t('stats.month'), number(written(30)), signed(grown(30)))),
        ),
        h('p', { class: 'stats-streak' }, streak ? t('stats.streak', count(streak, 'day')) : t('stats.noStreak')),
        heat,
        h('div', { class: 'heat-legend', 'aria-hidden': 'true' }, t('stats.less'), ...[0, 1, 2, 3, 4].map((l) => h('i', { class: `heat-cell l${l}` })), t('stats.more')),
        h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn primary', 'data-autofocus': true, onclick: () => close(null) }, t('settings.done'))),
      );
    },
    { className: 'modal-stats' },
  );
}

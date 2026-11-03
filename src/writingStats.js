// The statistics strip over a note (characters, words, sentences, paragraphs, reading time, typing
// speed) and, behind a tap on it, the writing statistics: this note, how much was written and how the
// text grew today, this week and this month, the days in a row, and a heat map of the last half year.

import { h, openDialog } from './overlays.js';
import { count, currentLocale, t } from './i18n.js';
import { heatCells, lastDays, writingStreak } from './writing.js';

const number = (n) => new Intl.NumberFormat(currentLocale()).format(Math.round(n));
const minutes = (m) => (m < 1 ? t('stats.underMinute') : t('stats.minutes', Math.round(m)));

// folded or open, kept on this device: a phone starts folded, its screen is narrow
const FOLDED_KEY = 'atlas-notetaker:stats-folded';
function startsFolded() {
  try {
    const kept = localStorage.getItem(FOLDED_KEY);
    if (kept !== null) return kept === '1';
  } catch {
    // only a convenience
  }
  return matchMedia('(max-width: 620px)').matches;
}

/**
 * The strip. Folded, it is one short line (words · characters · reading time); open, all six counts.
 * A tap on the counts opens the writing statistics (onOpen), the arrow folds or opens it.
 */
export function createStatsStrip({ onOpen }) {
  let folded = startsFolded();
  let last = null;
  const cell = (key) => {
    const value = h('b', { class: 'stats-value' });
    const label = h('span', { class: 'stats-label' });
    return { key, value, label, node: h('span', { class: 'stats-cell' }, value, label) };
  };
  const cells = ['chars', 'words', 'sentences', 'paragraphs', 'read', 'pace'].map(cell);
  const line = h('span', { class: 'stats-line' });
  const counts = h('button', { type: 'button', class: 'stats-counts', onclick: () => onOpen() }, line, ...cells.map((c) => c.node));
  const fold = h('button', { type: 'button', class: 'stats-fold' });
  const node = h('div', { class: 'stats-strip', hidden: true }, counts, fold);

  function draw() {
    node.classList.toggle('folded', folded);
    fold.textContent = folded ? '▾' : '▴';
    fold.title = t(folded ? 'stats.unfold' : 'stats.fold');
    fold.setAttribute('aria-label', fold.title);
    fold.setAttribute('aria-expanded', String(!folded));
    counts.title = t('stats.open');
    if (!last) return;
    const { stats, pace } = last;
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
    line.textContent = [count(stats.words, 'wordShort'), count(stats.chars, 'char'), values.read].join(' · ');
  }

  fold.addEventListener('click', () => {
    folded = !folded;
    try {
      localStorage.setItem(FOLDED_KEY, folded ? '1' : '0');
    } catch {
      // only a convenience
    }
    draw();
  });
  draw();

  return {
    node,
    /** stats: textStats(); pace: characters typed in the last minute. */
    update(stats, pace) {
      last = { stats, pace };
      draw();
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

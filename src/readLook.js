// How a reading theme reaches the screen, and the quick "Themes and settings" panel on the reading
// page: text size, scroll or pages, auto-dark, brightness, the theme cards and "Customise", which
// opens the full screen (appearance.js). The themes themselves live in skins.js.

import { h } from './overlays.js';
import { currentLocale, t } from './i18n.js';
import { BRIGHTNESS, isModified, READ_THEMES, styleVars, themeStyle, TURN_SPEED, TURNS } from './skins.js';

/** Puts a theme on a node (the reader, a card, the preview): its palette and its text style. */
export function paintTheme(node, look, id) {
  const style = themeStyle(look, id);
  node.dataset.rtheme = id;
  for (const [key, value] of Object.entries(styleVars(style))) node.style.setProperty(key, value);
  return style;
}

/**
 * The brightness of the book's words: under 1 the text colour moves towards the page colour (a PDF's
 * page is dimmed instead). Panels and the rest of the app keep the theme's colours. A CSS variable on
 * the reader, so a page turn's picture of the page (pager.js) is dimmed too.
 */
export function setDim(node, bright) {
  node.style.setProperty('--rd-bright', String(Math.max(0, Math.min(1, bright))));
}

/** A slider's track is filled up to its thumb (styles.css reads --fill). */
export function fillRange(input) {
  const min = Number(input.min);
  const span = Number(input.max) - min || 1;
  input.style.setProperty('--fill', `${((Number(input.value) - min) / span) * 100}%`);
}

export const formatNumber =(value, digits = 0) =>
  new Intl.NumberFormat(currentLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);

/** A card with a theme's own colours and font: "Aa" and its name, a star when it was changed. */
export function themeCard(look, id, { checked, onPick, small = false }) {
  const card = h(
    'button',
    {
      type: 'button',
      class: `rq-card${small ? ' small' : ''}`,
      role: 'radio',
      'aria-checked': String(checked),
      'aria-label': `${t(`readThemes.${id}`)}${isModified(look, id) ? ` (${t('appearance.modified')})` : ''}`,
      onclick: () => onPick(id),
    },
    h('span', { class: 'rq-aa', 'aria-hidden': 'true' }, 'Aa'),
    h('span', { class: 'rq-name' }, t(`readThemes.${id}`)),
    isModified(look, id) ? h('span', { class: 'rq-star', 'aria-hidden': 'true' }, '*') : null,
  );
  paintTheme(card, look, id);
  return card;
}

const ICON_SCROLL = '<path d="M4 1.75h8M4 14.25h8M3.25 4.5h9.5v7h-9.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON_PAGES = '<path d="M2 3.25h5.25v9.5H2zM8.75 3.25H14v9.5H8.75z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>';
const ICON_MOON = '<path d="M12.75 10.1A5.25 5.25 0 0 1 5.9 3.25a5.25 5.25 0 1 0 6.85 6.85Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="m12.2 1.5.4 1.1 1.1.4-1.1.4-.4 1.1-.4-1.1-1.1-.4 1.1-.4Z" fill="currentColor"/>';
const ICON_SUN = '<circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';
const ICON_GEAR =
  '<circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.75v1.7M8 12.55v1.7M14.25 8h-1.7M3.45 8h-1.7M12.42 3.58l-1.2 1.2M4.78 11.22l-1.2 1.2M12.42 12.42l-1.2-1.2M4.78 4.78l-1.2-1.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';

export const icon = (inner, cls = '') => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('aria-hidden', 'true');
  if (cls) node.setAttribute('class', cls);
  node.innerHTML = inner; // fixed markup from this file, never user text
  return node;
};
// slow and fast: one chevron, then three
const ICON_SLOW = '<path d="M6.5 4.5 10 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON_FAST =
  '<path d="M2.5 4.5 6 8l-3.5 3.5M6.5 4.5 10 8l-3.5 3.5M10.5 4.5 14 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>';
export const ICONS = { scroll: ICON_SCROLL, pages: ICON_PAGES, moon: ICON_MOON, sun: ICON_SUN, gear: ICON_GEAR };

/**
 * Fills the quick panel. ctx: { reading: { readMode, readTurn, readLook }, pdf, canZoom, onZoom(-1|1),
 * onReading(patch, { redraw }), onBright(value) (live, while the slider moves), onCustomize(), onClose() }.
 */
export function drawQuickPanel(panel, ctx) {
  const { readMode, readTurn, readSpeed = 1, readLook: look } = ctx.reading;
  const pick = (patch) => ctx.onReading(patch);
  const lookPatch = (change) => pick({ readLook: { ...look, ...change } });

  const sizes = h(
    'div',
    { class: 'rq-pill rq-sizes' },
    h('button', { type: 'button', class: 'rq-btn rq-small', disabled: !ctx.canZoom || null, title: t('appearance.smaller'), 'aria-label': t('appearance.smaller'), onclick: () => ctx.onZoom(-1) }, 'A'),
    h('span', { class: 'rq-divider', 'aria-hidden': 'true' }),
    h('button', { type: 'button', class: 'rq-btn rq-large', disabled: !ctx.canZoom || null, title: t('appearance.larger'), 'aria-label': t('appearance.larger'), onclick: () => ctx.onZoom(1) }, 'A'),
  );
  const paged = readMode === 'pages';
  const toggles = h(
    'div',
    { class: 'rq-pill rq-toggles' },
    h(
      'button',
      {
        type: 'button',
        class: 'rq-btn',
        'aria-pressed': String(paged),
        title: t(paged ? 'appearance.pages' : 'appearance.scroll'),
        'aria-label': t(paged ? 'appearance.pages' : 'appearance.scroll'),
        onclick: () => pick({ readMode: paged ? 'scroll' : 'pages' }),
      },
      icon(paged ? ICON_PAGES : ICON_SCROLL),
    ),
    h(
      'button',
      { type: 'button', class: 'rq-btn', 'aria-pressed': String(look.auto), title: t('appearance.autoHint'), 'aria-label': t('appearance.auto'), onclick: () => lookPatch({ auto: !look.auto }) },
      icon(ICON_MOON),
    ),
  );
  const turns = paged
    ? h(
        'div',
        { class: 'rq-turns seg', role: 'radiogroup', 'aria-label': t('reader.turn') },
        TURNS.map((turn) =>
          h('button', { type: 'button', class: 'seg-btn', role: 'radio', 'aria-checked': String(turn === readTurn), onclick: () => pick({ readTurn: turn }) }, t(`reader.turns.${turn}`)),
        ),
      )
    : null;
  // how fast the pages turn: under the ways of turning, while there is a turn to see
  let speed = null;
  if (paged && readTurn !== 'none') {
    const range = h('input', {
      type: 'range',
      class: 'rq-range',
      min: String(TURN_SPEED.min),
      max: String(TURN_SPEED.max),
      step: '0.05',
      value: String(readSpeed),
      'aria-label': t('reader.speed'),
      title: t('reader.speed'),
    });
    fillRange(range);
    range.addEventListener('input', () => fillRange(range));
    range.addEventListener('change', () => ctx.onReading({ readSpeed: Number(range.value) }, { redraw: false }));
    speed = h('div', { class: 'rq-bright rq-speed' }, icon(ICON_SLOW, 'rq-sun-small'), range, icon(ICON_FAST, 'rq-sun-large'));
  }
  const slider = h('input', {
    type: 'range',
    class: 'rq-range',
    min: String(BRIGHTNESS.min),
    max: String(BRIGHTNESS.max),
    step: '0.01',
    value: String(look.bright),
    'aria-label': t('appearance.bright'),
  });
  fillRange(slider);
  slider.addEventListener('input', () => {
    fillRange(slider);
    ctx.onBright(Number(slider.value));
  });
  slider.addEventListener('change', () => ctx.onReading({ readLook: { ...look, bright: Number(slider.value) } }, { redraw: false }));
  const bright = h('div', { class: 'rq-bright' }, icon(ICON_SUN, 'rq-sun-small'), slider, icon(ICON_SUN, 'rq-sun-large'));
  const cards = h(
    'div',
    { class: 'rq-cards', role: 'radiogroup', 'aria-label': t('reader.theme') },
    READ_THEMES.map((id) => themeCard(look, id, { checked: id === look.theme, onPick: (theme) => lookPatch({ theme }) })),
  );
  const customize = ctx.pdf
    ? h('p', { class: 'rq-note' }, t('appearance.pdfNote'))
    : h('button', { type: 'button', class: 'rq-customize', onclick: () => ctx.onCustomize() }, icon(ICON_GEAR), h('span', {}, t('appearance.customize')));

  panel.replaceChildren(
    h(
      'div',
      { class: 'rq-head' },
      h('button', { type: 'button', class: 'rq-close', title: t('reader.marks.close'), 'aria-label': t('reader.marks.close'), onclick: () => ctx.onClose() }, '✕'),
      h('span', { class: 'rq-title' }, t('appearance.quick')),
    ),
    ...[h('div', { class: 'rq-row' }, sizes, toggles), turns, speed, bright, cards, customize].filter(Boolean),
  );
}

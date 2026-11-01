// "Theme settings": the full screen for a reading theme, reached from the reading page ("Customise")
// and from Menu → Settings → Reading appearance. A preview on top; below it the theme, the text
// (font, bold) and the layout (line, character and word spacing, margins, justify), then "Reset
// theme". Every change shows at once; ✕ (or Esc) puts back what was there, ✓ keeps it.

import { h, openDialog } from './overlays.js';
import { t } from './i18n.js';
import { LAYOUT_RANGES, READ_FONTS, READ_THEMES, FONT_STACKS, normalizeReadLook, themeStyle } from './skins.js';
import { fillRange, formatNumber, paintTheme, themeCard } from './readLook.js';

const SLIDERS = [
  { key: 'leading', icon: '↕', show: (v) => formatNumber(v, 2) },
  { key: 'letter', icon: 'A↔', show: (v) => `${formatNumber(v)} %` },
  { key: 'word', icon: '⎵', show: (v) => `${formatNumber(v)} %` },
  { key: 'margin', icon: '▯', show: (v) => `${formatNumber(v)} %` },
];

/**
 * getLook() → the reading look now (skins.js: normalizeReadLook); setLook(look) shows and keeps one.
 * pdf: the open document is a PDF, where only the theme applies (the rest is shown, with a note).
 */
export function openAppearance({ getLook, setLook, pdf = false }) {
  const before = getLook();
  let fontsOpen = false;

  openDialog(
    (box, close) => {
      const preview = h('div', { class: 'ap-preview', 'aria-hidden': 'true' });
      const body = h('div', { class: 'ap-body' });
      const cancel = h('button', { type: 'button', class: 'ap-round', title: t('appearance.cancel'), 'aria-label': t('appearance.cancel'), onclick: () => close(null) }, '✕');
      const done = h('button', { type: 'button', class: 'ap-round ap-done', title: t('appearance.done'), 'aria-label': t('appearance.done'), onclick: () => close('done'), 'data-autofocus': true }, '✓');

      const look = () => getLook();
      const current = () => look().theme;
      const style = () => themeStyle(look(), current());
      /** A change to the current theme's own settings. */
      const change = (patch, { redraw = true } = {}) => {
        const now = look();
        const id = now.theme;
        // the saved changes, plus this one, kept only where they differ from how the theme came
        const mine = { ...(now.themes[id] ?? {}), ...patch };
        setLook(normalizeReadLook({ ...now, themes: { ...now.themes, [id]: mine } }));
        if (redraw) draw();
        else paintPreview();
      };

      function paintPreview() {
        const l = look();
        paintTheme(preview, l, l.theme);
      }

      const row = (label, control, { icon = '', cls = '' } = {}) =>
        h('div', { class: `ap-row ${cls}`.trim() }, icon ? h('span', { class: 'ap-row-icon', 'aria-hidden': 'true' }, icon) : null, h('span', { class: 'ap-row-label' }, label), control);
      const toggle = (on, flip, label) =>
        h('button', { type: 'button', class: 'switch-btn', role: 'switch', 'aria-checked': String(Boolean(on)), 'aria-label': label, onclick: flip }, h('span', { class: 'switch', 'aria-hidden': 'true' }, h('i')));
      const card = (title, ...rows) => h('section', { class: 'ap-group' }, title ? h('h3', { class: 'ap-group-title' }, title) : null, h('div', { class: 'ap-card' }, rows.flat().filter(Boolean)));

      function slider({ key, icon, show }, s) {
        const range = LAYOUT_RANGES[key];
        const value = h('span', { class: 'ap-value' }, show(s[key]));
        const input = h('input', {
          type: 'range',
          class: 'ap-range',
          min: String(range.min),
          max: String(range.max),
          step: String(range.step),
          value: String(s[key]),
          disabled: !s.custom || null,
          'aria-label': t(`appearance.${key}`),
        });
        fillRange(input);
        input.addEventListener('input', () => {
          const v = Number(input.value);
          fillRange(input);
          value.textContent = show(v);
          change({ [key]: v, custom: true }, { redraw: false });
        });
        return h(
          'div',
          { class: `ap-slider${s.custom ? '' : ' off'}` },
          h('div', { class: 'ap-slider-label' }, t(`appearance.${key}`)),
          h('div', { class: 'ap-slider-row' }, h('span', { class: 'ap-row-icon', 'aria-hidden': 'true' }, icon), input, value),
        );
      }

      function draw() {
        const l = look();
        const s = style();
        const top = body.scrollTop;
        paintPreview();
        const themes = h(
          'div',
          { class: 'ap-themes', role: 'radiogroup', 'aria-label': t('appearance.theme') },
          READ_THEMES.map((id) =>
            themeCard(l, id, {
              small: true,
              checked: id === l.theme,
              onPick: (theme) => {
                setLook({ ...look(), theme });
                draw();
              },
            }),
          ),
        );
        const fontButton = h(
          'button',
          { type: 'button', class: 'ap-row ap-link', 'aria-expanded': String(fontsOpen), onclick: () => ((fontsOpen = !fontsOpen), draw()) },
          h('span', { class: 'ap-row-icon ap-aa', 'aria-hidden': 'true' }, 'Aa'),
          h('span', { class: 'ap-row-label' }, t('appearance.font')),
          h('span', { class: 'ap-row-value', style: `font-family: ${FONT_STACKS[s.font]}` }, t(`readFonts.${s.font}`)),
          h('span', { class: 'ap-chev', 'aria-hidden': 'true' }, fontsOpen ? '⌄' : '›'),
        );
        const fonts = fontsOpen
          ? h(
              'div',
              { class: 'ap-fonts', role: 'radiogroup', 'aria-label': t('appearance.font') },
              READ_FONTS.map((font) =>
                h(
                  'button',
                  { type: 'button', class: 'ap-font', role: 'radio', 'aria-checked': String(font === s.font), style: `font-family: ${FONT_STACKS[font]}`, onclick: () => change({ font }) },
                  h('span', {}, t(`readFonts.${font}`)),
                  font === s.font ? h('span', { class: 'ap-check', 'aria-hidden': 'true' }, '✓') : null,
                ),
              ),
            )
          : null;
        body.replaceChildren(
          ...[
            card(t('appearance.theme'), themes),
            pdf ? h('p', { class: 'ap-note' }, t('appearance.pdfNote')) : null,
            card(t('appearance.text'), fontButton, fonts, row(t('appearance.bold'), toggle(s.bold, () => change({ bold: !s.bold }), t('appearance.bold')), { icon: 'B', cls: 'ap-bold' })),
            card(
              t('appearance.layout'),
              row(t('appearance.custom'), toggle(s.custom, () => change({ custom: !s.custom }), t('appearance.custom'))),
              s.custom ? null : h('p', { class: 'ap-hint' }, t('appearance.customHint')),
              SLIDERS.map((def) => slider(def, s)),
            ),
            card(null, row(t('appearance.justify'), toggle(s.justify, () => change({ justify: !s.justify }), t('appearance.justify')))),
            h(
              'button',
              {
                type: 'button',
                class: 'ap-reset',
                disabled: !l.themes[l.theme] || null,
                onclick: () => {
                  const now = look();
                  const { [now.theme]: _, ...rest } = now.themes;
                  setLook({ ...now, themes: rest });
                  draw();
                },
              },
              t('appearance.reset'),
            ),
          ].filter(Boolean),
        );
        body.scrollTop = top;
      }

      preview.append(h('div', { class: 'ap-aa-big' }, 'Aa'), h('p', { class: 'rd-sample' }, t('appearance.sample')));
      box.append(h('header', { class: 'ap-head' }, cancel, h('h2', { class: 'ap-title' }, t('appearance.title')), done), preview, body);
      draw();
    },
    {
      className: 'appearance',
      onClose: (value) => {
        if (value !== 'done') setLook(before);
      },
    },
  );
}

// The formatting bar: a row of buttons above a phone's keyboard (or at the foot of the window, if
// wanted on a computer too) that put Markdown marks on the text: headings, bold, italic, lists, a
// quote, indents. Which buttons and in what order is the person's choice (prefs.formatTools).

import { indentLess, indentMore } from '@codemirror/commands';
import { h, openDialog } from './overlays.js';
import { t } from './i18n.js';
import { apply, heading, lineMark, link, rule, wrap } from './format.js';
import { insertCodeBlock } from './editor.js';
import { insertAccordionBlock } from './accordionView.js';

/** Every button the bar can have. */
export const TOOLS = [
  { id: 'keyboard', glyph: '⌨', run: (view) => view.contentDOM.blur() },
  { id: 'h1', glyph: 'H1', run: (view) => apply(view, (s) => heading(s, 1)) },
  { id: 'h2', glyph: 'H2', run: (view) => apply(view, (s) => heading(s, 2)) },
  { id: 'h3', glyph: 'H3', run: (view) => apply(view, (s) => heading(s, 3)) },
  { id: 'bold', glyph: 'B', run: (view) => apply(view, (s) => wrap(s, '**')) },
  { id: 'italic', glyph: 'I', run: (view) => apply(view, (s) => wrap(s, '*')) },
  { id: 'underline', glyph: 'U', run: (view) => apply(view, (s) => wrap(s, '<u>', '</u>')) },
  { id: 'strike', glyph: 'S', run: (view) => apply(view, (s) => wrap(s, '~~')) },
  { id: 'code', glyph: '`', run: (view) => apply(view, (s) => wrap(s, '`')) },
  { id: 'bullet', glyph: '•', run: (view) => apply(view, (s) => lineMark(s, 'bullet')) },
  { id: 'numbered', glyph: '1.', run: (view) => apply(view, (s) => lineMark(s, 'numbered')) },
  { id: 'task', glyph: '☐', run: (view) => apply(view, (s) => lineMark(s, 'task')) },
  { id: 'quote', glyph: '❝', run: (view) => apply(view, (s) => lineMark(s, 'quote')) },
  { id: 'indent', glyph: '⇥', run: (view) => indentMore(view) },
  { id: 'outdent', glyph: '⇤', run: (view) => indentLess(view) },
  { id: 'link', glyph: '🔗', run: (view) => apply(view, link) },
  { id: 'image', glyph: '🖼', run: (view, actions) => actions.image?.() },
  { id: 'rule', glyph: '―', run: (view) => apply(view, rule) },
  { id: 'codeblock', glyph: '{ }', run: (view) => insertCodeBlock(view) },
  { id: 'accordion', glyph: '▸', run: insertAccordionBlock },
];
const BY_ID = new Map(TOOLS.map((tool) => [tool.id, tool]));
export const DEFAULT_TOOLS = ['keyboard', 'h1', 'h2', 'h3', 'bold', 'italic', 'underline', 'strike', 'bullet', 'numbered', 'task', 'quote', 'indent', 'outdent', 'link', 'image'];

/** A saved list of buttons, made safe: known ones, each once; nothing saved yet: the default ones. */
export function normalizeTools(list) {
  if (!Array.isArray(list)) return [...DEFAULT_TOOLS];
  return [...new Set(list.filter((id) => BY_ID.has(id)))];
}

/**
 * The bar. getView(): the editor's view; actions.image(): a picture chosen and put in. Buttons never
 * take the focus, so the keyboard stays up.
 */
export function createFormatBar({ getView, actions = {} }) {
  const node = h('div', { class: 'format-bar', role: 'toolbar', hidden: true });
  let tools = [...DEFAULT_TOOLS];

  function draw() {
    node.setAttribute('aria-label', t('format.title'));
    node.replaceChildren(
      ...tools.map((id) => {
        const tool = BY_ID.get(id);
        const button = h('button', { type: 'button', class: `format-btn format-${id}`, title: t(`format.tools.${id}`), 'aria-label': t(`format.tools.${id}`) }, tool.glyph);
        button.addEventListener('pointerdown', (e) => e.preventDefault());
        button.addEventListener('click', () => {
          const view = getView();
          if (view) tool.run(view, actions);
        });
        return button;
      }),
    );
  }
  draw();

  return {
    node,
    setTools(list) {
      tools = normalizeTools(list);
      draw();
    },
    localize: draw,
  };
}

/** Which buttons the bar has, and in what order: switches and arrows. onSave(list). */
export function openToolsDialog({ current, onSave }) {
  let chosen = normalizeTools(current);
  openDialog(
    (box, close) => {
      const list = h('ol', { class: 'format-tools' });
      const draw = () => {
        const order = [...chosen, ...TOOLS.map((tool) => tool.id).filter((id) => !chosen.includes(id))];
        list.replaceChildren(
          ...order.map((id) => {
            const on = chosen.includes(id);
            const at = chosen.indexOf(id);
            const move = (by) => {
              const next = [...chosen];
              next.splice(at, 1);
              next.splice(at + by, 0, id);
              chosen = next;
              draw();
            };
            return h(
              'li',
              { class: `format-tool${on ? '' : ' off'}` },
              h(
                'label',
                { class: 'format-tool-label' },
                h('input', {
                  type: 'checkbox',
                  checked: on,
                  onchange: (e) => {
                    chosen = e.target.checked ? [...chosen, id] : chosen.filter((x) => x !== id);
                    draw();
                  },
                }),
                h('span', { class: 'format-tool-glyph', 'aria-hidden': 'true' }, BY_ID.get(id).glyph),
                h('span', {}, t(`format.tools.${id}`)),
              ),
              h('button', { type: 'button', class: 'tb-btn icon', disabled: !on || at === 0, title: t('format.up'), 'aria-label': t('format.up'), onclick: () => move(-1) }, '↑'),
              h('button', { type: 'button', class: 'tb-btn icon', disabled: !on || at === chosen.length - 1, title: t('format.down'), 'aria-label': t('format.down'), onclick: () => move(1) }, '↓'),
            );
          }),
        );
      };
      draw();
      box.append(
        h('div', { class: 'modal-kicker' }, t('format.title')),
        h('h2', { class: 'modal-title' }, t('format.customize')),
        h('p', { class: 'modal-text' }, t('format.customizeText')),
        list,
        h(
          'div',
          { class: 'modal-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: () => {
                chosen = [...DEFAULT_TOOLS];
                draw();
              },
            },
            t('format.reset'),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn primary',
              'data-autofocus': true,
              onclick: () => {
                onSave(chosen);
                close(null);
              },
            },
            t('settings.done'),
          ),
        ),
      );
    },
    { className: 'modal-format' },
  );
}

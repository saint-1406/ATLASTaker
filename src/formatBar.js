// The formatting bar: a row of buttons above a phone's keyboard (or at the foot of the window, if
// wanted on a computer too) that put Markdown marks on the text: headings, bold, italic, lists, a
// quote, indents. Which buttons and in what order is the person's choice (prefs.formatTools).

import { indentLess, indentMore } from '@codemirror/commands';
import { h, openDialog, showMenu } from './overlays.js';
import { t } from './i18n.js';
import { apply, heading, lineMark, link, rule, wrap } from './format.js';
import { insertCodeBlock } from './editor.js';
import { insertAccordionBlock } from './accordionView.js';

/** Every button the bar can have. */
export const TOOLS = [
  { id: 'keyboard', glyph: '⌨', run: (view) => view.contentDOM.blur() },
  // the selected words to the clipboard; the selection stays, to quote or format it next
  { id: 'copy', glyph: '⧉', run: (view, actions) => actions.copy?.() },
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
export const DEFAULT_TOOLS = ['keyboard', 'copy', 'h1', 'h2', 'h3', 'bold', 'italic', 'underline', 'strike', 'bullet', 'numbered', 'task', 'quote', 'indent', 'outdent', 'link', 'image'];

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
  let typeButton, insertButton;

  function run(id) {
    const view = getView(); if (!view) return;
    if (id === 'image') { actions.image?.(); return; }
    if (id === 'copy') { actions.copy?.(); return; }
    if (id === 'keyboard') { view.contentDOM.blur(); return; }
    if (view.rich) {
      if (id === 'link') { askLink(view); return; }
      view.rich.command(id); view.focus(); refresh();
    } else BY_ID.get(id)?.run(view, actions);
  }
  function askLink(view) {
    openDialog((box, close) => {
      const field = h('input', { class: 'field', type: 'url', placeholder: 'https://', 'aria-label': t('format.tools.link'), 'data-autofocus': true });
      const save = h('button', { type: 'button', class: 'btn primary', onclick: () => { if (view.rich.command('link', field.value)) close(null); } }, t('settings.done'));
      box.append(h('h2', { class: 'modal-title' }, t('format.tools.link')), field, h('div', { class: 'modal-actions' }, save));
      field.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); save.click(); } });
    }, { onClose: () => view.focus() });
  }
  function menu(anchor, items) {
    const rect = anchor.getBoundingClientRect();
    showMenu(rect.right, rect.top, items, { onClose: () => getView()?.focus(), above: rect.top > innerHeight / 2, preserveFocus: matchMedia('(pointer: coarse)').matches });
  }
  function blockMenu() {
    menu(typeButton, ['paragraph', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'task', 'quote', 'codeblock'].map((id) => ({ text: id === 'paragraph' ? t('rich.paragraph') : t(`format.tools.${id}`), run: () => run(id) })));
  }
  function insertMenu(anchor = insertButton) {
    const rich = getView()?.rich;
    const items = ['accordion', 'task', 'bullet', 'numbered', 'quote', 'image', 'link', 'rule', 'codeblock'].map((id) => ({ icon: BY_ID.get(id)?.glyph || '＋', text: t(`format.tools.${id}`), run: () => run(id) }));
    if (rich) items.push('-', { icon: '↳', text: t('rich.nextItem'), disabled: !rich.formats().inList, run: () => run('next') }, { icon: '↵', text: t('rich.innerLine'), run: () => run('newline') }, { icon: '¶', text: t('rich.afterBlock'), run: () => run('after') });
    items.push('-', { icon: '⌨', text: t('format.tools.keyboard'), run: () => run('keyboard') });
    menu(anchor, items);
  }

  function refresh() {
    const view = getView(), rich = view?.rich;
    if (!typeButton) return;
    const state = rich?.formats();
    const block = state?.block || 'paragraph';
    const names = { paragraph: t('rich.paragraph'), heading: t(`format.tools.h${Math.min(3, state?.level || 1)}`), bullet_list: t('format.tools.bullet'), ordered_list: t('format.tools.numbered'), task_list: t('format.tools.task'), blockquote: t('format.tools.quote'), code_block: t('format.tools.codeblock'), summary: t('rich.summary') };
    const shortName = block === 'heading' ? `H${state?.level || 1}` : names[block] || t('rich.paragraph');
    typeButton.textContent = rich ? `${shortName} ▾` : 'Markdown ▾';
    typeButton.setAttribute('aria-label', t('rich.blockType') + ': ' + (rich ? names[block] || t('rich.paragraph') : 'Markdown'));
    typeButton.title = t('rich.blockType');
    const markNames = { bold: 'strong', italic: 'em', underline: 'underline', strike: 'strike', code: 'code' };
    for (const button of node.querySelectorAll('[data-format]')) {
      const on = state?.marks.has(markNames[button.dataset.format]) || false;
      button.classList.toggle('active', on); button.setAttribute('aria-pressed', String(on));
      button.disabled = !view;
    }
  }

  function draw() {
    node.setAttribute('aria-label', t('format.title'));
    node.classList.add('visual-format-bar');
    typeButton = h('button', { type: 'button', class: 'format-type', 'aria-label': t('rich.blockType'), 'aria-haspopup': 'menu', onclick: blockMenu }, t('rich.paragraph') + ' ▾');
    insertButton = h('button', { type: 'button', class: 'format-insert', 'aria-label': t('rich.insertBlock'), 'aria-haspopup': 'menu', onclick: () => insertMenu() }, '＋ ', t('rich.insert'));
    const preferred = tools.filter((id) => ['bold', 'italic', 'underline', 'strike', 'code'].includes(id));
    const marks = [...new Set(preferred)];
    const row = h('div', { class: 'format-inline-tools' }, marks.map((id) => {
        const tool = BY_ID.get(id);
        const button = h('button', { type: 'button', class: `format-btn format-${id}`, 'data-format': id, title: t(`format.tools.${id}`), 'aria-label': t(`format.tools.${id}`), 'aria-pressed': 'false' }, tool.glyph);
        button.addEventListener('pointerdown', (e) => e.preventDefault());
        button.addEventListener('click', () => run(id));
        return button;
      }));
    // copying is always there: the selected words to the clipboard, the selection left as it was
    const copyButton = h('button', { type: 'button', class: 'format-btn format-copy', title: t('format.tools.copy'), 'aria-label': t('format.tools.copy'), onclick: () => run('copy') }, '⧉');
    for (const button of [typeButton, copyButton, insertButton]) button.addEventListener('pointerdown', (event) => event.preventDefault());
    node.replaceChildren(typeButton, row, copyButton, insertButton);
    refresh();
  }
  draw();

  return {
    node,
    setTools(list) {
      tools = normalizeTools(list);
      draw();
    },
    localize: draw,
    refresh,
    openInsert: (anchor) => insertMenu(anchor),
  };
}

/** Which buttons the bar has, and in what order: switches and arrows. onSave(list). */
export function openToolsDialog({ current, onSave }) {
  const inlineTools = new Set(['bold', 'italic', 'underline', 'strike', 'code']);
  let chosen = normalizeTools(current).filter((id) => inlineTools.has(id));
  openDialog(
    (box, close) => {
      const list = h('ol', { class: 'format-tools' });
      const draw = () => {
        const order = [...chosen, ...TOOLS.map((tool) => tool.id).filter((id) => inlineTools.has(id) && !chosen.includes(id))];
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
                chosen = DEFAULT_TOOLS.filter((id) => inlineTools.has(id));
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

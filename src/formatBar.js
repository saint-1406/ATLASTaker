// The formatting bar: a row of buttons above a phone's keyboard (or at the foot of the window, if
// wanted on a computer too) that put Markdown marks on the text: headings, bold, italic, lists, a
// quote, indents. Which buttons and in what order is the person's choice (prefs.formatTools).

import { indentLess, indentMore } from '@codemirror/commands';
import { h, openDialog, showMenu } from './overlays.js';
import { t } from './i18n.js';
import { apply, heading, lineMark, link, rule, wrap } from './format.js';
import { insertCodeBlock } from './editor.js';
import { insertAccordionBlock } from './accordionView.js';
import { hasIcon, icon } from './icons.js';

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
 * The bar at the foot: one row that scrolls sideways (a carousel) with everything a note has: the kind
 * of paragraph, the marks, blocks, pictures and links, and what the ⋯ menu holds (copy, tags, versions,
 * statistics, the editor's mode, export, clearing). A pressed button stays lit while it is on: a mark
 * with nothing selected stays on for the words written next until it is pressed again. Holding a button
 * shows what it does. Buttons never take the focus, so the keyboard stays up.
 *
 * actions: image(), copy(), note(id) for the note's own tools, mode() → 'visual' | 'source'.
 */
export function createFormatBar({ getView, actions = {} }) {
  const node = h('div', { class: 'format-bar visual-format-bar', role: 'toolbar', hidden: true });
  const strip = h('div', { class: 'format-strip' });
  const tip = h('div', { class: 'format-tip', role: 'tooltip', hidden: true });
  node.append(strip);
  document.body.append(tip);
  let tools = [...DEFAULT_TOOLS];
  let editing = true;

  function run(id) {
    hideTip();
    if (NOTE_TOOLS.has(id)) { actions.note?.(id); return; }
    const view = getView(); if (!view) return;
    if (id === 'image') { actions.image?.(); return; }
    if (id === 'copy') { actions.copy?.(); return; }
    if (id === 'keyboard') { view.contentDOM.blur(); return; }
    if (view.rich) {
      if (id === 'link') { askLink(view); return; }
      view.rich.toggle(id); view.focus(); refresh();
    } else {
      (SOURCE_RUN[id] ?? BY_ID.get(id)?.run)?.(view, actions);
      view.focus();
    }
  }
  function askLink(view) {
    openDialog((box, close) => {
      const field = h('input', { class: 'field', type: 'url', placeholder: 'https://', 'aria-label': t('format.tools.link'), 'data-autofocus': true });
      const save = h('button', { type: 'button', class: 'btn primary', onclick: () => { if (view.rich.command('link', field.value)) close(null); } }, t('settings.done'));
      box.append(h('h2', { class: 'modal-title' }, t('format.tools.link')), field, h('div', { class: 'modal-actions' }, save));
      field.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); save.click(); } });
    }, { onClose: () => view.focus() });
  }
  /** The insert menu, for the ⋯ menu of a computer's window (app.js). */
  function insertMenu(anchor) {
    const rich = getView()?.rich;
    const items = ['accordion', 'task', 'bullet', 'numbered', 'quote', 'image', 'link', 'rule', 'codeblock'].map((id) => ({ icon: hasIcon(id) ? icon(id) : BY_ID.get(id)?.glyph || '＋', text: t(`format.tools.${id}`), run: () => run(id) }));
    if (rich) items.push('-', { icon: icon('next'), text: t('rich.nextItem'), disabled: !rich.formats().inList, run: () => run('next') }, { icon: icon('newline'), text: t('rich.innerLine'), run: () => run('newline') }, { icon: icon('after'), text: t('rich.afterBlock'), run: () => run('after') });
    const rect = anchor.getBoundingClientRect();
    showMenu(rect.right, rect.top, items, { onClose: () => getView()?.focus(), above: rect.top > innerHeight / 2, preserveFocus: matchMedia('(pointer: coarse)').matches });
  }

  const label = (id) => (id === 'mode' ? t(actions.mode?.() === 'source' ? 'rich.visual' : 'rich.source') : t(LABEL_KEYS[id] ?? `format.tools.${id}`));

  // ---- holding a button: a small card says what it does ----
  let holdTimer = 0, tipTimer = 0, held = false, start = null;
  function showTip(button) {
    const id = button.dataset.tool;
    tip.replaceChildren(h('strong', {}, label(id)), h('span', {}, t(`format.hints.${id}`)));
    tip.hidden = false;
    // measured at the left edge first: placed further right, a fixed box would shrink to the room left
    tip.style.left = '0px';
    tip.style.top = '0px';
    const box = button.getBoundingClientRect();
    const width = tip.offsetWidth;
    tip.style.left = `${Math.round(Math.min(Math.max(8, box.left + box.width / 2 - width / 2), innerWidth - width - 8))}px`;
    tip.style.top = `${Math.round(Math.max(8, box.top - tip.offsetHeight - 10))}px`;
  }
  function hideTip() {
    clearTimeout(holdTimer);
    clearTimeout(tipTimer);
    tip.hidden = true;
  }
  strip.addEventListener('pointerdown', (event) => {
    const button = event.target.closest('button[data-tool]');
    if (!button) return;
    event.preventDefault(); // the editor keeps the focus (and the keyboard stays up)
    hideTip();
    held = false;
    start = { x: event.clientX, y: event.clientY };
    pressedAt = strip.scrollLeft;
    holdTimer = setTimeout(() => { held = true; showTip(button); }, 450);
  });
  strip.addEventListener('pointermove', (event) => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) { clearTimeout(holdTimer); start = null; }
  });
  for (const type of ['pointerup', 'pointercancel']) strip.addEventListener(type, () => {
    clearTimeout(holdTimer);
    start = null;
    if (held) tipTimer = setTimeout(hideTip, 2500);
  });
  // the row moved under the finger (not just settling into place by a few pixels): no card
  let pressedAt = 0;
  strip.addEventListener('scroll', () => { if (Math.abs(strip.scrollLeft - pressedAt) > 6) hideTip(); }, { passive: true });
  strip.addEventListener('contextmenu', (event) => event.preventDefault());
  strip.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tool]');
    if (!button) return;
    if (held) { held = false; return; } // a hold shows the card; it does not press the button
    run(button.dataset.tool);
  });

  function refresh() {
    const view = getView(), rich = view?.rich;
    const state = rich?.formats();
    const sticky = rich?.sticky?.() ?? new Set();
    const block = state?.block;
    for (const button of strip.querySelectorAll('button[data-tool]')) {
      const id = button.dataset.tool;
      let on = false;
      if (state) {
        if (MARK_OF[id]) on = state.marks.has(MARK_OF[id]) || sticky.has(MARK_OF[id]);
        else if (/^h[1-6]$/.test(id)) on = block === 'heading' && state.level === Number(id[1]);
        else if (BLOCK_OF[id]) on = block === BLOCK_OF[id];
      }
      button.classList.toggle('active', on);
      button.classList.toggle('sticky', Boolean(MARK_OF[id] && sticky.has(MARK_OF[id])));
      if (TOGGLES.has(id)) button.setAttribute('aria-pressed', String(on));
      button.hidden = !editing && !READING.has(id);
      if (id === 'mode') {
        button.replaceChildren(icon(actions.mode?.() === 'source' ? 'visual' : 'source'));
        button.setAttribute('aria-label', label(id));
        button.title = label(id);
      }
    }
    for (const group of strip.querySelectorAll('.format-group')) group.hidden = ![...group.children].some((child) => !child.hidden);
  }

  function draw() {
    node.setAttribute('aria-label', t('format.title'));
    const marks = new Set(tools.filter((id) => MARK_OF[id]));
    strip.replaceChildren(...GROUPS.map((group) => h(
      'div',
      { class: `format-group format-group-${group.id}`, role: 'group', 'aria-label': t(`format.groups.${group.id}`) },
      group.tools.filter((id) => !MARK_OF[id] || marks.has(id)).map((id) => {
        const glyph = hasIcon(id) ? icon(id) : TEXT_GLYPH[id] ?? BY_ID.get(id)?.glyph ?? id;
        return h('button', { type: 'button', class: `format-btn format-${id}${id === 'clear' ? ' danger' : ''}`, 'data-tool': id, title: label(id), 'aria-label': label(id) }, glyph);
      }),
    )));
    refresh();
  }
  draw();

  return {
    node,
    setTools(list) {
      tools = normalizeTools(list);
      draw();
    },
    /** Reading a note: only what does not write in it (copy, tags, versions, export…). */
    setEditing(on) {
      const changed = editing !== on;
      editing = on;
      refresh();
      if (changed) strip.scrollLeft = 0; // writing starts at the text's tools, reading at the note's
    },
    localize: draw,
    refresh,
    openInsert: (anchor) => insertMenu(anchor),
  };
}

const MARK_OF = { bold: 'strong', italic: 'em', underline: 'underline', strike: 'strike', code: 'code' };
const BLOCK_OF = { paragraph: 'paragraph', bullet: 'bullet_list', numbered: 'ordered_list', task: 'task_list', quote: 'blockquote', codeblock: 'code_block' };
const TOGGLES = new Set([...Object.keys(MARK_OF), ...Object.keys(BLOCK_OF), 'h1', 'h2', 'h3']);
const NOTE_TOOLS = new Set(['copyAll', 'tag', 'tags', 'versions', 'stats', 'mode', 'md', 'txt', 'html', 'pdf', 'clear']);
// what the bar keeps while a note is open for reading
const READING = new Set(['copy', 'copyAll', 'tags', 'versions', 'stats', 'mode', 'md', 'txt', 'html', 'pdf']);
const LABEL_KEYS = { paragraph: 'rich.paragraph', copyAll: 'noteMenu.copyAll', tag: 'noteMenu.tag', tags: 'tags.title', versions: 'versions.title', stats: 'stats.title', md: 'noteMenu.md', txt: 'noteMenu.txt', html: 'noteMenu.html', pdf: 'noteMenu.pdf', clear: 'noteMenu.clear' };
const TEXT_GLYPH = { md: 'MD', txt: 'TXT', html: 'HTML', pdf: 'PDF' };
const GROUPS = [
  { id: 'text', tools: ['paragraph', 'h1', 'h2', 'h3', 'bold', 'italic', 'underline', 'strike', 'code'] },
  { id: 'blocks', tools: ['bullet', 'numbered', 'task', 'quote', 'codeblock', 'accordion', 'rule', 'indent', 'outdent'] },
  { id: 'insert', tools: ['image', 'link'] },
  { id: 'note', tools: ['copy', 'copyAll', 'tag', 'tags', 'versions', 'stats', 'mode'] },
  { id: 'export', tools: ['md', 'txt', 'html', 'pdf'] },
  { id: 'more', tools: ['keyboard', 'clear'] },
];
// Markdown source: a plain paragraph is a line without its heading mark (the same heading pressed again)
const SOURCE_RUN = {
  paragraph: (view) => {
    const own = /^\s*(#{1,6})\s/.exec(view.state.doc.lineAt(view.state.selection.main.head).text);
    if (own) apply(view, (s) => heading(s, own[1].length));
  },
};

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

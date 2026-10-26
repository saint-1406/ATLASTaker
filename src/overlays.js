// Floating UI: context menu, dialogs, command palette, settings, toasts and the "paused" blocker.
// User text always goes in through text nodes, never as HTML.

import { ACCENTS, SKINS, THEMES } from './skins.js';

const layer = () => document.getElementById('overlays');

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

let menu = null;

export function isOverlayOpen() {
  return Boolean(menu) || Boolean(layer()?.querySelector('.scrim'));
}

export function closeMenu(restoreFocus = true) {
  if (!menu) return;
  const { node, cleanup, onClose } = menu;
  menu = null;
  cleanup();
  node.remove();
  if (restoreFocus) onClose?.();
}

/**
 * items: { icon, text, kbd, run, disabled } | { header } | { note } | '-'
 */
export function showMenu(x, y, items, { onClose } = {}) {
  closeMenu(false);
  const node = h('div', { class: 'ctx', role: 'menu' });
  const buttons = [];
  for (const item of items) {
    if (item === '-') {
      node.append(h('div', { class: 'ctx-sep', role: 'separator' }));
      continue;
    }
    if (item.header) {
      node.append(h('div', { class: 'ctx-header' }, item.header));
      continue;
    }
    if (item.note) {
      node.append(h('div', { class: 'ctx-note' }, item.note));
      continue;
    }
    const button = h(
      'button',
      { type: 'button', role: 'menuitem', class: `ctx-item ${item.className ?? ''}`.trim(), disabled: item.disabled || null, title: item.title },
      h('span', { class: 'ctx-ico', 'aria-hidden': 'true' }, item.icon ?? ''),
      h('span', { class: 'ctx-text' }, item.text),
      item.kbd ? h('kbd', {}, item.kbd) : null,
    );
    button.addEventListener('click', () => {
      closeMenu();
      item.run?.();
    });
    node.append(button);
    if (!item.disabled) buttons.push(button);
  }
  layer().append(node);
  const rect = node.getBoundingClientRect();
  node.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
  node.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;

  const onPointer = (e) => {
    if (!node.contains(e.target)) closeMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = buttons.indexOf(document.activeElement);
      const stepBy = e.key === 'ArrowDown' ? 1 : -1;
      buttons[(i + stepBy + buttons.length) % buttons.length]?.focus();
    }
  };
  const onDismiss = () => closeMenu();
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('wheel', onDismiss, { capture: true, passive: true });
  window.addEventListener('blur', onDismiss);
  window.addEventListener('resize', onDismiss);
  menu = {
    node,
    onClose,
    cleanup() {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('wheel', onDismiss, { capture: true });
      window.removeEventListener('blur', onDismiss);
      window.removeEventListener('resize', onDismiss);
    },
  };
  buttons[0]?.focus({ preventScroll: true });
}

function trapTab(e, box) {
  const focusable = [...box.querySelectorAll('button:not([disabled]), input, textarea, [tabindex="0"]')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function openDialog(build, { onClose, dismissable = true, className = '' } = {}) {
  const scrim = h('div', { class: 'scrim' });
  const box = h('div', { class: `modal ${className}`.trim(), role: 'dialog', 'aria-modal': 'true' });
  scrim.append(box);
  let closed = false;
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) {
      e.preventDefault();
      e.stopPropagation();
      close(null);
    } else if (e.key === 'Tab') {
      trapTab(e, box);
    }
  };
  function close(value) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    scrim.classList.add('leaving');
    setTimeout(() => scrim.remove(), 140);
    onClose?.(value);
  }
  if (dismissable) {
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) close(null);
    });
  }
  document.addEventListener('keydown', onKey, true);
  build(box, close);
  layer().append(scrim);
  requestAnimationFrame(() => (box.querySelector('[data-autofocus]') ?? box.querySelector('input, textarea, button'))?.focus());
  return close;
}

/** Resolves to the comment text, or null when cancelled. */
export function openCommentDialog({ quote, history = [], kicker = 'Комментарий' }) {
  return new Promise((resolve) => {
    openDialog(
      (box, close) => {
        const area = h('textarea', {
          class: 'field field-area',
          rows: '3',
          maxlength: '2000',
          placeholder: 'Что нового? Например: «перенесли на четверг»',
          'aria-label': 'Текст комментария',
          'data-autofocus': true,
        });
        const submit = () => {
          const value = area.value.trim();
          if (!value) {
            box.classList.remove('shake');
            void box.offsetWidth;
            box.classList.add('shake');
            area.focus();
            return;
          }
          close(value);
        };
        area.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            submit();
          }
        });
        box.append(
          h('div', { class: 'modal-kicker' }, kicker),
          h('h2', { class: 'modal-title' }, 'Комментарий к строке'),
          h('blockquote', { class: 'modal-quote' }, quote),
          history.length
            ? h(
                'ol',
                { class: 'modal-history', 'aria-label': 'Предыдущие комментарии' },
                history.map((c) => h('li', {}, h('span', { class: 'modal-stamp' }, c.stamp), h('span', {}, c.text))),
              )
            : null,
          area,
          h(
            'div',
            { class: 'modal-actions' },
            h('span', { class: 'modal-hint' }, 'Enter — добавить · Esc — отмена'),
            h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Отмена'),
            h('button', { type: 'button', class: 'btn primary', onclick: submit }, 'Добавить'),
          ),
        );
      },
      { onClose: resolve, className: 'modal-comment' },
    );
  });
}

export function confirmDialog({ kicker = '', title, text, ok = 'Да', danger = false }) {
  return new Promise((resolve) => {
    openDialog(
      (box, close) => {
        box.append(
          kicker ? h('div', { class: 'modal-kicker' }, kicker) : null,
          h('h2', { class: 'modal-title' }, title),
          text ? h('p', { class: 'modal-text' }, text) : null,
          h(
            'div',
            { class: 'modal-actions' },
            h('button', { type: 'button', class: 'btn', onclick: () => close(false) }, 'Отмена'),
            h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true), 'data-autofocus': true }, ok),
          ),
        );
      },
      { onClose: (value) => resolve(value === true) },
    );
  });
}

function highlight(text, q) {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return [text];
  return [text.slice(0, i), h('mark', {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

function snippet(content, q) {
  const i = content.toLowerCase().indexOf(q);
  if (i < 0) return null;
  const start = Math.max(0, i - 40);
  return `${start ? '…' : ''}${content.slice(start, i + q.length + 70).replace(/\s+/g, ' ').trim()}…`;
}

/**
 * Ctrl+K: one box for everything. Words find notes by title or by text, matching commands follow;
 * a leading ">" lists commands only. A miss offers to create a note with that title.
 * notes: [{ id, title, meta, content }], commands: [{ icon, title, kbd, keywords, run }]
 */
export function commandPalette({ notes, commands, onPick, onCreate, initial = '' }) {
  openDialog(
    (box, close) => {
      const input = h('input', {
        class: 'field qs-input',
        type: 'search',
        placeholder: 'Заметка, слово из текста или > команда',
        spellcheck: 'false',
        'aria-label': 'Поиск заметок и команд',
        'data-autofocus': true,
      });
      input.value = initial;
      const list = h('ol', { class: 'qs-list', role: 'listbox' });
      let rows = [];
      let active = 0;
      const choose = (row) => {
        close(null);
        if (row.kind === 'create') onCreate(row.title);
        else if (row.kind === 'command') row.run();
        else onPick(row.id);
      };
      const items = () => [...list.querySelectorAll('.qs-item')];
      const mark = () => {
        items().forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
        items()[active]?.scrollIntoView({ block: 'nearest' });
      };
      const rowNode = (row, i, q) => {
        const li = h('li', { class: `qs-item qs-${row.kind}`, role: 'option', 'aria-selected': String(i === active) });
        if (row.kind === 'create') {
          li.append(h('span', { class: 'qs-ico' }, '＋'), h('span', { class: 'qs-main' }, h('span', { class: 'qs-title' }, `Создать заметку «${row.title}»`)));
        } else if (row.kind === 'command') {
          li.append(
            h('span', { class: 'qs-ico' }, row.icon ?? '›'),
            h('span', { class: 'qs-main' }, h('span', { class: 'qs-title' }, ...highlight(row.title, q))),
            row.kbd ? h('kbd', {}, row.kbd) : null,
          );
        } else {
          const snip = q && !row.title.toLowerCase().includes(q) ? snippet(row.content, q) : null;
          li.append(
            h('span', { class: 'qs-ico' }, '◆'),
            h('span', { class: 'qs-main' }, h('span', { class: 'qs-title' }, ...highlight(row.title, q)), snip ? h('span', { class: 'qs-snippet' }, ...highlight(snip, q)) : null),
            h('span', { class: 'qs-meta' }, row.meta),
          );
        }
        li.addEventListener('pointerdown', (e) => e.preventDefault());
        li.addEventListener('click', () => choose(row));
        li.addEventListener('pointermove', () => {
          if (active !== i) {
            active = i;
            mark();
          }
        });
        return li;
      };
      const render = () => {
        const raw = input.value.trimStart();
        const commandsOnly = raw.startsWith('>');
        const q = (commandsOnly ? raw.slice(1) : raw).trim().toLowerCase();
        const noteRows = commandsOnly
          ? []
          : (q ? notes.filter((n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)) : notes)
              .slice(0, q ? 40 : 6)
              .map((n) => ({ kind: 'note', ...n }));
        const createRows = !commandsOnly && q && !notes.some((n) => n.title.toLowerCase() === q) ? [{ kind: 'create', title: raw.trim() }] : [];
        const commandRows = commands
          .filter((c) => !q || c.title.toLowerCase().includes(q) || (c.keywords ?? '').includes(q))
          .map((c) => ({ kind: 'command', ...c }));
        rows = [...noteRows, ...createRows, ...commandRows];
        active = Math.min(active, Math.max(0, rows.length - 1));
        let i = 0;
        const nodes = [];
        if (noteRows.length) nodes.push(h('li', { class: 'qs-section' }, 'Заметки'));
        for (const row of [...noteRows, ...createRows]) nodes.push(rowNode(row, i++, q));
        if (commandRows.length) nodes.push(h('li', { class: 'qs-section' }, 'Команды'));
        for (const row of commandRows) nodes.push(rowNode(row, i++, q));
        list.replaceChildren(...nodes);
        if (!rows.length) list.append(h('li', { class: 'qs-empty' }, 'Ничего не нашлось'));
      };
      input.addEventListener('input', () => {
        active = 0;
        render();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          active = Math.max(0, Math.min(rows.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
          mark();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (rows[active]) choose(rows[active]);
        }
      });
      box.append(input, list, h('div', { class: 'modal-hint qs-hint' }, '↑↓ выбрать · Enter открыть · > только команды · Esc закрыть'));
      render();
    },
    { className: 'qs' },
  );
}

/**
 * Ctrl+,: the look of the app. Changes apply at once; getPrefs() is read again after each one,
 * so the dialog always shows what is on screen.
 */
export function openSettings({ getPrefs, onChange, data }) {
  openDialog(
    (box, close) => {
      const body = h('div', { class: 'set-body' });
      const choice = (key, value, node) => {
        node.dataset.focusKey = `${key}:${value}`;
        node.addEventListener('click', () => {
          onChange({ [key]: value });
          draw();
        });
        return node;
      };
      const group = (label, ...content) => h('section', { class: 'set-group' }, h('div', { class: 'set-label' }, label), ...content);

      function draw() {
        const prefs = getPrefs();
        const focused = document.activeElement?.dataset?.focusKey;
        const skins = h(
          'div',
          { class: 'set-skins', role: 'radiogroup', 'aria-label': 'Оформление' },
          SKINS.map((skin) =>
            choice(
              'skin',
              skin.id,
              h(
                'button',
                { type: 'button', class: `set-skin set-skin-${skin.id}`, role: 'radio', 'aria-checked': String(prefs.skin === skin.id) },
                h('span', { class: 'set-skin-art', 'aria-hidden': 'true' }),
                h('span', { class: 'set-skin-title' }, skin.title),
                h('span', { class: 'set-skin-about' }, skin.about),
              ),
            ),
          ),
        );
        const themes = h(
          'div',
          { class: 'seg', role: 'radiogroup', 'aria-label': 'Тема' },
          THEMES.map((theme) =>
            choice('theme', theme.id, h('button', { type: 'button', class: 'seg-btn', role: 'radio', 'aria-checked': String(prefs.theme === theme.id) }, theme.title)),
          ),
        );
        const atlas = prefs.skin === 'atlas';
        const accents = h(
          'div',
          { class: 'set-swatches', role: 'radiogroup', 'aria-label': 'Акцент' },
          ACCENTS.map((accent) =>
            choice(
              'accent',
              accent.id,
              h(
                'button',
                {
                  type: 'button',
                  class: 'set-swatch',
                  role: 'radio',
                  'data-swatch': accent.id,
                  title: accent.title,
                  'aria-label': accent.title,
                  'aria-checked': String(prefs.accent === accent.id),
                  disabled: atlas || null,
                },
                h('span', { class: 'set-swatch-name' }, accent.title),
              ),
            ),
          ),
        );
        const size = h(
          'div',
          { class: 'set-size' },
          choice('fontScale', prefs.fontScale - 0.08, h('button', { type: 'button', class: 'seg-btn', 'aria-label': 'Мельче' }, '−')),
          h('span', { class: 'set-size-value' }, `${Math.round(prefs.fontScale * 100)}%`),
          choice('fontScale', prefs.fontScale + 0.08, h('button', { type: 'button', class: 'seg-btn', 'aria-label': 'Крупнее' }, '+')),
          choice('fontScale', 1, h('button', { type: 'button', class: 'seg-btn seg-reset' }, 'Сбросить')),
        );
        const storage = data
          ? group(
              'Заметки',
              h('div', { class: 'set-note' }, data.text),
              h(
                'div',
                { class: 'set-actions' },
                data.actions.map((action) =>
                  h('button', { type: 'button', class: 'seg-btn', onclick: () => { close(null); action.run(); } }, action.text),
                ),
              ),
            )
          : null;
        body.replaceChildren(
          group('Оформление', skins),
          group('Тема', themes),
          group('Акцент', accents, atlas ? h('div', { class: 'set-note' }, 'У «Атласа» своя палитра, акцент работает в «Минимале».') : null),
          group('Размер текста', size),
          storage,
        );
        // keep keyboard focus on the control that was just used
        if (focused) body.querySelector(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus();
      }

      box.append(
        h('div', { class: 'modal-kicker' }, 'Настройки'),
        h('h2', { class: 'modal-title' }, 'Внешний вид'),
        body,
        h(
          'div',
          { class: 'modal-actions' },
          h('span', { class: 'modal-hint' }, 'Ctrl+, настройки · Ctrl+K команды'),
          h('button', { type: 'button', class: 'btn primary', onclick: () => close(null), 'data-autofocus': true }, 'Готово'),
        ),
      );
      draw();
    },
    { className: 'modal-settings' },
  );
}

let toastNode = null;
let toastTimer = 0;

export function toast(message, { action, timeout = 4200 } = {}) {
  toastNode?.remove();
  clearTimeout(toastTimer);
  const node = h('div', { class: 'toast', role: 'status' }, h('span', {}, message));
  if (action) {
    node.append(
      h('button', {
        type: 'button',
        onclick: () => {
          node.remove();
          action.run();
        },
      }, action.text),
    );
  }
  layer().append(node);
  toastNode = node;
  toastTimer = setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

/** A non-dismissable notice over everything (another window took over, or startup failed). */
export function showBlocker({ title, text, action }) {
  openDialog(
    (box) => {
      box.append(
        h('div', { class: 'modal-kicker' }, 'ATLAS'),
        h('h2', { class: 'modal-title' }, title),
        h('p', { class: 'modal-text' }, text),
        action ? h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn primary', onclick: action.run }, action.text)) : null,
      );
    },
    { dismissable: false, className: 'modal-blocker' },
  );
}

// Back and forward one step (↶ ↷), on every screen that changes something. Each screen keeps its own
// history: the open note its text (CodeMirror's, editor.js), a book its marks, bookmarks and texts
// (library.js), the notes screen and the library their deletions, moves and folders. A step is
// { undo, redo }; the screens record one by taking a snapshot before and after what was done
// (changedKeys says which entries a step touches, so going back leaves everything else alone).

import { h } from './overlays.js';
import { t } from './i18n.js';

/**
 * A history of steps. While one is being replayed nothing new is recorded (the replay changes things
 * too). A step may say how heavy it is (`weight`, e.g. the length of the snapshot it keeps): past
 * `budget` in all, the oldest steps are dropped, so a book with a thousand long marks does not fill a
 * phone's memory with copies of them.
 */
export function createSteps({ limit = 50, budget = Infinity, onChange = () => {} } = {}) {
  let back = [];
  let ahead = [];
  let busy = false;
  const weight = () => [...back, ...ahead].reduce((sum, step) => sum + (step.weight ?? 0), 0);

  async function walk(from, to, way) {
    if (busy || !from.length) return false;
    busy = true;
    const step = from.pop();
    try {
      await step[way]();
      to.push(step);
    } catch (err) {
      console.error(err);
    } finally {
      busy = false;
      onChange();
    }
    return true;
  }

  return {
    push(step) {
      if (busy) return;
      back.push(step);
      ahead = [];
      while (back.length > limit || (back.length > 1 && weight() > budget)) back.shift();
      onChange();
    },
    undo: () => walk(back, ahead, 'undo'),
    redo: () => walk(ahead, back, 'redo'),
    canUndo: () => back.length > 0,
    canRedo: () => ahead.length > 0,
    replaying: () => busy,
    clear() {
      if (!back.length && !ahead.length) return;
      back = [];
      ahead = [];
      onChange();
    },
  };
}

/** The keys of two { key: value } snapshots whose values differ (a missing key counts as null). */
export function changedKeys(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null));
}

/**
 * Ctrl+Z one step back; Ctrl+Y or Ctrl+Shift+Z one step forward, by the key's place (any keyboard
 * layout). Not inside a field: that undoes its own typing.
 */
export function stepKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.target?.closest?.('input, textarea, [contenteditable="true"], .cm-content')) return null;
  if (e.code === 'KeyZ') return e.shiftKey ? 'redo' : 'undo';
  if (e.code === 'KeyY' && !e.shiftKey) return 'redo';
  return null;
}

const ARROW_BACK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 6.5h5a3 3 0 0 1 0 6H8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M7.5 3.8 4.8 6.5l2.7 2.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ARROW_AHEAD = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 6.5h-5a3 3 0 0 0 0 6H8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="m8.5 3.8 2.7 2.7-2.7 2.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * The pair of buttons. They never take the focus, so the cursor stays in the text and a phone's
 * keyboard stays up. `hideEmpty`: with nothing to undo or redo the pair is not shown at all.
 */
export function stepButtons({ undo, redo, className = '', hideEmpty = false }) {
  // the names follow the language with the rest of the page (data-i18n-*, app.js applyLanguage)
  const button = (svg, run, cls, key) => {
    const node = h('button', {
      type: 'button',
      class: `tb-btn icon step-btn ${cls}`,
      disabled: true,
      title: t(`${key}Key`),
      'aria-label': t(key),
      'data-i18n-title': `${key}Key`,
      'data-i18n-label': key,
    });
    node.innerHTML = svg;
    node.addEventListener('pointerdown', (e) => e.preventDefault());
    node.addEventListener('click', () => run());
    return node;
  };
  const back = button(ARROW_BACK, undo, 'step-back', 'steps.back');
  const ahead = button(ARROW_AHEAD, redo, 'step-ahead', 'steps.ahead');
  const node = h('span', { class: `step-pair ${className}`.trim(), hidden: hideEmpty }, back, ahead);
  return {
    node,
    /** { canUndo, canRedo }: which of the two can be pressed now. */
    update({ canUndo, canRedo }) {
      back.disabled = !canUndo;
      ahead.disabled = !canRedo;
      if (hideEmpty) node.hidden = !canUndo && !canRedo;
    },
  };
}

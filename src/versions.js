// The note's history: its earlier versions, newest first; one chosen shows how it differs from the text
// now (− was in that version, + came after), and can be put back. Putting one back is one step in the
// note's own history, so ↶ undoes it, and the text as it was is kept as a version first.

import { h, openDialog } from './overlays.js';
import { count, formatDay, formatTime, t } from './i18n.js';
import { diffCounts, diffLines } from './diff.js';

const CONTEXT = 2; // unchanged lines shown on each side of a change

/** Runs of unchanged lines longer than a few are folded to their edges. */
function foldSame(ops) {
  const out = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op !== 'same') {
      out.push(ops[i++]);
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j].op === 'same') j++;
    const run = ops.slice(i, j);
    const head = i === 0 ? 0 : CONTEXT;
    const tail = j === ops.length ? 0 : CONTEXT;
    if (run.length > head + tail + 1) {
      out.push(...run.slice(0, head), { op: 'fold', count: run.length - head - tail }, ...run.slice(run.length - tail));
    } else out.push(...run);
    i = j;
  }
  return out;
}

/**
 * current(): the note's text now; list(): [{ at, chars }]; read(at): a version's text;
 * onRestore(text, at): put it back (the caller keeps the text as it was first).
 */
export function openVersions({ title, current, list, read, onRestore }) {
  openDialog(
    (box, close) => {
      const items = h('ol', { class: 'ver-list' });
      const summary = h('p', { class: 'ver-summary' });
      const view = h('div', { class: 'ver-diff' });
      const restore = h('button', { type: 'button', class: 'btn primary', disabled: true }, t('versions.restore'));
      let chosen = null; // { at, text }

      box.append(
        h('div', { class: 'modal-kicker' }, t('versions.title')),
        h('h2', { class: 'modal-title' }, title),
        h('p', { class: 'modal-text ver-hint' }, t('versions.hint')),
        items,
        summary,
        view,
        h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn', 'data-autofocus': true, onclick: () => close(null) }, t('versions.close')), restore),
      );

      restore.addEventListener('click', async () => {
        if (!chosen) return;
        restore.disabled = true;
        await onRestore(chosen.text, chosen.at);
        close(null);
      });

      async function show(version, button) {
        for (const b of items.querySelectorAll('.ver-item')) b.setAttribute('aria-pressed', String(b === button));
        restore.disabled = true;
        view.replaceChildren(h('p', { class: 'ver-wait' }, t('versions.loading')));
        let text;
        try {
          text = await read(version.at);
        } catch (err) {
          view.replaceChildren(h('p', { class: 'ver-wait' }, err.message));
          return;
        }
        if (button.getAttribute('aria-pressed') !== 'true') return; // another one was chosen meanwhile
        const ops = diffLines(text, current());
        const { added, removed } = diffCounts(ops);
        chosen = { at: version.at, text };
        restore.disabled = !added && !removed;
        summary.textContent = added || removed ? t('versions.changes', added, removed) : t('versions.same');
        view.replaceChildren(
          ...foldSame(ops).map((line) =>
            line.op === 'fold'
              ? h('div', { class: 'ver-line fold' }, t('versions.folded', line.count))
              : h('div', { class: `ver-line ${line.op}` }, h('span', { class: 'ver-sign', 'aria-hidden': 'true' }, line.op === 'add' ? '+' : line.op === 'del' ? '−' : ' '), line.text || ' '),
          ),
        );
      }

      list()
        .then((versions) => {
          if (!versions.length) {
            items.replaceChildren(h('li', { class: 'ver-none' }, t('versions.none')));
            return;
          }
          items.replaceChildren(
            ...versions.map((version) => {
              const button = h(
                'button',
                { type: 'button', class: 'ver-item', 'aria-pressed': 'false' },
                h('span', { class: 'ver-when' }, `${formatDay(version.at)}, ${formatTime(version.at)}`),
                h('span', { class: 'ver-size' }, count(version.chars, 'char')),
              );
              button.addEventListener('click', () => show(version, button));
              return h('li', {}, button);
            }),
          );
          show(versions[0], items.querySelector('.ver-item'));
        })
        .catch((err) => items.replaceChildren(h('li', { class: 'ver-none' }, err.message)));
    },
    { className: 'modal-versions' },
  );
}

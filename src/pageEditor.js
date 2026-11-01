// The page editor of a PDF: every page as a small picture, to turn, remove, move (drag, or the arrow
// buttons on a phone) or bring in from another PDF. Nothing changes until "Save"; then the reader
// writes a new file (reader/pdfedit.js) and the library keeps the old one in its trash.

import { h, toast, confirmDialog, isOverlayOpen } from './overlays.js';
import { t } from './i18n.js';

/**
 * code: window.AtlasReader; bytes: the document's file; title: its name;
 * onSave(bytes, plan) → promise, once the new file is made. Resolves when the editor closes.
 */
export function openPageEditor({ code, bytes, title, onSave }) {
  return new Promise((resolve) => {
    const sources = [bytes]; // 0: the document; more when pages are brought in
    const viewers = []; // per source: { count, thumbnail(n), close }
    let tiles = []; // { key, src, page, turn }
    let changed = false;
    let busy = false;
    let dragKey = null;
    let seq = 0;

    const heading = h('span', { class: 'pe-title' });
    const saveButton = h('button', { type: 'button', class: 'tb-btn accent', disabled: true, onclick: save }, t('pages.save'));
    const addButton = h('button', { type: 'button', class: 'tb-btn', onclick: addPdf }, '＋ ', t('pages.addPdf'));
    const cancelButton = h('button', { type: 'button', class: 'tb-btn', onclick: () => finish() }, t('pages.cancel'));
    const grid = h('ol', { class: 'pe-grid' });
    const hint = h('p', { class: 'pe-hint' }, t('pages.hint'));
    const root = h(
      'section',
      { class: 'pe', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('pages.title') },
      h('header', { class: 'pe-head' }, h('div', { class: 'pe-titles' }, heading, h('span', { class: 'pe-sub' }, title)), addButton, cancelButton, saveButton),
      hint,
      h('div', { class: 'pe-body' }, grid),
    );
    document.body.append(root);

    const pictures = new Map(); // `${src}:${page}` → canvas, drawn once
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          observer.unobserve(e.target);
          const tile = tiles.find((x) => x.key === e.target.dataset.key);
          if (tile) drawPicture(tile, e.target.querySelector('.pe-pic'));
        }
      },
      { root: root.querySelector('.pe-body'), rootMargin: '400px' },
    );

    async function drawPicture(tile, holder) {
      const id = `${tile.src}:${tile.page}`;
      try {
        let canvas = pictures.get(id);
        if (!canvas) {
          canvas = await viewers[tile.src].thumbnail(tile.page, 180);
          pictures.set(id, canvas);
        }
        // the same page may sit in two tiles: each gets its own copy
        const copy = holder.querySelector('canvas') ?? document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        copy.getContext('2d').drawImage(canvas, 0, 0);
        holder.replaceChildren(copy);
      } catch (err) {
        console.warn(err);
      }
    }

    function mark() {
      changed = true;
      saveButton.disabled = busy || !tiles.length;
      render();
    }

    function move(key, to) {
      const from = tiles.findIndex((x) => x.key === key);
      if (from < 0 || to < 0 || to >= tiles.length || from === to) return;
      const [tile] = tiles.splice(from, 1);
      tiles.splice(to, 0, tile);
      mark();
      grid.querySelector(`[data-key="${key}"] .pe-pic`)?.focus?.();
    }

    function render() {
      heading.textContent = t('pages.count', tiles.length);
      const old = new Map([...grid.children].map((li) => [li.dataset.key, li]));
      const items = tiles.map((tile, i) => {
        let li = old.get(tile.key);
        if (!li) {
          li = h('li', { class: 'pe-tile', 'data-key': tile.key, draggable: 'true' });
          li.append(
            h('div', { class: 'pe-pic', tabindex: '0' }),
            h('div', { class: 'pe-label' }),
            h(
              'div',
              { class: 'pe-tools' },
              h('button', { type: 'button', title: t('pages.left'), 'aria-label': t('pages.left'), onclick: () => move(tile.key, tiles.indexOf(tile) - 1) }, '←'),
              h('button', { type: 'button', title: t('pages.turnLeft'), 'aria-label': t('pages.turnLeft'), onclick: () => turn(tile, -90) }, '↺'),
              h('button', { type: 'button', title: t('pages.turnRight'), 'aria-label': t('pages.turnRight'), onclick: () => turn(tile, 90) }, '↻'),
              h('button', { type: 'button', class: 'pe-remove', title: t('pages.remove'), 'aria-label': t('pages.remove'), onclick: () => remove(tile) }, '✕'),
              h('button', { type: 'button', title: t('pages.right'), 'aria-label': t('pages.right'), onclick: () => move(tile.key, tiles.indexOf(tile) + 1) }, '→'),
            ),
          );
          li.addEventListener('dragstart', (e) => {
            dragKey = tile.key;
            li.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', tile.key);
          });
          li.addEventListener('dragend', () => {
            dragKey = null;
            li.classList.remove('dragging');
            grid.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
          });
          li.addEventListener('dragover', (e) => {
            if (!dragKey || dragKey === tile.key) return;
            e.preventDefault();
            const r = li.getBoundingClientRect();
            const after = e.clientX > r.left + r.width / 2;
            li.classList.toggle('drop-after', after);
            li.classList.toggle('drop-before', !after);
          });
          li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
          li.addEventListener('drop', (e) => {
            if (!dragKey) return;
            e.preventDefault();
            const r = li.getBoundingClientRect();
            const after = e.clientX > r.left + r.width / 2;
            const from = tiles.findIndex((x) => x.key === dragKey);
            let to = tiles.indexOf(tile) + (after ? 1 : 0);
            if (from < to) to -= 1;
            li.classList.remove('drop-before', 'drop-after');
            move(dragKey, to);
          });
          observer.observe(li);
        }
        li.querySelector('.pe-pic').style.setProperty('--turn', `${tile.turn}deg`);
        li.classList.toggle('turned', tile.turn % 180 !== 0);
        const label = li.querySelector('.pe-label');
        label.textContent = tile.src === 0 ? `${i + 1}` : `${i + 1} · ${t('pages.fromOther', tile.src, tile.page)}`;
        const [left, , , , right] = li.querySelector('.pe-tools').children;
        left.disabled = i === 0;
        right.disabled = i === tiles.length - 1;
        return li;
      });
      grid.replaceChildren(...items);
    }

    function turn(tile, by) {
      tile.turn = (((tile.turn + by) % 360) + 360) % 360;
      mark();
    }

    function remove(tile) {
      if (tiles.length === 1) {
        toast(t('pages.lastPage'));
        return;
      }
      tiles = tiles.filter((x) => x !== tile);
      mark();
    }

    async function addSource(fileBytes) {
      const viewer = await code.openPages(fileBytes);
      const src = sources.length;
      sources.push(fileBytes);
      viewers.push(viewer);
      for (let page = 1; page <= viewer.count; page++) tiles.push({ key: `t${seq++}`, src, page, turn: 0 });
      return viewer.count;
    }

    function addPdf() {
      const input = h('input', { type: 'file', accept: '.pdf,application/pdf' });
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        try {
          const n = await addSource(new Uint8Array(await file.arrayBuffer()));
          mark();
          toast(t('pages.added', n, file.name));
          grid.lastElementChild?.scrollIntoView({ block: 'nearest' });
        } catch (err) {
          console.error(err);
          toast(t('pages.notPdf', file.name));
        }
      });
      input.click();
    }

    async function save() {
      if (busy || !tiles.length) return;
      busy = true;
      saveButton.disabled = true;
      saveButton.textContent = t('pages.saving');
      try {
        const plan = tiles.map(({ src, page, turn: angle }) => ({ src, page, turn: angle }));
        const out = await code.rebuildPdf(sources, plan);
        await onSave(out, plan);
        finish(true);
      } catch (err) {
        console.error(err);
        toast(err.encrypted ? t('pages.encrypted') : t('pages.failed', err.message));
        busy = false;
        saveButton.disabled = false;
        saveButton.textContent = t('pages.save');
      }
    }

    async function finish(saved = false) {
      if (!saved && changed && !busy) {
        const ok = await confirmDialog({ title: t('pages.discardTitle'), text: t('pages.discardBody'), ok: t('pages.discard'), danger: true }).catch(() => true);
        if (!ok) return;
      }
      observer.disconnect();
      viewers.forEach((v) => v.close());
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      resolve(saved);
    }

    function onKey(e) {
      if (isOverlayOpen()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish();
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
        e.preventDefault();
        e.stopPropagation();
        save();
      } else if (e.target.classList?.contains('pe-pic') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.altKey) {
        e.preventDefault();
        const key = e.target.closest('.pe-tile').dataset.key;
        move(key, tiles.findIndex((x) => x.key === key) + (e.key === 'ArrowLeft' ? -1 : 1));
      }
    }
    document.addEventListener('keydown', onKey, true);

    (async () => {
      try {
        const viewer = await code.openPages(bytes);
        viewers.push(viewer);
        for (let page = 1; page <= viewer.count; page++) tiles.push({ key: `t${seq++}`, src: 0, page, turn: 0 });
        render();
        grid.querySelector('.pe-pic')?.focus({ preventScroll: true });
      } catch (err) {
        console.error(err);
        toast(t('pages.failed', err.message));
        finish();
      }
    })();
  });
}

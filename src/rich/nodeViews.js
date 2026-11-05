import { TextSelection } from 'prosemirror-state';
import { t } from '../i18n.js';

export function nodeViews(options) {
  return {
    task_item(node, view, getPos) {
      const dom = document.createElement('li'); dom.className = 'rich-task';
      const check = document.createElement('input'); check.type = 'checkbox'; check.contentEditable = 'false'; check.setAttribute('aria-label', t('rich.taskDone'));
      const control = document.createElement('label'); control.className = 'rich-task-control'; control.contentEditable = 'false'; control.append(check);
      const contentDOM = document.createElement('div'); contentDOM.className = 'rich-task-text'; dom.append(control, contentDOM);
      const update = (next) => { if (next.type !== node.type) return false; node = next; check.checked = node.attrs.checked; dom.dataset.checked = String(node.attrs.checked); return true; };
      update(node);
      check.addEventListener('pointerdown', (event) => event.preventDefault());
      check.addEventListener('click', (event) => { event.preventDefault(); if (view.editable) view.dispatch(view.state.tr.setNodeMarkup(getPos(), null, { checked: !node.attrs.checked })); else check.checked = node.attrs.checked; });
      return { dom, contentDOM, update, stopEvent: (event) => control.contains(event.target), ignoreMutation: (mutation) => control.contains(mutation.target) || mutation.target === dom };
    },
    details(node, view, getPos) {
      const dom = document.createElement('section'); dom.className = 'rich-details';
      const controls = document.createElement('div'); controls.className = 'rich-details-controls'; controls.contentEditable = 'false';
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'rich-details-toggle';
      const after = document.createElement('button'); after.type = 'button'; after.className = 'rich-block-after'; after.textContent = t('rich.afterBlock');
      controls.append(toggle, after);
      const contentDOM = document.createElement('div'); contentDOM.className = 'rich-details-content'; dom.append(controls, contentDOM);
      let open = node.attrs.open;
      const paint = () => { dom.classList.toggle('is-closed', !open); toggle.textContent = open ? '▾' : '▸'; toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-label', t(open ? 'accordion.collapse' : 'accordion.expand') + ': ' + node.firstChild.textContent); };
      paint();
      toggle.addEventListener('pointerdown', (event) => event.preventDefault());
      toggle.addEventListener('click', () => {
        open = !open;
        if (view.editable) {
          const tr = view.state.tr.setNodeMarkup(getPos(), null, { open });
          if (!open && tr.selection.from > getPos() + node.firstChild.nodeSize + 1 && tr.selection.from < getPos() + node.nodeSize) tr.setSelection(TextSelection.near(tr.doc.resolve(getPos() + 2)));
          view.dispatch(tr);
        } else paint();
      });
      after.addEventListener('pointerdown', (event) => event.preventDefault());
      after.addEventListener('click', () => {
        if (!view.editable) return;
        const at = getPos() + node.nodeSize;
        const tr = view.state.tr.insert(at, view.state.schema.nodes.paragraph.create());
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).setStoredMarks([]).scrollIntoView()); view.focus();
      });
      return { dom, contentDOM, update(next) { if (next.type !== node.type) return false; const changed = next.attrs.open !== node.attrs.open; node = next; if (changed || view.editable) open = node.attrs.open; paint(); return true; }, stopEvent: (event) => controls.contains(event.target), ignoreMutation: (mutation) => controls.contains(mutation.target) || mutation.target === dom };
    },
    image(node) {
      const dom = document.createElement('img'); dom.className = 'rich-image'; dom.alt = node.attrs.alt;
      let active = true;
      if (node.attrs.src.startsWith('assets/')) options.resolveImage(node.attrs.src.slice(7)).then((url) => { if (active && url) dom.src = url; });
      else dom.src = node.attrs.src;
      dom.addEventListener('click', (event) => { if (dom.src) { event.preventDefault(); options.openImage(dom.src, node.attrs.alt); } });
      return { dom, stopEvent: (event) => event.type === 'click', destroy() { active = false; } };
    },
    source_block(node, view, getPos) {
      const dom = document.createElement('div'); dom.className = 'rich-source-block'; dom.contentEditable = 'false';
      const label = document.createElement('strong'); label.textContent = t('rich.sourceFragment');
      const preview = document.createElement('pre'); preview.textContent = node.attrs.raw.slice(0, 200);
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = t('rich.editSource'); edit.addEventListener('click', () => options.onSourceNode?.(getPos()));
      dom.append(label, preview, edit);
      return { dom, stopEvent: () => true, ignoreMutation: () => true };
    },
  };
}

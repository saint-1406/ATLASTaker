// Native editor controls over portable Markdown; no note HTML is inserted into the DOM.
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { accordionBlocks, insertAccordion, renameAccordion, toggleAccordion } from './accordion.js';
import { t } from './i18n.js';

const previewToggle = StateEffect.define({ map: (value, changes) => ({ ...value, from: changes.mapPos(value.from) }) });

class AccordionHeader extends WidgetType {
  constructor(block, open, readOnly) {
    super();
    Object.assign(this, { block, open, readOnly });
  }

  updateDOM(node) {
    node.atlasBlock = this.block;
    node.dataset.from = String(this.block.from);
    const toggle = node.querySelector('button');
    toggle.textContent = this.open ? '▾' : '▸';
    toggle.setAttribute('aria-expanded', String(this.open));
    toggle.setAttribute('aria-label', `${t(this.open ? 'accordion.collapse' : 'accordion.expand')}: ${this.block.title}`);
    const input = node.querySelector('input');
    input.readOnly = this.readOnly;
    input.setAttribute('aria-label', t('accordion.title'));
    if (document.activeElement !== input) input.value = this.block.title;
    return true;
  }

  toDOM(view) {
    const node = document.createElement('div');
    node.className = 'cm-accordion-head';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cm-accordion-title';
    input.value = this.block.title;
    node.append(toggle, input);
    this.updateDOM(node);
    toggle.addEventListener('mousedown', (event) => event.preventDefault());
    toggle.addEventListener('click', () => {
      const block = node.atlasBlock;
      if (view.state.readOnly) {
        view.dispatch({ effects: previewToggle.of({ from: block.from, open: toggle.getAttribute('aria-expanded') !== 'true' }) });
      } else {
        view.dispatch(toggleAccordion(view.state, block));
      }
      view.requestMeasure();
    });
    input.addEventListener('input', () => {
      if (view.state.readOnly) return;
      const block = node.atlasBlock;
      view.dispatch(renameAccordion(view.state, block, input.value));
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.preventDefault();
      const block = node.atlasBlock;
      // Enter leaves the title and starts writing in the expanded body; Escape returns to the note.
      if (event.key === 'Enter' && !view.state.readOnly && !block.open) view.dispatch(toggleAccordion(view.state, block));
      const current = accordionBlocks(view.state.doc.toString()).find((b) => b.from === block.from);
      view.dispatch({ selection: { anchor: event.key === 'Enter' && current ? Math.min(current.bodyFrom + 1, current.closeFrom) : block.from }, scrollIntoView: true });
      view.focus();
    });
    return node;
  }

  ignoreEvent() { return true; }
}

function draw(state, transient) {
  const decorations = [];
  let hiddenUntil = -1;
  for (const block of accordionBlocks(state.doc.toString())) {
    if (block.from < hiddenUntil) continue;
    const open = state.readOnly ? transient.get(block.from) ?? block.open : block.open;
    decorations.push(Decoration.replace({ widget: new AccordionHeader(block, open, state.readOnly), block: true }).range(block.from, block.summaryTo));
    if (!open) {
      decorations.push(Decoration.replace({ block: true }).range(block.summaryTo, block.to));
      hiddenUntil = block.to;
    } else decorations.push(Decoration.replace({ block: true }).range(block.closeFrom, block.to));
  }
  return Decoration.set(decorations, true);
}

export const accordionField = StateField.define({
  create: (state) => ({ transient: new Map(), decorations: draw(state, new Map()) }),
  update(value, tr) {
    if (!tr.docChanged && !tr.reconfigured && !tr.effects.some((e) => e.is(previewToggle))) return value;
    const transient = new Map();
    if (tr.state.readOnly) for (const [from, open] of value.transient) transient.set(tr.changes.mapPos(from), open);
    for (const effect of tr.effects) if (effect.is(previewToggle)) transient.set(effect.value.from, effect.value.open);
    return { transient, decorations: draw(tr.state, transient) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export const accordionExtension = [accordionField, EditorView.atomicRanges.of((view) => view.state.field(accordionField).decorations)];

/** Inserts and focuses the title without making the phone keyboard disappear. */
export function insertAccordionBlock(view) {
  const spec = insertAccordion(view.state, t('accordion.defaultTitle'));
  if (!spec) return false;
  view.dispatch(spec);
  const titleAt = view.state.selection.main.from;
  const block = accordionBlocks(view.state.doc.toString()).find((b) => b.titleFrom === titleAt);
  const input = block && view.dom.querySelector(`.cm-accordion-head[data-from="${block.from}"] input`);
  if (input) { input.focus(); input.select(); }
  return true;
}

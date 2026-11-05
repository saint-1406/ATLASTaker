// Two explicit editing modes over one unchanged Markdown persistence contract.
import { createEditor as createSourceEditor } from './editor.js';
import { createRichEditor } from './rich/editor.js';

export function createEditor(options) {
  const host = options.parent;
  host.classList.add('note-editor-scroll');
  const visualHost = document.createElement('div'); visualHost.className = 'note-visual-host';
  const sourceHost = document.createElement('div'); sourceHost.className = 'note-source-host'; sourceHost.hidden = true;
  host.append(visualHost, sourceHost);
  let mode = 'visual', editable = true, rich, sharedHistory = false;
  function historyAction(kind) { sharedHistory = true; try { return rich[kind](); } finally { sharedHistory = false; } }
  const refresh = () => host.dispatchEvent(new Event('formatstatechange'));
  const source = createSourceEditor({ ...options, parent: sourceHost, raw: true,
    onUndo: () => historyAction('undo'), onRedo: () => historyAction('redo'),
    onDocChange(update) {
      if (mode !== 'source') return;
      rich.adopt(update.state); options.onDocChange(update); refresh();
    },
    onSelectionChange(update) { if (mode === 'source') { options.onSelectionChange(update); refresh(); } },
  });
  const facade = {
    get state() { return mode === 'visual' ? rich.sourceState : source.view.state; },
    get rich() { return mode === 'visual' ? rich : null; },
    get dom() { return mode === 'visual' ? rich.view.dom : source.view.dom; },
    get contentDOM() { return mode === 'visual' ? rich.view.dom : source.view.contentDOM; },
    get scrollDOM() { return host; },
    get composing() { return mode === 'visual' ? rich.view.composing : source.view.composing; },
    dispatch(...specs) {
      if (specs[0]?.isUserEvent?.('undo')) { historyAction('undo'); return; }
      if (specs[0]?.isUserEvent?.('redo')) { historyAction('redo'); return; }
      if (mode === 'visual') rich.dispatchSource(...specs); else source.view.dispatch(...specs);
    },
    focus() { if (mode === 'visual') rich.view.focus(); else source.view.focus(); },
    requestMeasure() { if (mode === 'source') source.view.requestMeasure(); },
    coordsAtPos(pos) { return mode === 'visual' ? rich.view.coordsAtPos(rich.mapping.toDocument(pos)) : source.view.coordsAtPos(pos); },
    posAtCoords(coords) {
      if (mode === 'source') return source.view.posAtCoords(coords);
      const found = rich.view.posAtCoords({ left: coords.x, top: coords.y });
      return found ? rich.mapping.toSource(found.pos) : null;
    },
  };
  rich = createRichEditor({ ...options, parent: visualHost, makeState: source.makeState, getFacade: () => facade,
    onDocChange: (update) => { if (mode === 'source' && sharedHistory) source.show(update.state); if (mode === 'visual' || sharedHistory) options.onDocChange(update); },
    onSelectionChange: (update) => { if (mode === 'source' && sharedHistory) source.show(update.state); if (mode === 'visual' || sharedHistory) options.onSelectionChange(update); },
    onFormatChange: refresh,
    onSourceNode: (pos) => { setMode('source'); source.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true }); source.view.focus(); options.onModeChange?.('source'); },
  });
  function setMode(next) {
    if (next !== 'visual' && next !== 'source' || next === mode) return;
    const scroll = host.scrollTop;
    const hadFocus = host.contains(document.activeElement);
    if (next === 'source') source.show(rich.sourceState);
    else rich.adopt(source.view.state);
    mode = next;
    sourceHost.hidden = mode !== 'source'; visualHost.hidden = mode !== 'visual';
    host.dataset.editorMode = mode;
    source.setEditable(editable); rich.setEditable(editable);
    if (hadFocus && editable) facade.focus();
    requestAnimationFrame(() => { host.scrollTop = scroll; if (mode === 'source') source.view.requestMeasure(); });
    refresh();
  }
  host.dataset.editorMode = mode;
  queueMicrotask(refresh);
  return {
    view: facade,
    makeState: source.makeState,
    show(state) { if (mode === 'visual') rich.show(state); else { source.show(state); rich.show(state); } refresh(); },
    localize() { source.localize(); rich.localize(); refresh(); },
    setEditable(on) { editable = on; source.setEditable(on); rich.setEditable(on); refresh(); },
    isEditable: () => editable,
    setFocusDim(value, lang) { source.setFocusDim(value, lang); rich.setFocusDim(value); },
    setMarkup(hide) { setMode(hide ? 'visual' : 'source'); },
    setMode,
    getMode: () => mode,
    undo: () => historyAction('undo'),
    redo: () => historyAction('redo'),
    steps: () => rich.steps(),
    getSelectedText: () => mode === 'visual' ? rich.getSelectedText() : source.view.state.sliceDoc(source.view.state.selection.main.from, source.view.state.selection.main.to),
    getPlainText: () => mode === 'visual' ? rich.getPlainText() : source.view.state.doc.toString(),
    showSearch: () => { if (mode === 'visual') rich.showSearch(); },
    destroy() { rich.destroy(); source.view.destroy(); },
  };
}

import { EditorState as SourceState, EditorSelection } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, redo, undoDepth, redoDepth, closeHistory } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { sinkListItem, liftListItem } from 'prosemirror-schema-list';
import { columnResizing, tableEditing, goToNextCell } from 'prosemirror-tables';
import { richSchema as schema, safeLink } from './schema.js';
import { parseMarkdown, serializeMarkdown } from './markdown.js';
import { activeFormats, backspaceDetails, enterLine, insertDetails, nextItem, normalParagraph, paragraphAfterBlock, setParagraphType, shiftEnter, toggleFormat } from './commands.js';
import { nodeViews } from './nodeViews.js';
import { findMatches, focusKey, focusPlugin, searchKey, searchPlugin } from './plugins.js';
import { t } from '../i18n.js';
import { fromTouch } from '../touch.js';

const fitSelection = (doc, from, to = from) => {
  from = Math.max(0, Math.min(doc.content.size, from)); to = Math.max(0, Math.min(doc.content.size, to));
  const a = TextSelection.near(doc.resolve(from)).from, b = TextSelection.near(doc.resolve(to)).from;
  return TextSelection.create(doc, a, b);
};
const change = (old, next) => {
  let from = 0, endOld = old.length, endNew = next.length;
  while (from < endOld && from < endNew && old[from] === next[from]) from++;
  while (endOld > from && endNew > from && old[endOld - 1] === next[endNew - 1]) { endOld--; endNew--; }
  return { from, to: endOld, insert: next.slice(from, endNew) };
};

const MARK_NAMES = { bold: 'strong', italic: 'em', underline: 'underline', strike: 'strike', code: 'code' };
const BLOCK_NAMES = { paragraph: 'paragraph', bullet: 'bullet_list', numbered: 'ordered_list', task: 'task_list', quote: 'blockquote', codeblock: 'code_block' };

export function createRichEditor(options) {
  const root = options.parent;
  let editable = true, eventType = 'input.type';
  let source = options.makeState ? options.makeState('') : SourceState.create({ extensions: markdown({ base: markdownLanguage }) });
  let mapping = parseMarkdown('');
  const snapshots = new WeakMap();
  let documents = [];
  const preview = document.createElement('span'); preview.className = 'rich-dictation-preview'; preview.hidden = true;
  const search = document.createElement('div'); search.className = 'rich-search'; search.hidden = true;
  const query = document.createElement('input'); query.type = 'search'; query.placeholder = t('rich.find'); query.setAttribute('aria-label', t('rich.find'));
  const replace = document.createElement('input'); replace.placeholder = t('rich.replace'); replace.setAttribute('aria-label', t('rich.replace'));
  const action = (text, run) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.addEventListener('click', run); return button; };
  const closeSearch = () => { search.hidden = true; view.dispatch(view.state.tr.setMeta(searchKey, '').setMeta('addToHistory', false)); view.focus(); };
  search.append(query, replace, action('↑', () => navigate(-1)), action('↓', () => navigate(1)), action(t('rich.replaceOne'), () => replaceMatch(false)), action(t('rich.replaceAll'), () => replaceMatch(true)), action('×', closeSearch));
  root.append(search);

  const notify = (tr, documentChanged = tr.docChanged) => {
    const update = { state: source, startState: tr.startState, transactions: [tr], docChanged: documentChanged, selectionSet: tr.selection !== tr.startState.selection };
    if (documentChanged) options.onDocChange?.(update);
    options.onSelectionChange?.(update);
    options.onFormatChange?.();
  };
  const remember = () => snapshots.set(source, { state: view.state, mapping, documents });
  const sourceFor = (doc) => documents.find((entry) => entry.doc.eq(doc));
  const cacheDocument = () => {
    documents = [{ doc: view.state.doc, text: source.doc.toString(), mapping }, ...documents].slice(0, 100);
  };
  function sync(tr) {
    if (!editable && tr.docChanged) return;
    const previous = view.state;
    const applied = previous.applyTransaction(tr);
    const next = applied.state;
    view.updateState(next);
    if (applied.transactions.some((transaction) => transaction.docChanged)) {
      const cached = sourceFor(next.doc);
      mapping = cached?.mapping ?? serializeMarkdown(next.doc);
      const text = cached?.text ?? mapping.text;
      const edit = change(source.doc.toString(), text);
      const transaction = source.update({ changes: edit, selection: EditorSelection.single(mapping.toSource(next.selection.anchor), mapping.toSource(next.selection.head)), userEvent: eventType });
      source = transaction.state;
      cacheDocument(); remember(); notify(transaction);
    } else {
      const transaction = source.update({ selection: EditorSelection.single(mapping.toSource(next.selection.anchor), mapping.toSource(next.selection.head)) });
      source = transaction.state; remember();
      if (tr.selectionSet || previous.storedMarks !== next.storedMarks) notify(transaction, false);
    }
    preview.hidden = !preview.textContent;
  }
  const command = (run, kind = 'input.format') => {
    if (!editable) return false;
    const previous = eventType; eventType = kind;
    try { return run(view.state, view.dispatch, view); } finally { eventType = previous; }
  };
  const insertText = (text) => {
    if (!editable) return false;
    const pieces = String(text).replace(/\r\n?/g, '\n').split('\n');
    // One transaction preserves paste/dictation as one undo step and never interprets Markdown.
    let tr = view.state.tr;
    const blocks = pieces.map((part) => schema.nodes.paragraph.create(null, part ? schema.text(part, tr.storedMarks ?? tr.selection.$from.marks()) : null));
    if (pieces.length === 1) tr.insertText(pieces[0]);
    else {
      const slice = schema.nodes.doc.create(null, blocks).slice(1, blocks.reduce((size, node) => size + node.nodeSize, 0) - 1);
      tr.replaceSelection(slice);
    }
    view.dispatch(tr.scrollIntoView()); return true;
  };
  const keys = {
    ...baseKeymap,
    // Enter: a new line in the paragraph; twice, or Shift+Enter: a new paragraph (commands.js, enterLine)
    Enter: () => !view.composing && command(enterLine, 'input.type'),
    'Shift-Enter': () => command(shiftEnter, 'input.type'),
    Backspace: (state, dispatch, pm) => command(backspaceDetails, 'delete.backward') || baseKeymap.Backspace(state, dispatch, pm),
    'Mod-b': () => command(toggleFormat('strong')),
    'Mod-i': () => command(toggleFormat('em')),
    'Mod-u': () => command(toggleFormat('underline')),
    'Mod-Shift-s': () => command(toggleFormat('strike')),
    'Mod-z': () => command(undo, 'undo'),
    'Mod-y': () => command(redo, 'redo'),
    'Mod-Shift-z': () => command(redo, 'redo'),
    'Mod-f': () => { showSearch(); return true; },
    'Mod-e': () => command(setParagraphType('code_block')),
    Tab: (state, dispatch) => goToNextCell(1)(state, dispatch) || sinkListItem(state.selection.$from.node(-1)?.type === schema.nodes.task_item ? schema.nodes.task_item : schema.nodes.list_item)(state, dispatch),
    'Shift-Tab': (state, dispatch) => goToNextCell(-1)(state, dispatch) || liftListItem(state.selection.$from.node(-1)?.type === schema.nodes.task_item ? schema.nodes.task_item : schema.nodes.list_item)(state, dispatch),
  };
  // Marks pressed on the bar with nothing selected stay on for what is written next, wherever the cursor
  // goes, until they are pressed again (api.toggle).
  const sticky = new Set();
  const stickyPlugin = new Plugin({
    appendTransaction(transactions, old, state) {
      if (!sticky.size || !state.selection.empty) return null;
      const marks = state.storedMarks ?? state.selection.$from.marks();
      let next = marks;
      for (const name of sticky) if (!next.some((mark) => mark.type.name === name)) next = schema.marks[name].create().addToSet(next);
      return next === marks ? null : state.tr.setStoredMarks(next).setMeta('addToHistory', false);
    },
  });
  const plugins = [history(), keymap(keys), columnResizing(), tableEditing(), searchPlugin, focusPlugin, stickyPlugin];
  const view = new EditorView(root, {
    state: EditorState.create({ schema, doc: mapping.doc, plugins }),
    dispatchTransaction: sync,
    editable: () => editable,
    attributes: { class: 'atlas-rich-content', role: 'textbox', 'aria-multiline': 'true', 'aria-label': t('editor.label'), 'data-placeholder': t('rich.placeholder'), spellcheck: 'true', autocapitalize: 'sentences' },
    nodeViews: nodeViews({ ...options, onSourceNode: (pos) => options.onSourceNode?.(mapping.toSource(pos)) }),
    handleDOMEvents: {
      beforeinput(pm, event) {
        if (!editable || pm.composing || event.isComposing) return false;
        if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); command(event.inputType === 'historyUndo' ? undo : redo, event.inputType === 'historyUndo' ? 'undo' : 'redo'); return true; }
        // a phone's keyboard sends Enter this way rather than as a key
        if (event.inputType === 'insertParagraph') { event.preventDefault(); command(enterLine, 'input.type'); return true; }
        // a phone's keyboard: Backspace at the start of an accordion's title (or its empty body)
        if (event.inputType === 'deleteContentBackward' && backspaceDetails(pm.state)) { event.preventDefault(); command(backspaceDetails, 'delete.backward'); return true; }
        if (event.inputType === 'insertLineBreak') { event.preventDefault(); command(shiftEnter, 'input.type'); return true; }
        return false;
      },
      contextmenu(pm, event) {
        if (event.shiftKey || fromTouch(event)) return false; // a finger: the app's bars, not the right-click menu
        event.preventDefault(); options.onContextMenu?.(event, options.getFacade()); return true;
      },
    },
    handleClick(pm, pos, event) {
      const link = event.target.closest('a[href]');
      if (link && (!editable || event.ctrlKey || event.metaKey)) { event.preventDefault(); options.onOpenLink?.(safeLink(link.getAttribute('href'))); return true; }
      return false;
    },
    handlePaste(pm, event) {
      if (!editable) return true;
      const image = [...(event.clipboardData?.files ?? [])].find((file) => file.type.startsWith('image/'));
      if (image) { options.onImage?.(image, null); return true; }
      if (!event.clipboardData?.getData('text/html')) { insertText(event.clipboardData?.getData('text/plain') ?? ''); return true; }
      return false;
    },
    handleDrop(pm, event) {
      if (!editable) return true;
      const image = [...(event.dataTransfer?.files ?? [])].find((file) => file.type.startsWith('image/'));
      if (!image) return false;
      const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
      options.onImage?.(image, at ? mapping.toSource(at.pos) : null); return true;
    },
    clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, '\n', (node) => node.type.name === 'source_block' ? node.attrs.raw : node.attrs.alt || ''),
  });
  root.append(preview); cacheDocument(); remember();

  function navigate(direction) {
    const matches = findMatches(view.state.doc, query.value); if (!matches.length) return;
    const head = view.state.selection.head;
    const found = direction > 0 ? matches.find((part) => part.from > head) ?? matches[0] : [...matches].reverse().find((part) => part.from < view.state.selection.from) ?? matches.at(-1);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, found.from, found.to)).scrollIntoView());
  }
  function replaceMatch(all) {
    if (!editable) return;
    const matches = findMatches(view.state.doc, query.value); if (!matches.length) return;
    const selected = matches.find((part) => part.from === view.state.selection.from && part.to === view.state.selection.to);
    const picks = all ? matches : [selected ?? matches[0]];
    const tr = view.state.tr;
    for (const match of [...picks].reverse()) tr.insertText(replace.value, match.from, match.to);
    view.dispatch(closeHistory(tr));
  }
  query.addEventListener('input', () => view.dispatch(view.state.tr.setMeta(searchKey, query.value).setMeta('addToHistory', false)));
  query.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); navigate(event.shiftKey ? -1 : 1); } if (event.key === 'Escape') closeSearch(); });
  function showSearch() { search.hidden = false; query.focus(); query.select(); }

  function adopt(nextSource, notifyChange = false, sourceTransaction = null) {
    const text = nextSource.doc.toString(), cached = snapshots.get(nextSource);
    if (cached) { source = nextSource; mapping = cached.mapping; documents = cached.documents; view.updateState(cached.state); return; }
    const same = text === source.doc.toString();
    const parsed = same ? mapping : parseMarkdown(text);
    const selection = fitSelection(parsed.doc ?? view.state.doc, parsed.toDocument(nextSource.selection.main.anchor), parsed.toDocument(nextSource.selection.main.head));
    if (same) view.updateState(view.state.apply(view.state.tr.setSelection(fitSelection(view.state.doc, selection.anchor, selection.head)).setMeta('addToHistory', false)));
    else {
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.doc.content);
      tr.setSelection(fitSelection(tr.doc, selection.anchor, selection.head));
      view.updateState(view.state.apply(tr));
    }
    source = nextSource; mapping = parsed; remember(); cacheDocument();
    if (notifyChange && sourceTransaction) notify(sourceTransaction);
  }

  const api = {
    view,
    get sourceState() { return source; },
    get mapping() { return mapping; },
    adopt,
    show(nextSource) {
      const cached = snapshots.get(nextSource);
      if (cached) { source = nextSource; mapping = cached.mapping; documents = cached.documents; view.updateState(cached.state); return; }
      source = nextSource; mapping = parseMarkdown(source.doc.toString()); documents = [];
      const selection = source.selection.main;
      view.updateState(EditorState.create({ schema, doc: mapping.doc, plugins, selection: fitSelection(mapping.doc, mapping.toDocument(selection.anchor), mapping.toDocument(selection.head)) }));
      cacheDocument(); remember();
    },
    dispatchSource(...specs) {
      const tr = specs[0]?.startState ? specs[0] : source.update(...specs);
      const changed = tr.docChanged;
      if (changed) adopt(tr.state, true, tr);
      else {
        source = tr.state;
        const selection = source.selection.main;
        view.updateState(view.state.apply(view.state.tr.setSelection(fitSelection(view.state.doc, mapping.toDocument(selection.anchor), mapping.toDocument(selection.head))).setMeta('addToHistory', false)));
        remember(); options.onSelectionChange?.({ state: source, transactions: [tr], selectionSet: true, docChanged: false });
        options.onFormatChange?.();
        if (specs.some((spec) => spec?.scrollIntoView || spec?.effects)) view.dispatch(view.state.tr.scrollIntoView().setMeta('addToHistory', false));
      }
    },
    /**
     * A button of the bar pressed: what is on goes off, what is off comes on. A mark with nothing
     * selected stays on until pressed again; a heading, list, quote or code pressed where it already
     * is gives a plain paragraph back.
     */
    toggle(id) {
      if (!editable) return false;
      const name = MARK_NAMES[id];
      const now = activeFormats(view.state);
      if (name && view.state.selection.empty) {
        const type = schema.marks[name];
        const marks = view.state.storedMarks ?? view.state.selection.$from.marks();
        if (sticky.has(name) || now.marks.has(name)) {
          sticky.delete(name);
          view.dispatch(view.state.tr.setStoredMarks(type.removeFromSet(marks)).setMeta('addToHistory', false));
        } else {
          sticky.add(name);
          view.dispatch(view.state.tr.setStoredMarks(type.create().addToSet(marks)).setMeta('addToHistory', false));
        }
        options.onFormatChange?.();
        return true;
      }
      if (name) sticky.delete(name);
      if (/^h[1-6]$/.test(id) && now.block === 'heading' && now.level === Number(id[1])) return this.command('paragraph');
      if (id !== 'paragraph' && BLOCK_NAMES[id] && now.block === BLOCK_NAMES[id]) return this.command('paragraph');
      return this.command(id);
    },
    /** The marks kept on (toggle). */
    sticky: () => new Set(sticky),
    command(id, value) {
      if (!editable) return false;
      if (MARK_NAMES[id]) return command(toggleFormat(MARK_NAMES[id]));
      if (/^h[1-6]$/.test(id)) return command(setParagraphType('heading', { level: Number(id[1]) }));
      if (BLOCK_NAMES[id]) return command(setParagraphType(BLOCK_NAMES[id]));
      if (id === 'accordion') return command(insertDetails(t('accordion.defaultTitle')));
      if (id === 'next') return command(nextItem, 'input.type');
      if (id === 'after') return command(paragraphAfterBlock, 'input.type');
      if (id === 'newline') return command(normalParagraph, 'input.type');
      if (id === 'rule') { view.dispatch(view.state.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create()).scrollIntoView()); return true; }
      if (id === 'link') {
        const href = safeLink(value); if (!href) return false;
        return command(toggleMark(schema.marks.link, { href, title: '' }));
      }
      if (id === 'image') { const node = schema.nodes.image.create(value); view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView()); return true; }
      if (id === 'indent' || id === 'outdent') {
        const type = view.state.selection.$from.node(-1)?.type === schema.nodes.task_item ? schema.nodes.task_item : schema.nodes.list_item;
        return command((id === 'indent' ? sinkListItem : liftListItem)(type));
      }
      return false;
    },
    insertText,
    deleteSelection() { if (editable) view.dispatch(view.state.tr.deleteSelection().scrollIntoView()); },
    getSelectedText: () => view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, '\n', (node) => node.type.name === 'source_block' ? node.attrs.raw : node.attrs.alt || ''),
    getPlainText: () => view.state.doc.textBetween(0, view.state.doc.content.size, '\n', (node) => node.type.name === 'source_block' ? node.attrs.raw : node.attrs.alt || ''),
    getContextText: () => view.state.selection.$from.parent.textBetween(0, view.state.selection.$from.parentOffset, ''),
    formats: () => activeFormats(view.state),
    setEditable(on) { editable = on; root.classList.toggle('rich-readonly', !on); view.setProps({ editable: () => editable }); },
    setFocusDim(mode) { view.dispatch(view.state.tr.setMeta(focusKey, mode).setMeta('addToHistory', false)); },
    localize() {
      view.setProps({ attributes: { class: 'atlas-rich-content', role: 'textbox', 'aria-multiline': 'true', 'aria-label': t('editor.label'), 'data-placeholder': t('rich.placeholder'), spellcheck: 'true', autocapitalize: 'sentences' } });
      query.placeholder = t('rich.find'); query.setAttribute('aria-label', t('rich.find'));
      replace.placeholder = t('rich.replace'); replace.setAttribute('aria-label', t('rich.replace'));
      for (const check of view.dom.querySelectorAll('.rich-task-control > input')) check.setAttribute('aria-label', t('rich.taskDone'));
      for (const button of view.dom.querySelectorAll('.rich-block-after')) button.textContent = t('rich.afterBlock');
      for (const button of view.dom.querySelectorAll('.rich-details-toggle')) {
        const section = button.closest('.rich-details');
        button.setAttribute('aria-label', t(section.classList.contains('is-closed') ? 'accordion.expand' : 'accordion.collapse') + ': ' + (section.querySelector('summary')?.textContent || ''));
      }
    },
    undo: () => command(undo, 'undo'), redo: () => command(redo, 'redo'),
    steps: () => ({ canUndo: undoDepth(view.state) > 0, canRedo: redoDepth(view.state) > 0 }),
    showSearch,
    preview(text) { preview.textContent = text; preview.hidden = !text; },
    destroy() { view.destroy(); },
  };
  return api;
}

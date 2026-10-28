// CodeMirror setup: markdown with highlighted code fences (copy button, line count, "/#" to open and
// close one), comment lines, task lines, smart paste of code, Ctrl+click on links and the search
// panel in the interface's language.

import { Compartment, EditorState, StateField } from '@codemirror/state';
import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor,
  placeholder,
  ViewPlugin,
  Decoration,
  WidgetType,
} from '@codemirror/view';
import { history, defaultKeymap, historyKeymap, indentWithTab, isolateHistory, undo } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, HighlightStyle, syntaxTree, bracketMatching, indentOnInput } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { classifyPaste, detectLanguage } from './codeDetect.js';
import { planComment } from './comments.js';
import { planSlashFence } from './fence.js';
import { IMAGE_RE } from './markdown.js';
import { count, currentLang, t as say, ui } from './i18n.js';

// The editor's own words (search panel, placeholder, the label screen readers hear), one set per
// language; the compartment swaps them when the language changes.
const language = new Compartment();
const languageSets = new Map();

function languageExtensions() {
  const lang = currentLang();
  if (!languageSets.has(lang)) {
    languageSets.set(lang, [
      EditorState.phrases.of(ui().editor.phrases),
      placeholder(say('editor.placeholder')),
      EditorView.contentAttributes.of({ 'aria-label': say('editor.label') }),
    ]);
  }
  return languageSets.get(lang);
}

const atlasHighlight = HighlightStyle.define([
  { tag: t.heading1, class: 'tk-h tk-h1' },
  { tag: t.heading2, class: 'tk-h tk-h2' },
  { tag: t.heading3, class: 'tk-h tk-h3' },
  { tag: [t.heading4, t.heading5, t.heading6], class: 'tk-h tk-h4' },
  { tag: t.emphasis, class: 'tk-em' },
  { tag: t.strong, class: 'tk-strong' },
  { tag: t.strikethrough, class: 'tk-strike' },
  { tag: t.link, class: 'tk-link' },
  { tag: t.url, class: 'tk-url' },
  { tag: t.monospace, class: 'tk-mono' },
  { tag: t.quote, class: 'tk-quote' },
  { tag: t.processingInstruction, class: 'tk-mark' },
  { tag: t.labelName, class: 'tk-label' },
  { tag: t.contentSeparator, class: 'tk-hr' },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], class: 'tk-kw' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.escape], class: 'tk-str' },
  { tag: [t.number, t.bool, t.null, t.atom], class: 'tk-num' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'tk-com' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: 'tk-fn' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], class: 'tk-type' },
  { tag: [t.propertyName, t.attributeName], class: 'tk-prop' },
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.compareOperator], class: 'tk-op' },
  { tag: [t.punctuation, t.bracket, t.separator, t.angleBracket], class: 'tk-punct' },
  { tag: t.tagName, class: 'tk-tag' },
  { tag: [t.meta, t.annotation, t.self], class: 'tk-meta' },
  { tag: t.invalid, class: 'tk-invalid' },
]);

const STAMP_RE = /^(\s*)(💬 \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} ·)/u;
const CLOSE_FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

function enclosing(state, pos, names, side = -1) {
  for (let node = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
    if (names.includes(node.name)) return node;
  }
  return null;
}

function fencedBlockAt(state, pos) {
  return enclosing(state, pos, ['FencedCode'], -1) ?? enclosing(state, pos, ['FencedCode'], 1);
}

/** null outside code blocks, '' for a block without a language, else the language name. */
export function codeLanguageAt(state, pos) {
  const block = fencedBlockAt(state, pos);
  if (!block) return null;
  const info = block.getChild('CodeInfo');
  return info ? state.sliceDoc(info.from, info.to).trim() : '';
}

function insideCode(state, pos) {
  return Boolean(enclosing(state, pos, ['FencedCode', 'CodeBlock', 'InlineCode']));
}

function codeBlockText(state, pos) {
  const block = fencedBlockAt(state, pos);
  const text = block?.getChild('CodeText');
  return block ? (text ? state.sliceDoc(text.from, text.to) : '') : null;
}

class CodeHeadWidget extends WidgetType {
  constructor(lines, copy) {
    super();
    this.lines = lines;
    this.copy = copy;
    this.lang = currentLang();
  }

  eq(other) {
    return other.lines === this.lines && other.lang === this.lang;
  }

  toDOM(view) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-code-head';
    const size = document.createElement('span');
    size.textContent = count(this.lines, 'line');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-code-copy';
    button.textContent = say('editor.copy');
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      const code = codeBlockText(view.state, view.posAtDOM(wrap));
      if (code == null) return;
      try {
        await this.copy(code);
        button.textContent = say('editor.copied');
        button.classList.add('done');
      } catch {
        button.textContent = say('editor.noClipboard');
      }
      setTimeout(() => {
        button.textContent = say('editor.copy');
        button.classList.remove('done');
      }, 1500);
    });
    wrap.append(size, button);
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(name, alt, resolve, open) {
    super();
    Object.assign(this, { name, alt, resolve, open });
  }

  eq(other) {
    return other.name === this.name && other.alt === this.alt;
  }

  get estimatedHeight() {
    return 240;
  }

  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-image';
    const img = document.createElement('img');
    img.alt = this.alt;
    img.draggable = false;
    const missing = () => {
      wrap.classList.add('missing');
      wrap.textContent = say('image.missing', this.name);
      view.requestMeasure();
    };
    img.addEventListener('load', () => view.requestMeasure()); // the real height is known only now
    img.addEventListener('error', missing);
    img.addEventListener('mousedown', (e) => e.preventDefault());
    img.addEventListener('click', () => this.open(img.src, this.alt));
    this.resolve(this.name).then(
      (url) => (url ? (img.src = url) : missing()),
      missing,
    );
    wrap.append(img);
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

// Pictures are block widgets (they take their own space under the line), and block decorations
// may only come from a state field, not from a view plugin.
function imagesField(resolve, open) {
  const build = (state) => {
    const widgets = [];
    for (let n = 1; n <= state.doc.lines; n++) {
      const line = state.doc.line(n);
      if (!line.text.includes('](assets/')) continue;
      for (const m of line.text.matchAll(IMAGE_RE)) {
        widgets.push(Decoration.widget({ widget: new ImageWidget(m[2], m[1], resolve, open), block: true, side: 1 }).range(line.to));
      }
    }
    return Decoration.set(widgets, true);
  };
  return StateField.define({
    create: build,
    update: (decorations, tr) => (tr.docChanged ? build(tr.state) : decorations),
    provide: (field) => EditorView.decorations.from(field),
  });
}

const imageFile = (transfer) => [...(transfer?.files ?? [])].find((file) => file.type.startsWith('image/')) ?? null;

function buildDecorations(view, copy) {
  const { state } = view;
  const { doc } = state;
  const tree = syntaxTree(state);
  const lineClasses = new Map(); // line.from → Set of classes
  const lineAttrs = new Map();
  const extra = [];
  const addLine = (line, cls, attrs) => {
    let set = lineClasses.get(line.from);
    if (!set) lineClasses.set(line.from, (set = new Set()));
    set.add(cls);
    if (attrs) lineAttrs.set(line.from, { ...lineAttrs.get(line.from), ...attrs });
  };

  for (const { from, to } of view.visibleRanges) {
    const firstVisible = doc.lineAt(from).number;
    const lastVisible = doc.lineAt(to).number;
    const eachLine = (nodeFrom, nodeTo, fn) => {
      const lo = Math.max(doc.lineAt(nodeFrom).number, firstVisible);
      const hi = Math.min(doc.lineAt(nodeTo).number, lastVisible);
      for (let n = lo; n <= hi; n++) fn(doc.line(n));
    };

    tree.iterate({
      from,
      to,
      enter(node) {
        const { name } = node;
        if (name === 'FencedCode') {
          const first = doc.lineAt(node.from);
          const last = doc.lineAt(node.to);
          const closed = last.number > first.number && CLOSE_FENCE_RE.test(last.text);
          eachLine(node.from, node.to, (line) => {
            addLine(line, 'cm-cb', { spellcheck: 'false' });
            if (line.number === first.number) addLine(line, 'cm-cb-start');
            if (line.number === last.number) addLine(line, 'cm-cb-end');
          });
          if (first.number >= firstVisible && first.number <= lastVisible) {
            const count = Math.max(0, last.number - first.number - (closed ? 1 : 0));
            extra.push(Decoration.widget({ widget: new CodeHeadWidget(count, copy), side: 1 }).range(first.to));
          }
          return false;
        }
        const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
        if (heading) {
          addLine(doc.lineAt(node.from), `cm-hl cm-hl-${heading[1]}`);
          return undefined;
        }
        if (name === 'Blockquote') {
          eachLine(node.from, node.to, (line) => addLine(line, 'cm-bq'));
          return undefined;
        }
        if (name === 'HorizontalRule') {
          addLine(doc.lineAt(node.from), 'cm-hr');
          return false;
        }
        if (name === 'Task') {
          const marker = node.node.getChild('TaskMarker');
          const done = marker && /x/i.test(state.sliceDoc(marker.from, marker.to));
          addLine(doc.lineAt(node.from), done ? 'cm-task cm-task-done' : 'cm-task');
        }
        return undefined;
      },
    });

    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      if (line.text.includes('](assets/') && !lineClasses.get(line.from)?.has('cm-cb')) addLine(line, 'cm-img-src');
      const m = STAMP_RE.exec(line.text);
      if (m && !lineClasses.get(line.from)?.has('cm-cb')) {
        addLine(line, 'cm-note-line');
        const start = line.from + m[1].length;
        extra.push(Decoration.mark({ class: 'cm-note-stamp' }).range(start, start + m[2].length));
      }
      pos = line.to + 1;
    }
  }

  for (const [from, set] of lineClasses) {
    extra.push(Decoration.line({ class: [...set].join(' '), attributes: lineAttrs.get(from) }).range(from));
  }
  return Decoration.set(extra, true);
}

function structurePlugin(copy) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildDecorations(view, copy);
      }

      update(u) {
        // a reconfiguration is a language change: the code blocks' heads get the new words
        if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state) || u.transactions.some((tr) => tr.reconfigured)) {
          this.decorations = buildDecorations(u.view, copy);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Ctrl+E: an empty block at the cursor, or the selected lines wrapped (with a guessed language selected). */
export function insertCodeBlock(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (sel.empty) {
    const line = state.doc.lineAt(sel.head);
    const blank = !line.text.trim();
    const at = blank ? line.from : line.to;
    const insert = `${blank ? '' : '\n'}\`\`\`\n\n\`\`\``;
    view.dispatch({
      changes: { from: at, to: blank ? line.to : at, insert },
      selection: { anchor: at + (blank ? 3 : 4) },
      scrollIntoView: true,
      userEvent: 'input',
    });
  } else {
    const first = state.doc.lineAt(sel.from);
    const endPos = sel.to > sel.from && sel.to === state.doc.lineAt(sel.to).from ? sel.to - 1 : sel.to;
    const last = state.doc.lineAt(endPos);
    const lang = detectLanguage(state.sliceDoc(first.from, last.to)) ?? '';
    view.dispatch({
      changes: [
        { from: first.from, insert: `\`\`\`${lang}\n` },
        { from: last.to, insert: '\n```' },
      ],
      selection: { anchor: first.from + 3, head: first.from + 3 + lang.length },
      scrollIntoView: true,
      userEvent: 'input',
    });
  }
  view.focus();
  return true;
}

// "/#" alone on a line opens a code block, and inside one closes it (see fence.js). The "#" lands
// first and the fences follow as their own history step, so Ctrl+Z gives back the typed "/#".
const slashFence = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '#' || view.composing || view.state.selection.ranges.length > 1) return false;
  const line = view.state.doc.lineAt(from);
  if (!/^\s*\/$/.test(line.text.slice(0, from - line.from)) || line.text.slice(to - line.from).trim()) return false;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + 1 }, userEvent: 'input.type' });
  const plan = planSlashFence(view.state.doc.toString(), from + 1);
  if (plan) {
    view.dispatch({
      changes: { from: plan.from, to: plan.to, insert: plan.insert },
      selection: { anchor: plan.cursor },
      annotations: isolateHistory.of('before'),
      userEvent: 'input.codeblock',
      scrollIntoView: true,
    });
  }
  return true;
});

/**
 * Pastes text; when it looks like code (outside an existing code block) the paste is followed by a
 * separate history step that wraps it in a fence, so Ctrl+Z undoes only the wrapping.
 */
export function pasteText(view, raw, onSmartPaste) {
  const text = raw.replace(/\r\n?/g, '\n');
  const from = view.state.selection.main.from;
  // with several cursors the paste lands in several places; only a single paste gets wrapped
  const single = view.state.selection.ranges.length === 1;
  const verdict = !single || insideCode(view.state, from) ? null : classifyPaste(text);
  view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true });
  if (!verdict) return;

  const { doc } = view.state;
  const end = from + text.length;
  const before = doc.sliceString(doc.lineAt(from).from, from);
  const after = doc.sliceString(end, doc.lineAt(end).to);
  const open = `${before.trim() ? '\n' : ''}\`\`\`${verdict.lang}\n`;
  const close = `${text.endsWith('\n') ? '' : '\n'}\`\`\`${after.trim() || text.endsWith('\n') ? '\n' : ''}`;
  view.dispatch({
    changes: [
      { from, insert: open },
      { from: end, insert: close },
    ],
    selection: { anchor: end + open.length + close.indexOf('```') + 3 },
    annotations: isolateHistory.of('full'),
    userEvent: 'input.paste',
    scrollIntoView: true,
  });
  onSmartPaste?.(verdict.lang, () => undo(view));
}

const URL_RE = /\bhttps?:\/\/[^\s<>()"'`]*[^\s<>()"'`.,;:!?]/g;

/** The link under `pos`: a markdown link's target or a bare URL. */
export function urlAt(state, pos) {
  const link = enclosing(state, pos, ['Link', 'Autolink']);
  const url = link?.getChild('URL');
  if (url) return state.sliceDoc(url.from, url.to);
  const line = state.doc.lineAt(pos);
  for (const m of line.text.matchAll(URL_RE)) {
    const a = line.from + m.index;
    if (pos >= a && pos <= a + m[0].length) return m[0];
  }
  return null;
}

export function insertComment(view, lineNumber, body, date = new Date()) {
  const plan = planComment(view.state.doc.toJSON(), lineNumber, body, date);
  if (!plan) return false;
  const line = view.state.doc.line(plan.afterLine);
  view.dispatch({
    changes: { from: line.to, insert: `\n${plan.text}` },
    selection: { anchor: line.to + 1 + plan.text.length },
    scrollIntoView: true,
    userEvent: 'input.comment',
  });
  return true;
}

export function createEditor({
  parent,
  onDocChange,
  onSelectionChange,
  onSmartPaste,
  onOpenLink,
  onContextMenu,
  onCopy,
  onImage,
  resolveImage,
  openImage,
}) {
  const extensions = [
    history(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    bracketMatching(),
    indentOnInput(),
    search({ top: true }),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
    syntaxHighlighting(atlasHighlight),
    structurePlugin(onCopy),
    imagesField(resolveImage, openImage),
    slashFence,
    EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'sentences' }),
    keymap.of([{ key: 'Mod-e', run: insertCodeBlock }, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
    EditorView.domEventHandlers({
      paste(event, view) {
        // a screenshot in the clipboard (Win+Shift+S, then Ctrl+V) becomes a picture in the note
        const image = imageFile(event.clipboardData);
        if (image) {
          event.preventDefault();
          onImage(image, null);
          return true;
        }
        const text = event.clipboardData?.getData('text/plain');
        if (!text || view.state.selection.ranges.length > 1) return false;
        if (insideCode(view.state, view.state.selection.main.from) || !classifyPaste(text)) return false;
        event.preventDefault();
        pasteText(view, text, onSmartPaste);
        return true;
      },
      drop(event, view) {
        const image = imageFile(event.dataTransfer);
        if (!image) return false;
        event.preventDefault();
        onImage(image, view.posAtCoords({ x: event.clientX, y: event.clientY }));
        return true;
      },
      contextmenu(event, view) {
        if (event.shiftKey) return false; // Shift+right click keeps the browser menu (spelling suggestions)
        // a long press on a touch screen selects a word and shows the phone's own copy/paste bar
        if (event.pointerType === 'touch' || event.sourceCapabilities?.firesTouchEvents) return false;
        event.preventDefault();
        onContextMenu(event, view);
        return true;
      },
      mousedown(event, view) {
        if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const url = pos == null ? null : urlAt(view.state, pos);
        if (!url) return false;
        event.preventDefault();
        onOpenLink(url);
        return true;
      },
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onDocChange(u);
      if (u.selectionSet || u.docChanged) onSelectionChange(u);
    }),
  ];

  const withLanguage = () => [...extensions, language.of(languageExtensions())];
  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions: withLanguage() }) });
  return {
    view,
    makeState: (doc, selection) => EditorState.create({ doc, selection, extensions: withLanguage() }),
    /** Puts the open note's editor into the current language (a kept state may carry the previous one). */
    localize() {
      const wanted = languageExtensions();
      if (language.get(view.state) !== wanted) view.dispatch({ effects: language.reconfigure(wanted) });
    },
  };
}

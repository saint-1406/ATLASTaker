// The note as it reads, not as it is typed: Markdown's marks are hidden and the text shows what they
// mean. **bold** reads bold, *italic* italic, ~~struck~~ struck, <u>underlined</u> underlined; a
// heading's # and a quote's > go; an item's "- " is a bullet •, a task's "- [ ]" a box to tick; a
// link shows its words. The text itself is unchanged, and the marks come back with "Show the markup"
// (Settings → Writing). Tags (#word) are drawn as small labels in both ways. Code is left as written.

import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { TAG_RE } from './tags.js';

const hidden = Decoration.replace({});
const underline = Decoration.mark({ class: 'cm-underline' });
const tagMark = Decoration.mark({ class: 'cm-tag' });
const CODE = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'CodeText', 'URL', 'Autolink']);

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const node = document.createElement('span');
    node.className = 'cm-bullet';
    node.textContent = '•';
    return node;
  }
}
const bullet = new BulletWidget();

/** A task's box: a tap ticks it (or unticks), as one change of the [ ] in the text. */
class CheckWidget extends WidgetType {
  constructor(done, at) {
    super();
    this.done = done;
    this.at = at; // where "[" stands
  }
  eq(other) {
    return other.done === this.done && other.at === this.at;
  }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-check';
    box.checked = this.done;
    box.tabIndex = -1;
    // the box must not take the focus (a phone's keyboard would come up)
    box.addEventListener('pointerdown', (e) => e.preventDefault());
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      if (view.state.readOnly) return; // a note open for reading is not changed by a stray tap
      const at = this.at + 1;
      const now = view.state.sliceDoc(at, at + 1);
      view.dispatch({ changes: { from: at, to: at + 1, insert: /x/i.test(now) ? ' ' : 'x' }, userEvent: 'input.check' });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/** What follows a mark when it is a space: hidden with it ("# Title" reads "Title"). */
const withSpace = (state, to) => (state.sliceDoc(to, to + 1) === ' ' ? to + 1 : to);

function build(view, hide) {
  const { state } = view;
  const tree = syntaxTree(state);
  const marks = [];
  const replaced = [];
  const replace = (deco, from, to) => {
    if (to > from) replaced.push(deco.range(from, to));
  };
  for (const { from, to } of view.visibleRanges) {
    if (hide) {
      let openU = null; // an <u> waiting for its </u> on the same line
      tree.iterate({
        from,
        to,
        enter(node) {
          const { name } = node;
          if (name === 'FencedCode' || name === 'CodeBlock') return false;
          if (name === 'EmphasisMark' || name === 'StrikethroughMark') replace(hidden, node.from, node.to);
          else if (name === 'CodeMark' && node.node.parent?.name === 'InlineCode') replace(hidden, node.from, node.to);
          else if (name === 'HeaderMark' && /^ATXHeading/.test(node.node.parent?.name ?? '')) replace(hidden, node.from, withSpace(state, node.to));
          else if (name === 'QuoteMark') replace(hidden, node.from, withSpace(state, node.to));
          else if (name === 'ListMark') {
            const item = node.node.parent;
            const end = withSpace(state, node.to);
            if (item?.getChild('Task')) replace(hidden, node.from, end);
            else if (item?.parent?.name === 'BulletList') replace(Decoration.replace({ widget: bullet }), node.from, end);
          } else if (name === 'TaskMarker') {
            const done = /x/i.test(state.sliceDoc(node.from, node.to));
            replace(Decoration.replace({ widget: new CheckWidget(done, node.from) }), node.from, withSpace(state, node.to));
          } else if (name === 'Link') {
            // [words](address): the words stay; "[" and "](address)" go
            const parts = node.node.getChildren('LinkMark');
            if (parts.length >= 2 && node.node.getChild('URL')) {
              replace(hidden, parts[0].from, parts[0].to);
              replace(hidden, parts[1].from, node.to);
            }
          } else if (name === 'HTMLTag') {
            const tag = state.sliceDoc(node.from, node.to).toLowerCase();
            if (tag === '<u>') openU = { from: node.from, to: node.to, line: state.doc.lineAt(node.from).number };
            else if (tag === '</u>' && openU && openU.line === state.doc.lineAt(node.from).number) {
              replace(hidden, openU.from, openU.to);
              replace(hidden, node.from, node.to);
              if (node.from > openU.to) marks.push(underline.range(openU.to, node.from));
              openU = null;
            }
          }
          return undefined;
        },
      });
    }
    // tags, outside code
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      if (line.text.includes('#')) {
        for (const m of line.text.matchAll(TAG_RE)) {
          const start = line.from + m.index + m[1].length;
          let inCode = false;
          for (let n = tree.resolveInner(start, 1); n; n = n.parent) if (CODE.has(n.name)) inCode = true;
          if (!inCode) marks.push(tagMark.range(start, start + 1 + m[2].length));
        }
      }
      pos = line.to + 1;
    }
  }
  return { decorations: Decoration.set([...marks, ...replaced], true), atomic: Decoration.set(replaced, true) };
}

/** The extension: `hide` true hides the marks (and the cursor steps over them); false only draws tags. */
export function livePreview(hide) {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        Object.assign(this, build(view, hide));
      }
      update(u) {
        if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) Object.assign(this, build(u.view, hide));
      }
    },
    { decorations: (p) => p.decorations },
  );
  return [plugin, EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none)];
}

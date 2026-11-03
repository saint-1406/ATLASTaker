// Focus mode's dimming: everything but the paragraph (or the sentence) the cursor is in fades back.
// Two mark decorations, before and after the lit part: CodeMirror draws only what is on screen, so a
// long note costs no more than a short one.

import { Decoration, ViewPlugin } from '@codemirror/view';

const dim = Decoration.mark({ class: 'cm-dimmed' });
const LONG = 20_000; // a paragraph longer than this (a pasted log) is lit a line at a time

/** The paragraph around `pos`: its lines up to the blank ones on either side. */
export function paragraphAt(doc, pos) {
  let first = doc.lineAt(pos);
  let last = first;
  if (!first.text.trim()) return { from: first.from, to: first.to };
  while (first.number > 1) {
    const prev = doc.line(first.number - 1);
    if (!prev.text.trim()) break;
    first = prev;
  }
  while (last.number < doc.lines) {
    const next = doc.line(last.number + 1);
    if (!next.text.trim()) break;
    last = next;
  }
  return { from: first.from, to: last.to };
}

/** The sentence around `pos`, within its paragraph (Intl.Segmenter; without it, the paragraph). */
export function sentenceAt(doc, pos, lang = 'ru') {
  let part = paragraphAt(doc, pos);
  if (part.to - part.from > LONG) part = doc.lineAt(pos);
  if (typeof Intl?.Segmenter !== 'function' || part.to === part.from) return { from: part.from, to: part.to };
  const text = doc.sliceString(part.from, part.to);
  const offset = Math.min(Math.max(0, pos - part.from), text.length - 1);
  const found = new Intl.Segmenter(lang, { granularity: 'sentence' }).segment(text).containing(offset);
  if (!found) return { from: part.from, to: part.to };
  const start = part.from + found.index;
  return { from: start, to: start + found.segment.trimEnd().length };
}

/** The extension: 'paragraph' or 'sentence' lit, in the note's language for where sentences end. */
export function focusDim(mode, lang = 'ru') {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view.state);
      }
      update(u) {
        if (u.docChanged || u.selectionSet) this.decorations = this.build(u.state);
      }
      build(state) {
        const { doc } = state;
        const pos = state.selection.main.head;
        const lit = mode === 'sentence' ? sentenceAt(doc, pos, lang) : paragraphAt(doc, pos);
        const ranges = [];
        if (lit.from > 0) ranges.push(dim.range(0, lit.from));
        if (lit.to < doc.length) ranges.push(dim.range(lit.to, doc.length));
        return Decoration.set(ranges);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

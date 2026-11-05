import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export const searchKey = new PluginKey('atlasSearch');
export function findMatches(doc, query) {
  if (!query) return [];
  let text = '', offsets = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock && text) { text += '\n'; offsets.push(pos); }
    if (node.isText) for (let i = 0; i < node.text.length; i++) { text += node.text[i]; offsets.push(pos + i); }
  });
  const lower = text.toLocaleLowerCase(), needle = query.toLocaleLowerCase(), found = [];
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + Math.max(1, needle.length))) found.push({ from: offsets[at], to: offsets[at + needle.length - 1] + 1 });
  return found;
}
export const searchPlugin = new Plugin({
  key: searchKey,
  state: { init: () => '', apply: (tr, query) => tr.getMeta(searchKey) ?? query },
  props: { decorations(state) { return DecorationSet.create(state.doc, findMatches(state.doc, searchKey.getState(state)).map((match) => Decoration.inline(match.from, match.to, { class: 'rich-search-match' }))); } },
});

export const focusKey = new PluginKey('atlasFocus');
export const focusPlugin = new Plugin({
  key: focusKey,
  state: { init: () => null, apply: (tr, mode) => tr.getMeta(focusKey) !== undefined ? tr.getMeta(focusKey) : mode },
  props: { decorations(state) {
    const mode = focusKey.getState(state); if (!mode) return null;
    const decorations = [], head = state.selection.head;
    state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return;
      if (head < pos + 1 || head > pos + node.nodeSize - 1) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'rich-dimmed' }));
      else if (mode === 'sentence' && node.textContent && typeof Intl.Segmenter === 'function') {
        const cursor = head - pos - 1;
        const segments = [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(node.textContent)];
        const current = segments.find((part) => part.index <= cursor && part.index + part.segment.length >= cursor);
        if (current) {
          if (current.index) decorations.push(Decoration.inline(pos + 1, Math.min(pos + 1 + current.index, pos + node.nodeSize - 1), { class: 'rich-dimmed' }));
          const end = pos + 1 + current.index + current.segment.length;
          if (end < pos + node.nodeSize - 1) decorations.push(Decoration.inline(end, pos + node.nodeSize - 1, { class: 'rich-dimmed' }));
        }
      }
    });
    return DecorationSet.create(state.doc, decorations);
  } },
});

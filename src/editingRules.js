// Boundary rules for the rich Markdown editor, shared by hardware keys and phone input.
import { syntaxTree } from '@codemirror/language';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { insertNewlineAndIndent } from '@codemirror/commands';

export function strikeCloseAt(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') return null;
    if (node.name === 'Strikethrough') {
      const close = node.getChildren('StrikethroughMark').at(-1);
      return close?.from === pos ? { from: close.from, to: close.to, contentFrom: node.from + 2 } : null;
    }
  }
  return null;
}

/** A separator at the end goes after the hidden ~~; it must not invalidate or split the pair. */
export function exitStrike(state, from, to, text) {
  if (state.readOnly || state.selection.ranges.length !== 1) return null;
  const parts = /^([\s\S]*?)([ \t\r\n]+)$/.exec(text);
  const close = parts && strikeCloseAt(state, to);
  if (!close || from < close.contentFrom) return null;
  if (parts[2] === '\n' || parts[2] === '\r\n') {
    // Run the usual Enter command at the visible boundary, retaining list/quote continuation.
    // Compose both steps so a phone's word replacement and the newline remain one undo step.
    const word = state.changes({ from, to, insert: parts[1] });
    const moved = state.update({ changes: word, selection: { anchor: word.mapPos(close.to) } }).state;
    let newline;
    const target = { state: moved, dispatch: (tr) => { newline = tr; } };
    if (!insertNewlineContinueMarkup(target)) insertNewlineAndIndent(target);
    return { changes: word.compose(newline.changes), selection: newline.selection, scrollIntoView: true, userEvent: 'input.type' };
  }
  const changes = [];
  if (from !== to || parts[1]) changes.push({ from, to, insert: parts[1] });
  changes.push({ from: close.to, insert: parts[2] });
  return {
    changes,
    selection: { anchor: close.to + parts[1].length - (to - from) + parts[2].length },
    scrollIntoView: true, userEvent: 'input.type',
  };
}

/** An empty task is still a task: Enter adds a new unchecked task rather than deleting this one. */
export function emptyTaskEnter(state) {
  if (state.readOnly || state.selection.ranges.length !== 1 || !state.selection.main.empty) return null;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  if (pos !== line.to) return null;
  const task = /^([ \t]*)([-*+])[ \t]+\[[ xX]\][ \t]*$/.exec(line.text);
  if (!task) return null;
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) return null;
  }
  const insert = `\n${task[1]}${task[2]} [ ] `;
  return { changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, scrollIntoView: true, userEvent: 'input.type' };
}

export function continueEmptyTask(view) {
  const spec = emptyTaskEnter(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

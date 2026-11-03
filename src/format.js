// What the formatting bar does to the text: Markdown marks put on or taken off. Each takes the editor's
// state and returns a transaction (or null when there is nothing to do), so it is one step back with ↶.

import { EditorSelection } from '@codemirror/state';

const HEADING_RE = /^(\s*)(#{1,6})\s+/;
// a line's own mark: a task (it starts like an item, so it is told apart first), an item, a numbered
// item, a quote
const LINE_MARKS = {
  task: /^(\s*)[-*+]\s\[[ xX]\]\s/,
  bullet: /^(\s*)[-*+]\s(?!\[[ xX]\]\s)/,
  numbered: /^(\s*)\d+[.)]\s/,
  quote: /^(\s*)>\s?/,
};
const ANY_LIST_RE = /^(\s*)(?:[-*+]\s(?:\[[ xX]\]\s)?|\d+[.)]\s)/;

/** The lines a selection covers, each once (a selection ending at a line's start leaves that line out). */
function selectedLines(state) {
  const seen = new Set();
  const lines = [];
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    if (last > first && range.to === state.doc.line(last).from) last--;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      lines.push(state.doc.line(n));
    }
  }
  return lines.sort((a, b) => a.from - b.from);
}

/** Changes with the selection mapped through them. */
function withChanges(state, changes) {
  if (!changes.length) return null;
  const set = state.changes(changes);
  return { changes: set, selection: state.selection.map(set, 1), scrollIntoView: true, userEvent: 'input.format' };
}

/** A heading of this level on the selected lines; on lines that already are one, the mark goes. */
export function heading(state, level) {
  const lines = selectedLines(state);
  const mark = `${'#'.repeat(level)} `;
  const all = lines.every((line) => HEADING_RE.exec(line.text)?.[2].length === level);
  const changes = [];
  for (const line of lines) {
    // a heading of another level, or an item of a list, gives its place to this one
    const own = HEADING_RE.exec(line.text) ?? ANY_LIST_RE.exec(line.text);
    const indent = own ? own[1] : /^\s*/.exec(line.text)[0];
    const from = line.from + indent.length;
    const to = own ? line.from + own[0].length : from;
    if (all) changes.push({ from, to, insert: '' });
    else if (line.text.trim() || lines.length === 1) changes.push({ from, to, insert: mark });
  }
  return withChanges(state, changes);
}

/** An item of a list ("bullet", "numbered", "task") or a quote on the selected lines; again: off. */
export function lineMark(state, kind) {
  const lines = selectedLines(state);
  const own = LINE_MARKS[kind];
  const written = lines.filter((line) => line.text.trim() || lines.length === 1);
  const all = written.length > 0 && written.every((line) => own.test(line.text));
  const changes = [];
  let n = 0;
  for (const line of written) {
    const current = own.exec(line.text);
    if (all) {
      changes.push({ from: line.from + current[1].length, to: line.from + current[0].length, insert: '' });
      continue;
    }
    n++;
    if (current && kind !== 'numbered') continue; // already one: left as it is
    // another kind of item becomes this one (numbers are counted again); a quote keeps what it quotes
    const other = kind === 'quote' ? null : ANY_LIST_RE.exec(line.text);
    const indent = other ? other[1] : /^\s*/.exec(line.text)[0];
    const from = line.from + indent.length;
    const to = other ? line.from + other[0].length : from;
    const mark = kind === 'bullet' ? '- ' : kind === 'task' ? '- [ ] ' : kind === 'numbered' ? `${n}. ` : '> ';
    changes.push({ from, to, insert: mark });
  }
  return withChanges(state, changes);
}

/** How many `char` stand both right before `from` and right after `to`. */
function runs(state, from, to, char) {
  let before = 0;
  while (from - before > 0 && state.sliceDoc(from - before - 1, from - before) === char) before++;
  let after = 0;
  while (to + after < state.doc.length && state.sliceDoc(to + after, to + after + 1) === char) after++;
  return Math.min(before, after);
}

/** Is a span of this mark already around [from, to]? A `*` counts once for italic, twice for bold. */
function wrapped(state, from, to, mark) {
  const n = runs(state, from, to, mark[0]);
  if (mark === '*') return n === 1 || n >= 3;
  return n >= mark.length;
}

/** Does the selected text carry the mark itself ("**word**" selected)? */
function carries(text, mark) {
  if (text.length < 2 * mark.length || !text.startsWith(mark) || !text.endsWith(mark)) return false;
  if (mark !== '*') return true;
  return !(text.startsWith('**') && !text.startsWith('***')); // that is bold, not italic
}

/**
 * Bold (`**`), italic (`*`), strike (`~~`) or code (`` ` ``) around each selection. A selection already
 * in the mark comes out of it; with nothing selected the marks go in as a pair, the cursor between.
 */
export function wrap(state, mark) {
  const len = mark.length;
  return {
    ...state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      if (carries(text, mark)) {
        return {
          changes: [
            { from: range.from, to: range.from + len, insert: '' },
            { from: range.to - len, to: range.to, insert: '' },
          ],
          range: EditorSelection.range(range.from, range.to - 2 * len),
        };
      }
      if (wrapped(state, range.from, range.to, mark)) {
        return {
          changes: [
            { from: range.from - len, to: range.from, insert: '' },
            { from: range.to, to: range.to + len, insert: '' },
          ],
          range: EditorSelection.range(range.from - len, range.to - len),
        };
      }
      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark },
        ],
        range: EditorSelection.range(range.from + len, range.to + len),
      };
    }),
    scrollIntoView: true,
    userEvent: 'input.format',
  };
}

/** A link: the selected words become its text, and the address is selected, ready to be typed or pasted. */
export function link(state) {
  const range = state.selection.main;
  const text = state.sliceDoc(range.from, range.to);
  const url = 'https://';
  const at = text ? range.from + text.length + 3 : range.from + 1;
  return {
    changes: { from: range.from, to: range.to, insert: `[${text}](${url})` },
    selection: text ? EditorSelection.range(at, at + url.length) : EditorSelection.cursor(at),
    scrollIntoView: true,
    userEvent: 'input.format',
  };
}

/** A line across the page (---) on a line of its own: after the cursor's line, or on it when it is empty. */
export function rule(state) {
  const line = state.doc.lineAt(state.selection.main.head);
  const empty = !line.text.trim();
  const insert = empty ? '---\n' : '\n\n---\n';
  const from = empty ? line.from : line.to;
  return {
    changes: { from, to: line.to, insert },
    selection: EditorSelection.cursor(from + insert.length),
    scrollIntoView: true,
    userEvent: 'input.format',
  };
}

/** Runs one of the above on a view; true when something changed. */
export function apply(view, make) {
  const spec = make(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

import { Fragment } from 'prosemirror-model';
import { Selection, TextSelection } from 'prosemirror-state';
import { createParagraphNear, lift, setBlockType, splitBlockAs, toggleMark, wrapIn } from 'prosemirror-commands';
import { splitListItem, wrapInList } from 'prosemirror-schema-list';

function composeCommand(state, transaction, command) {
  return command(state.apply(transaction), (next) => {
    for (const step of next.steps) transaction.step(step);
    transaction.setSelection(Selection.fromJSON(transaction.doc, next.selection.toJSON()));
  });
}

export function normalParagraph(state, dispatch) {
  const { schema } = state;
  const tr = state.tr;
  const { $from } = state.selection;
  if (!$from.depth || state.selection.node) return paragraphAfterBlock(state, dispatch);
  if ($from.parent.type === schema.nodes.summary) {
    const details = $from.node($from.depth - 1);
    const body = $from.before($from.depth - 1) + 1 + details.firstChild.nodeSize + 1;
    const first = details.lastChild.firstChild;
    if (first.type !== schema.nodes.paragraph || first.content.size) tr.insert(body, schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.near(tr.doc.resolve(body + 1)));
  } else {
    const split = splitBlockAs(() => ({ type: schema.nodes.paragraph }));
    if (!composeCommand(state, tr, split) && !composeCommand(state, tr, createParagraphNear)) return false;
    // Lift the new paragraph out of lists and quotes, stopping at an accordion body or table cell.
    for (let i = 0; i < 20; i++) {
      const cursor = tr.selection.$from;
      if (cursor.depth <= 1 || ['details_content', 'table_cell', 'table_header'].includes(cursor.node(cursor.depth - 1).type.name)) break;
      if (!composeCommand(state, tr, lift)) break;
    }
  }
  tr.setStoredMarks([]);
  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
}

export function nextItem(state, dispatch) {
  const { $from } = state.selection;
  let depth = $from.depth;
  while (depth > 0 && !['list_item', 'task_item'].includes($from.node(depth).type.name)) depth--;
  if (!depth) return false;
  const item = $from.node(depth), attrs = item.type.name === 'task_item' ? { checked: false } : null;
  if (!$from.parent.content.size) {
    const at = $from.after(depth);
    const tr = state.tr.insert(at, item.type.createAndFill(attrs));
    tr.setSelection(TextSelection.create(tr.doc, at + 2)).setStoredMarks([]);
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  }
  return splitListItem(item.type, attrs)(state, dispatch && ((tr) => dispatch(tr.setStoredMarks([]))));
}

export const toggleFormat = (name) => (state, dispatch) => {
  const type = state.schema.marks[name];
  return type ? toggleMark(type)(state, dispatch) : false;
};

export function setParagraphType(name, attrs = null) {
  return (state, dispatch) => {
    if (name === 'paragraph') {
      const tr = state.tr;
      for (let i = 0; i < 20; i++) {
        const cursor = tr.selection.$from;
        if (cursor.depth <= 1 || ['details_content', 'table_cell', 'table_header', 'details'].includes(cursor.node(cursor.depth - 1).type.name)) break;
        if (!composeCommand(state, tr, lift)) break;
      }
      composeCommand(state, tr, setBlockType(state.schema.nodes.paragraph));
      if (dispatch) dispatch(tr.scrollIntoView());
      return true;
    }
    if (['bullet_list', 'ordered_list', 'task_list'].includes(name)) {
      const { $from } = state.selection;
      for (let depth = $from.depth; depth > 0; depth--) {
        if (['list_item', 'task_item'].includes($from.node(depth).type.name)) {
          const list = $from.node(depth - 1);
          if (list.type.name === name) return true;
          const itemType = state.schema.nodes[name === 'task_list' ? 'task_item' : 'list_item'];
          const converted = [];
          list.forEach((item) => converted.push(itemType.create(name === 'task_list' ? { checked: false } : null, item.content)));
          if (dispatch) {
            const tr = state.tr.replaceWith($from.before(depth - 1), $from.after(depth - 1), state.schema.nodes[name].create(attrs, converted));
            dispatch(tr.setSelection(Selection.fromJSON(tr.doc, state.selection.toJSON())));
          }
          return true;
        }
      }
      return wrapInList(state.schema.nodes[name], attrs)(state, dispatch);
    }
    if (name === 'blockquote') {
      for (let depth = state.selection.$from.depth; depth > 0; depth--) if (state.selection.$from.node(depth).type.name === 'blockquote') return true;
      return wrapIn(state.schema.nodes.blockquote)(state, dispatch);
    }
    return setBlockType(state.schema.nodes[name], attrs)(state, dispatch);
  };
}

export function insertDetails(title) {
  return (state, dispatch) => {
    const { schema, selection } = state;
    let content = selection.empty ? Fragment.from(schema.nodes.paragraph.create()) : state.doc.slice(selection.from, selection.to).content;
    if (content.firstChild?.isInline) content = Fragment.from(schema.nodes.paragraph.create(null, content));
    const node = schema.nodes.details.create({ open: true }, [schema.nodes.summary.create(null, title ? schema.text(title) : null), schema.nodes.details_content.create(null, content)]);
    const tr = state.tr.replaceSelectionWith(node);
    const end = tr.selection.from;
    let inserted = -1;
    tr.doc.descendants((child, pos) => { if (child.type.name === 'details' && pos <= end && pos + child.nodeSize >= end) inserted = pos; });
    if (inserted >= 0) tr.setSelection(TextSelection.create(tr.doc, inserted + 2, inserted + 2 + title.length));
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

export function paragraphAfterBlock(state, dispatch) {
  const { $from } = state.selection;
  let depth = $from.depth;
  while (depth > 1 && !['details', 'code_block', 'table'].includes($from.node(depth).type.name)) depth--;
  const at = depth ? $from.after(depth) : state.selection.node ? state.selection.to : state.doc.content.size;
  const tr = state.tr.insert(at, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, at + 1)).setStoredMarks([]);
  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
}

export function activeFormats(state) {
  const active = new Set((state.storedMarks ?? state.selection.$from.marks()).map((mark) => mark.type.name));
  if (!state.selection.empty) state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => node.marks.forEach((mark) => active.add(mark.type.name)));
  const { $from } = state.selection;
  let block = $from.parent.type.name, level = $from.parent.attrs.level;
  for (let depth = $from.depth - 1; depth > 0; depth--) if (['bullet_list', 'ordered_list', 'task_list', 'blockquote'].includes($from.node(depth).type.name)) { block = $from.node(depth).type.name; break; }
  return { marks: active, block, level, inList: ['bullet_list', 'ordered_list', 'task_list'].includes(block) };
}

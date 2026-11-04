// A small, deliberately strict subset of HTML: no arbitrary tags or attributes are rendered.
import { EditorSelection } from '@codemirror/state';
import { markdownLanguage } from '@codemirror/lang-markdown';

export const escapeTitle = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const decodeTitle = (value) => value.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[entity]);

function linesOf(text) {
  let from = 0;
  let fence = null;
  let comment = false;
  const inlineCode = [];
  markdownLanguage.parser.parse(text).iterate({ enter(node) {
    if (node.name === 'InlineCode') inlineCode.push({ from: node.from, to: node.to });
  } });
  let codeIndex = 0;
  return text.split('\n').map((text) => {
    const line = { text, from, to: from + text.length, literal: false };
    from = line.to + 1;
    if (fence) {
      line.literal = true;
      const close = /^ {0,3}(`+|~+)\s*$/.exec(text);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    } else if (comment) {
      comment = !text.includes('-->');
      line.literal = true;
    } else if (/^(?: {4}|\t)/.test(text)) {
      line.literal = true;
    } else {
      const start = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
      if (start && !(start[1][0] === '`' && start[2].includes('`'))) {
        fence = start[1];
        line.literal = true;
      } else {
        for (let at = text.indexOf('<!--'); at >= 0; at = text.indexOf('<!--', at + 4)) {
          const pos = line.from + at;
          while (inlineCode[codeIndex]?.to <= pos) codeIndex++;
          if (inlineCode[codeIndex]?.from <= pos && inlineCode[codeIndex].to > pos) continue;
          line.literal = true;
          const end = text.indexOf('-->', at + 4);
          if (end < 0) { comment = true; break; }
          at = end;
        }
      }
    }
    return line;
  });
}

/** Complete standalone details blocks, outer first; positions are offsets in the original Markdown. */
export function accordionBlocks(text) {
  const lines = linesOf(text);
  const stack = [];
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.literal) continue;
    const open = /^<details( open)?>\s*$/.exec(line.text);
    if (/^<details(?:\s|>)/.test(line.text)) {
      const summary = lines[i + 1];
      const title = summary && !summary.literal && /^<summary>(.*)<\/summary>\s*$/.exec(summary.text);
      stack.push(open && title ? {
        from: line.from, openTo: line.to, open: Boolean(open[1]),
        summaryFrom: summary.from, summaryTo: summary.to,
        titleFrom: summary.from + 9, titleTo: summary.from + 9 + title[1].length,
        title: decodeTitle(title[1]), bodyFrom: summary.to + 1,
      } : null);
    } else if (/^<\/details>\s*$/.test(line.text) && stack.length) {
      const start = stack.pop();
      if (start) found.push({ ...start, closeFrom: line.from, to: line.to });
    }
  }
  return found.sort((a, b) => a.from - b.from);
}

/** A single insertion/undo step. A blank line separates the block from surrounding paragraphs. */
export function insertAccordion(state, title) {
  if (state.selection.ranges.length !== 1 || state.readOnly) return null;
  const { from, to } = state.selection.main;
  const text = state.doc.toString();
  if (linesOf(text).some((line) => line.literal && line.from <= to && line.to >= from)) return null;
  const tree = markdownLanguage.parser.parse(text);
  for (let node = tree.resolveInner(from, 1); node; node = node.parent) {
    if (['InlineCode', 'CodeBlock', 'FencedCode'].includes(node.name)) return null;
  }
  const prefix = from && text.slice(0, from).endsWith('\n\n') ? '' : from ? '\n\n' : '';
  const suffix = to < text.length && !text.slice(to).startsWith('\n\n') ? '\n\n' : '';
  const safe = escapeTitle(title);
  const head = `${prefix}<details open>\n<summary>`;
  return {
    changes: { from, to, insert: `${head}${safe}</summary>\n\n${state.sliceDoc(from, to)}\n\n</details>${suffix}` },
    selection: EditorSelection.range(from + head.length, from + head.length + safe.length),
    scrollIntoView: true, userEvent: 'input.accordion',
  };
}

export function toggleAccordion(state, block) {
  return {
    changes: { from: block.from, to: block.openTo, insert: block.open ? '<details>' : '<details open>' },
    selection: { anchor: block.from }, userEvent: 'input.accordion',
  };
}

export function renameAccordion(state, block, title) {
  if (state.readOnly) return null;
  return { changes: { from: block.titleFrom, to: block.titleTo, insert: escapeTitle(title) }, userEvent: 'input.type.accordion.title' };
}

/** Top-level complete blocks only, for recursive exports. */
export function outerAccordions(text) {
  let end = -1;
  return accordionBlocks(text).filter((block) => {
    if (block.from < end) return false;
    end = block.to;
    return true;
  });
}

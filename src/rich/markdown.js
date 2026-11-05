// Markdown is a persistence boundary, never the input model of the visual editor.
import { marked } from 'marked';
import { diffArrays, diffChars } from 'diff';
import { outerAccordions, escapeTitle } from '../accordion.js';
import { richSchema as schema, safeImage, safeLink } from './schema.js';
import { htmlOutput, parseTableHtml } from './html.js';
import { decodeEntities as decode } from '../entities.js';
import { COMMENT_RE } from '../comments.js';

const para = (content = []) => schema.nodes.paragraph.create(null, content);
const TAG_MARKS = { strong: 'strong', b: 'strong', em: 'em', i: 'em', u: 'underline', s: 'strike', del: 'strike', code: 'code' };

function paragraphBlocks(token) {
  const lines = String(token.text ?? '').split('\n');
  if (!lines.some((line) => COMMENT_RE.test(line))) return [para(inline(token.tokens ?? marked.Lexer.lexInline(token.text || '')))];
  const blocks = []; let prose = [];
  const flush = () => { if (prose.length) blocks.push(para(inline(marked.Lexer.lexInline(prose.join('\n'))))); prose = []; };
  for (const line of lines) {
    const comment = COMMENT_RE.exec(line);
    if (comment) { flush(); blocks.push(schema.nodes.comment.create({ indent: comment[1], stamp: comment[2] }, inline(marked.Lexer.lexInline(comment[3])))); }
    else prose.push(line);
  }
  flush(); return blocks;
}

function inline(tokens, marks = []) {
  const out = [];
  let active = [...marks];
  for (const token of tokens ?? []) {
    if (token.type === 'checkbox') continue;
    if (active.some((mark) => mark.type.name === 'code') && token.type !== 'html') {
      if (token.raw || token.text) out.push(schema.text(decode(token.raw ?? token.text), active));
      continue;
    }
    const mark = { strong: 'strong', em: 'em', del: 'strike', codespan: 'code' }[token.type];
    if (mark) {
      const next = schema.marks[mark].create();
      if (token.type === 'codespan') out.push(schema.text(token.text, [next]));
      else out.push(...inline(token.tokens, next.addToSet(active)));
    } else if (token.type === 'link') {
      const href = safeLink(token.href);
      out.push(...inline(token.tokens, href ? schema.marks.link.create({ href, title: decode(token.title || '') }).addToSet(active) : active));
    } else if (token.type === 'image') {
      const src = safeImage(token.href);
      if (src) out.push(schema.nodes.image.create({ src, alt: decode(token.text), title: decode(token.title || '') }, null, active));
      else if (token.text) out.push(schema.text(decode(token.text), active));
    } else if (token.type === 'br') out.push(schema.nodes.hard_break.create(null, null, active));
    else if (token.type === 'html') {
      const tag = /^<(\/?)(strong|b|em|i|u|s|del|code)>$/i.exec(token.raw);
      if (tag) {
        const type = schema.marks[TAG_MARKS[tag[2].toLowerCase()]];
        active = tag[1] ? type.removeFromSet(active) : type.create().addToSet(active);
      } else if (/^<br\s*\/?>$/i.test(token.raw)) out.push(schema.nodes.hard_break.create());
      else if (token.raw) out.push(schema.text(token.raw, active));
    } else if (token.tokens) out.push(...inline(token.tokens, active));
    else if (token.text || token.raw) out.push(schema.text(decode(token.text ?? token.raw), active));
  }
  return out;
}

function blocksFromTokens(tokens) {
  const blocks = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space': case 'checkbox': break;
      case 'def': blocks.push(schema.nodes.source_block.create({ raw: token.raw.replace(/\n+$/, '') })); break;
      case 'heading': blocks.push(schema.nodes.heading.create({ level: token.depth }, inline(token.tokens))); break;
      case 'paragraph': case 'text': blocks.push(...paragraphBlocks(token)); break;
      case 'blockquote': blocks.push(schema.nodes.blockquote.create(null, blocksFromTokens(token.tokens))); break;
      case 'code':
        if (token.codeBlockStyle === 'indented' && token.text.split('\n').every((line) => COMMENT_RE.test(line))) blocks.push(...paragraphBlocks({ text: token.text }));
        else blocks.push(schema.nodes.code_block.create({ language: token.lang || '' }, token.text ? schema.text(token.text) : null));
        break;
      case 'hr': blocks.push(schema.nodes.horizontal_rule.create()); break;
      case 'list': {
        // Mixed lists are split into consecutive homogeneous runs, retaining every item.
        let run = [], task = null;
        const flush = () => { if (run.length) blocks.push(schema.nodes[task ? 'task_list' : token.ordered ? 'ordered_list' : 'bullet_list'].create(token.ordered && !task ? { order: Number(token.start) || 1 } : null, run)); run = []; };
        for (const item of token.items) {
          const emptyTask = /^\[([ xX])\]\s*$/.exec(item.text);
          const isTask = Boolean(item.task || emptyTask);
          if (task !== null && isTask !== task) flush();
          task = isTask;
          let content = emptyTask ? [para()] : blocksFromTokens(item.tokens.filter((part) => part.type !== 'checkbox'));
          if (!content.length || content[0].type !== schema.nodes.paragraph) content.unshift(para());
          run.push(schema.nodes[task ? 'task_item' : 'list_item'].create(task ? { checked: emptyTask ? /x/i.test(emptyTask[1]) : Boolean(item.checked) } : null, content));
        }
        flush(); break;
      }
      case 'table': {
        const row = (cells, header) => schema.nodes.table_row.create(null, cells.map((cell) => schema.nodes[header ? 'table_header' : 'table_cell'].create(null, para(inline(cell.tokens)))));
        blocks.push(schema.nodes.table.create(null, [row(token.header, true), ...token.rows.map((cells) => row(cells, false))])); break;
      }
      case 'html':
        if (/^<table\s+data-atlas-table/i.test(token.raw) && parseTableHtml(token.raw)) blocks.push(parseTableHtml(token.raw));
        else if (/^<p><\/p>\s*$/.test(token.raw)) blocks.push(para());
        else blocks.push(schema.nodes.source_block.create({ raw: token.raw.replace(/\n$/, '') }));
        break;
      default: blocks.push(schema.nodes.source_block.create({ raw: token.raw || '' }));
    }
  }
  return blocks.length ? blocks : [para()];
}

function parseBlocks(source, depth = 0) {
  if (depth > 80) return [schema.nodes.source_block.create({ raw: source })];
  const details = outerAccordions(source);
  if (!details.length) return blocksFromTokens(marked.lexer(source, { gfm: true }));
  const out = [];
  let from = 0;
  for (const part of details) {
    if (source.slice(from, part.from).trim()) out.push(...parseBlocks(source.slice(from, part.from), depth + 1));
    out.push(schema.nodes.details.create({ open: part.open }, [schema.nodes.summary.create(null, inline(marked.Lexer.lexInline(source.slice(part.titleFrom, part.titleTo)))), schema.nodes.details_content.create(null, parseBlocks(source.slice(part.bodyFrom, part.closeFrom), depth + 1))]));
    from = part.to;
  }
  if (source.slice(from).trim()) out.push(...parseBlocks(source.slice(from), depth + 1));
  return out;
}

class Output {
  text = '';
  positions = [];
  points = new Map();
  point(pos) { this.points.set(pos, this.text.length); return this; }
  write(text, pos) { this.text += text; for (let i = 0; i < text.length; i++) this.positions.push(pos); return this; }
  literal(text, pos, encode = (char) => char) {
    for (let i = 0; i < text.length; i++) { this.points.set(pos + i, this.text.length); this.write(encode(text[i]), pos + i); }
    this.points.set(pos + text.length, this.text.length); return this;
  }
  append(other) {
    const start = this.text.length; this.text += other.text;
    for (const pos of other.positions) this.positions.push(pos);
    for (const [pos, offset] of other.points) this.points.set(pos, start + offset);
    return this;
  }
  prefix(first, rest, pos, includeEmpty = false) {
    const next = new Output(), offsets = [];
    let start = true, initial = true;
    for (let i = 0; i < this.text.length; i++) {
      if (start && (this.text[i] !== '\n' || includeEmpty)) { next.write(initial ? first : rest, pos); initial = false; start = false; }
      offsets[i] = next.text.length; next.write(this.text[i], this.positions[i]);
      if (this.text[i] === '\n') start = true;
    }
    offsets[this.text.length] = next.text.length;
    if (!this.text.length) next.write(first, pos);
    for (const [point, offset] of this.points) next.points.set(point, offsets[offset] ?? next.text.length);
    return next;
  }
}
const escaped = (char) => /[\\`*_{}\[\]<>#~|+.!\-=]/.test(char) ? `\\${char}` : ({ '&': '&amp;', ':': '&#58;', '@': '&#64;', '\t': '&#9;' })[char] || char;
const htmlChar = (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char] || char;
const destination = (value) => /[\s()]/.test(value) ? `<${value.replace(/[<>]/g, encodeURIComponent)}>` : value.replace(/\\/g, '\\\\');

function inlineOutput(node, pos) {
  const out = new Output();
  if (!node.content.size) out.point(pos);
  node.forEach((child, offset) => {
    const at = pos + offset;
    const opens = [], closes = [];
    for (const mark of child.marks) {
      if (mark.type.name === 'link') { opens.push('['); closes.unshift(`](${destination(mark.attrs.href)}${mark.attrs.title ? ` "${escapeTitle(mark.attrs.title)}"` : ''})`); }
      else { const tag = { strong: 'strong', em: 'em', underline: 'u', strike: 's', code: 'code' }[mark.type.name]; if (tag) { opens.push(`<${tag}>`); closes.unshift(`</${tag}>`); } }
    }
    out.write(opens.join(''), at);
    if (child.isText) {
      let index = 0;
      const encode = child.marks.some((m) => m.type.name === 'code') ? htmlChar : (char) => { const result = char === ' ' && (index === 0 || child.text[index - 1] === '\n') ? '&#32;' : escaped(char); index++; return result; };
      out.literal(child.text, at, encode);
    }
    else if (child.type.name === 'hard_break') out.point(at).write('  \n', at).point(at + 1);
    else if (child.type.name === 'image') out.point(at).write(`![${child.attrs.alt.replace(/[\[\]\\]/g, '\\$&')}](${destination(child.attrs.src)}${child.attrs.title ? ` "${escapeTitle(child.attrs.title)}"` : ''})`, at).point(at + 1);
    out.write(closes.join(''), at + child.nodeSize);
  });
  return out;
}

function childrenOutput(node, pos) {
  const out = new Output();
  node.forEach((child, offset, index) => { if (index) out.write(child.type.name === 'comment' ? '\n' : '\n\n', pos + offset); out.append(blockOutput(child, pos + offset)); });
  return out;
}

function blockOutput(node, pos) {
  const out = new Output(), kind = node.type.name;
  if (kind === 'comment') return out.write(`${node.attrs.indent}💬 ${node.attrs.stamp} · `, pos).append(inlineOutput(node, pos + 1));
  if (kind === 'paragraph' || kind === 'heading' || kind === 'summary') {
    if (kind === 'heading') out.write('#'.repeat(node.attrs.level) + ' ', pos + 1);
    if (!node.content.size && kind === 'paragraph') return out.write('<p>', pos + 1).point(pos + 1).write('</p>', pos + 1);
    return out.append(inlineOutput(node, pos + 1));
  }
  if (kind === 'code_block') {
    const longest = Math.max(2, ...(node.textContent.match(/`+/g) || []).map((run) => run.length));
    const fence = '`'.repeat(longest + 1);
    return out.write(fence + node.attrs.language.replace(/[\r\n`]/g, '') + '\n', pos).literal(node.textContent, pos + 1).write('\n' + fence, pos + node.nodeSize - 1);
  }
  if (kind === 'horizontal_rule') return out.write('---', pos);
  if (kind === 'source_block') return out.point(pos).write(node.attrs.raw, pos).point(pos + node.nodeSize);
  if (kind === 'blockquote') return childrenOutput(node, pos + 1).prefix('> ', '> ', pos, true);
  if (['bullet_list', 'ordered_list', 'task_list'].includes(kind)) {
    node.forEach((item, offset, index) => {
      if (index) out.write('\n', pos + offset);
      const marker = kind === 'ordered_list' ? `${node.attrs.order + index}. ` : kind === 'task_list' ? `- [${item.attrs.checked ? 'x' : ' '}] ` : '- ';
      const body = childrenOutput(item, pos + offset + 2);
      if (item.childCount === 1 && !item.firstChild.content.size) body.text = '';
      out.append(body.prefix(marker, ' '.repeat(kind === 'task_list' ? 2 : marker.length), pos + offset + 1));
    }); return out;
  }
  if (kind === 'details') {
    const summary = node.firstChild;
    out.write(`<details${node.attrs.open ? ' open' : ''}>\n<summary>`, pos).append(inlineOutput(summary, pos + 2)).write('</summary>\n\n', pos + summary.nodeSize + 1);
    return out.append(childrenOutput(node.lastChild, pos + summary.nodeSize + 2)).write('\n\n</details>', pos + node.nodeSize - 1);
  }
  if (kind === 'table') {
    let complex = false;
    node.forEach((row) => row.forEach((cell) => {
      if (cell.childCount !== 1 || cell.firstChild.type.name !== 'paragraph' || cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1 || cell.attrs.colwidth || (row === node.firstChild ? cell.type.name !== 'table_header' : cell.type.name !== 'table_cell')) complex = true;
      cell.descendants((child) => { if (['hard_break', 'image'].includes(child.type.name) || child.isText && /[\r\n]/.test(child.text) || child.marks.some((mark) => mark.type.name === 'code' || mark.type.name === 'link')) complex = true; });
    }));
    if (complex) return htmlOutput(node, pos, () => new Output());
    node.forEach((row, rowOffset, rowIndex) => {
      if (rowIndex) out.write('\n', pos + rowOffset + 1);
      out.write('| ', pos + rowOffset + 1);
      row.forEach((cell, cellOffset, cellIndex) => {
        if (cellIndex) out.write(' | ', pos + rowOffset + cellOffset + 2);
        const paragraph = cell.firstChild;
        out.append(inlineOutput(paragraph, pos + rowOffset + cellOffset + 4));
      });
      out.write(' |', pos + rowOffset + row.nodeSize);
      if (!rowIndex) out.write('\n| ' + Array(row.childCount).fill('---').join(' | ') + ' |', pos + rowOffset + 1);
    }); return out;
  }
  return childrenOutput(node, pos + 1);
}

export function serializeMarkdown(doc) {
  const output = doc.childCount === 1 && doc.firstChild.type.name === 'paragraph' && !doc.firstChild.content.size ? new Output() : childrenOutput(doc, 0);
  const docMap = new Int32Array(doc.content.size + 1).fill(-1);
  const sourceMap = Uint32Array.from([...output.positions, doc.content.size]);
  for (const [point, offset] of output.points) { docMap[point] = offset; sourceMap[offset] = point; }
  let last = -1;
  for (let i = 0; i < docMap.length; i++) { if (docMap[i] >= 0) last = docMap[i]; else if (last >= 0) docMap[i] = last; }
  last = 0;
  for (let i = docMap.length - 1; i >= 0; i--) { if (docMap[i] >= 0) last = docMap[i]; else docMap[i] = last; }
  const toSource = (pos) => docMap[Math.max(0, Math.min(doc.content.size, pos))];
  const toDocument = (offset) => sourceMap[Math.max(0, Math.min(output.text.length, offset))];
  return { text: output.text, toSource, toDocument };
}

/** Offset alignment retains exact original bytes until an actual user edit serializes the model. */
export function alignOffsets(from, to) {
  if (from === to) return (pos) => Math.max(0, Math.min(to.length, pos));
  const map = new Uint32Array(from.length + 1);
  const aLines = from.match(/[^\n]*\n|[^\n]+$/g) || [], bLines = to.match(/[^\n]*\n|[^\n]+$/g) || [];
  const key = (line) => decode(line.replace(/<[^>]*>/g, '').replace(/\\([\s\S])/g, '$1')).replace(/[\s*_~`#>+\-|.!=]/g, '');
  const changes = diffArrays(aLines.map(key), bLines.map(key), { timeout: 200 }) || [{ removed: true, value: aLines }, { added: true, value: bLines }];
  let aIndex = 0, bIndex = 0, a = 0, b = 0;
  const pair = (left, right) => {
    const parts = diffChars(left, right, { timeout: 30 });
    if (!parts) {
      for (let i = 0; i < left.length; i++) map[a + i] = b + Math.round(i * right.length / Math.max(1, left.length));
      a += left.length; b += right.length; return;
    }
    for (const part of parts) {
      if (part.added) b += part.value.length;
      else for (let i = 0; i < part.value.length; i++) { map[a++] = b; if (!part.removed) b++; }
    }
  };
  for (let index = 0; index < changes.length; index++) {
    const part = changes[index];
    if (!part.added && !part.removed) {
      for (let i = 0; i < part.value.length; i++) pair(aLines[aIndex++], bLines[bIndex++]);
    } else if (part.removed) {
      const added = changes[index + 1]?.added ? changes[++index] : null;
      const rightCount = added?.value.length || 0;
      if (rightCount === part.value.length) for (let i = 0; i < rightCount; i++) pair(aLines[aIndex++], bLines[bIndex++]);
      else {
        const left = aLines.slice(aIndex, aIndex + part.value.length).join(''), right = bLines.slice(bIndex, bIndex + rightCount).join('');
        pair(left, right); aIndex += part.value.length; bIndex += rightCount;
      }
    } else { for (let i = 0; i < part.value.length; i++) b += bLines[bIndex++].length; }
  }
  map[from.length] = to.length;
  return (pos) => map[Math.max(0, Math.min(from.length, pos))];
}

export function parseMarkdown(source) {
  const doc = schema.nodes.doc.create(null, parseBlocks(String(source)));
  const canonical = serializeMarkdown(doc);
  const originalToCanonical = alignOffsets(String(source), canonical.text);
  const canonicalToOriginal = alignOffsets(canonical.text, String(source));
  return { doc, text: String(source), toDocument: (offset) => canonical.toDocument(originalToCanonical(offset)), toSource: (pos) => canonicalToOriginal(canonical.toSource(pos)) };
}

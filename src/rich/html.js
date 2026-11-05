// Structural HTML codec for complex tables produced by this editor. Parsing never executes HTML.
import { parseFragment, serializeOuter } from 'parse5';
import { richSchema as schema, safeImage, safeLink } from './schema.js';

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const attrs = (node) => Object.fromEntries((node.attrs || []).map((attr) => [attr.name, attr.value]));
const children = (node) => node.childNodes || [];
const textOf = (node) => node.nodeName === '#text' ? node.value : children(node).map(textOf).join('');
const para = (content = []) => schema.nodes.paragraph.create(null, content);
const marks = { strong: 'strong', b: 'strong', em: 'em', i: 'em', u: 'underline', s: 'strike', del: 'strike', code: 'code' };

function inlines(nodes, active = []) {
  const out = [];
  for (const node of nodes) {
    const tag = node.tagName, attr = attrs(node);
    if (node.nodeName === '#text') { if (node.value) out.push(schema.text(node.value, active)); }
    else if (tag === 'br') out.push(schema.nodes.hard_break.create());
    else if (tag === 'img' && safeImage(attr.src)) out.push(schema.nodes.image.create({ src: safeImage(attr.src), alt: attr.alt || '', title: attr.title || '' }, null, active));
    else if (tag === 'a') out.push(...inlines(children(node), safeLink(attr.href) ? schema.marks.link.create({ href: safeLink(attr.href), title: attr.title || '' }).addToSet(active) : active));
    else if (marks[tag]) out.push(...inlines(children(node), schema.marks[marks[tag]].create().addToSet(active)));
    else if (tag) out.push(schema.text(serializeOuter(node), active));
  }
  return out;
}

function blocks(nodes) {
  const out = [];
  for (const node of nodes) {
    const tag = node.tagName, attr = attrs(node);
    if (node.nodeName === '#text') { if (node.value.trim()) out.push(para([schema.text(node.value)])); continue; }
    if (tag === 'p') out.push(para(inlines(children(node))));
    else if (tag === 'aside' && 'data-atlas-comment' in attr) out.push(schema.nodes.comment.create({ stamp: attr['data-stamp'] || '', indent: attr['data-indent'] || '' }, inlines(children(node))));
    else if (/^h[1-6]$/.test(tag)) out.push(schema.nodes.heading.create({ level: Number(tag[1]) }, inlines(children(node))));
    else if (tag === 'blockquote') out.push(schema.nodes.blockquote.create(null, blocks(children(node))));
    else if (tag === 'pre') {
      if ('data-atlas-source' in attr) out.push(schema.nodes.source_block.create({ raw: textOf(node) }));
      else out.push(schema.nodes.code_block.create({ language: attr['data-language'] || '' }, textOf(node) ? schema.text(textOf(node)) : null));
    } else if (tag === 'hr') out.push(schema.nodes.horizontal_rule.create());
    else if (tag === 'ul' || tag === 'ol') {
      const task = 'data-task-list' in attr;
      const items = children(node).filter((child) => child.tagName === 'li').map((child) => {
        const content = blocks(children(child)); if (content[0].type !== schema.nodes.paragraph) content.unshift(para());
        return schema.nodes[task ? 'task_item' : 'list_item'].create(task ? { checked: attrs(child)['data-checked'] === 'true' } : null, content);
      });
      if (items.length) out.push(schema.nodes[task ? 'task_list' : tag === 'ol' ? 'ordered_list' : 'bullet_list'].create(tag === 'ol' ? { order: Number(attr.start) || 1 } : null, items));
    } else if (tag === 'details') {
      const summary = children(node).find((child) => child.tagName === 'summary');
      const body = children(node).find((child) => 'data-details-content' in attrs(child));
      out.push(schema.nodes.details.create({ open: 'open' in attr }, [schema.nodes.summary.create(null, summary ? inlines(children(summary)) : null), schema.nodes.details_content.create(null, blocks(body ? children(body) : children(node).filter((child) => child !== summary)))]));
    } else if (tag === 'table') {
      const rows = children(node).flatMap((child) => ['tbody', 'thead', 'tfoot'].includes(child.tagName) ? children(child) : [child]).filter((child) => child.tagName === 'tr');
      out.push(schema.nodes.table.create(null, rows.map((row) => schema.nodes.table_row.create(null, children(row).filter((cell) => cell.tagName === 'td' || cell.tagName === 'th').map((cell) => {
        const values = attrs(cell);
        const widths = values['data-colwidth']?.split(',').map(Number).filter((value) => Number.isFinite(value) && value > 0) || null;
        return schema.nodes[cell.tagName === 'th' ? 'table_header' : 'table_cell'].create({ colspan: Math.max(1, Math.min(1000, Number(values.colspan) || 1)), rowspan: Math.max(1, Math.min(1000, Number(values.rowspan) || 1)), colwidth: widths?.length ? widths : null }, blocks(children(cell)));
      })))));
    } else if (tag) out.push(schema.nodes.source_block.create({ raw: serializeOuter(node) }));
  }
  return out.length ? out : [para()];
}

export function parseTableHtml(raw) {
  if (!/^<table\s+data-atlas-table(?:[\s=>])/i.test(raw)) return null;
  const roots = parseFragment(raw).childNodes.filter((node) => node.nodeName !== '#text' || node.value.trim());
  if (roots.length !== 1) return null;
  const table = roots.find((node) => node.tagName === 'table');
  return table ? blocks([table])[0] : null;
}

export function htmlOutput(node, pos, makeOutput) {
  const out = makeOutput();
  const kind = node.type.name;
  if (node.isText) {
    const close = [];
    for (const mark of node.marks) {
      if (mark.type.name === 'link') { out.write(`<a href="${esc(safeLink(mark.attrs.href))}" title="${esc(mark.attrs.title)}">`, pos); close.unshift('</a>'); }
      else { const tag = { strong: 'strong', em: 'em', underline: 'u', strike: 's', code: 'code' }[mark.type.name]; if (tag) { out.write(`<${tag}>`, pos); close.unshift(`</${tag}>`); } }
    }
    return out.literal(node.text, pos, esc).write(close.join(''), pos + node.nodeSize);
  }
  if (kind === 'hard_break') return out.write('<br>', pos);
  if (kind === 'image') return out.write(`<img src="${esc(safeImage(node.attrs.src))}" alt="${esc(node.attrs.alt)}" title="${esc(node.attrs.title)}">`, pos);
  if (kind === 'horizontal_rule') return out.write('<hr>', pos);
  if (kind === 'source_block') return out.write('<pre data-atlas-source="">', pos).write(esc(node.attrs.raw), pos).write('</pre>', pos + node.nodeSize);
  if (kind === 'code_block') return out.write(`<pre data-language="${esc(node.attrs.language)}"><code>`, pos).literal(node.textContent, pos + 1, esc).write('</code></pre>', pos + node.nodeSize - 1);
  const tag = { paragraph: 'p', heading: `h${node.attrs.level}`, comment: 'aside', blockquote: 'blockquote', bullet_list: 'ul', ordered_list: 'ol', task_list: 'ul', list_item: 'li', task_item: 'li', details: 'details', summary: 'summary', details_content: 'div', table: 'table', table_row: 'tr', table_cell: 'td', table_header: 'th' }[kind];
  let attributes = '';
  if (kind === 'table') attributes = ' data-atlas-table=""';
  if (kind === 'comment') attributes = ` data-atlas-comment="" data-stamp="${esc(node.attrs.stamp)}" data-indent="${esc(node.attrs.indent)}"`;
  if (kind === 'task_list') attributes = ' data-task-list=""';
  if (kind === 'task_item') attributes = ` data-checked="${Boolean(node.attrs.checked)}"`;
  if (kind === 'ordered_list') attributes = ` start="${Number(node.attrs.order) || 1}"`;
  if (kind === 'details' && node.attrs.open) attributes = ' open';
  if (kind === 'details_content') attributes = ' data-details-content=""';
  if (kind === 'table_cell' || kind === 'table_header') attributes = ` colspan="${node.attrs.colspan}" rowspan="${node.attrs.rowspan}"${node.attrs.colwidth ? ` data-colwidth="${node.attrs.colwidth.join(',')}"` : ''}`;
  if (tag) out.write(`<${tag}${attributes}>`, pos);
  if (node.isTextblock && !node.content.size) out.point?.(pos + 1);
  node.forEach((child, offset) => out.append(htmlOutput(child, pos + offset + (kind === 'doc' ? 0 : 1), makeOutput)));
  if (tag) out.write(`</${tag}>`, pos + node.nodeSize - 1);
  return out;
}

export function renderSafeHtml(node) {
  class TextOutput {
    text = '';
    write(text) { this.text += text; return this; }
    literal(text, pos, encode) { for (const char of text) this.text += encode(char); return this; }
    append(part) { this.text += part.text; return this; }
  }
  return htmlOutput(node, 0, () => new TextOutput()).text;
}

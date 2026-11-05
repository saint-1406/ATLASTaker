import { Schema } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';

export const safeLink = (href) => /^(?:https?:|mailto:|atlas:|#)/i.test(String(href ?? '').trim()) ? String(href).trim() : '';
export const safeImage = (src) => /^(?:https?:|assets\/a-[a-z0-9.-]+$)/i.test(String(src ?? '')) ? String(src) : '';

export const richSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
    heading: { attrs: { level: { default: 1 } }, content: 'inline*', group: 'block', defining: true, parseDOM: [1,2,3,4,5,6].map((level) => ({ tag: `h${level}`, attrs: { level } })), toDOM: (node) => [`h${node.attrs.level}`, 0] },
    blockquote: { content: 'block+', group: 'block', defining: true, parseDOM: [{ tag: 'blockquote' }], toDOM: () => ['blockquote', 0] },
    comment: { attrs: { stamp: { default: '' }, indent: { default: '' } }, content: 'inline*', group: 'block', defining: true, toDOM: (node) => ['aside', { class: 'rich-comment' }, ['span', { class: 'rich-comment-stamp', contenteditable: 'false' }, `💬 ${node.attrs.stamp} · `], ['span', 0]] },
    bullet_list: { content: 'list_item+', group: 'block', parseDOM: [{ tag: 'ul:not([data-task-list])' }], toDOM: () => ['ul', 0] },
    ordered_list: { attrs: { order: { default: 1 } }, content: 'list_item+', group: 'block', parseDOM: [{ tag: 'ol', getAttrs: (dom) => ({ order: Number(dom.getAttribute('start')) || 1 }) }], toDOM: (node) => ['ol', { start: node.attrs.order }, 0] },
    list_item: { content: 'paragraph block*', defining: true, parseDOM: [{ tag: 'li:not([data-task-item])' }], toDOM: () => ['li', 0] },
    task_list: { content: 'task_item+', group: 'block', parseDOM: [{ tag: 'ul[data-task-list]' }], toDOM: () => ['ul', { 'data-task-list': '' }, 0] },
    task_item: { attrs: { checked: { default: false } }, content: 'paragraph block*', defining: true, parseDOM: [{ tag: 'li[data-task-item]', getAttrs: (dom) => ({ checked: dom.getAttribute('data-checked') === 'true' }) }], toDOM: (node) => ['li', { 'data-task-item': '', 'data-checked': String(node.attrs.checked) }, 0] },
    code_block: { attrs: { language: { default: '' } }, content: 'text*', marks: '', group: 'block', code: true, defining: true, parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }], toDOM: (node) => ['pre', ['code', { 'data-language': node.attrs.language }, 0]] },
    horizontal_rule: { group: 'block', atom: true, parseDOM: [{ tag: 'hr' }], toDOM: () => ['hr'] },
    text: { group: 'inline' },
    hard_break: { inline: true, group: 'inline', selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
    image: { inline: true, group: 'inline', atom: true, attrs: { src: {}, alt: { default: '' }, title: { default: '' } }, parseDOM: [{ tag: 'img[src]', getAttrs: (dom) => safeImage(dom.getAttribute('src')) ? { src: safeImage(dom.getAttribute('src')), alt: dom.getAttribute('alt') || '', title: dom.getAttribute('title') || '' } : false }], toDOM: (node) => ['img', { ...node.attrs, src: safeImage(node.attrs.src) }] },
    details: { attrs: { open: { default: true } }, group: 'block', content: 'summary details_content', defining: true, isolating: true, parseDOM: [{ tag: 'details', getAttrs: (dom) => ({ open: dom.hasAttribute('open') }) }], toDOM: (node) => ['details', node.attrs.open ? { open: '' } : {}, 0] },
    summary: { content: 'inline*', defining: true, parseDOM: [{ tag: 'summary' }], toDOM: () => ['summary', 0] },
    details_content: { content: 'block+', parseDOM: [{ tag: 'div[data-details-content]' }], toDOM: () => ['div', { 'data-details-content': '' }, 0] },
    source_block: { attrs: { raw: { default: '' } }, group: 'block', atom: true, selectable: true, parseDOM: [{ tag: 'pre[data-atlas-source]', priority: 100, getAttrs: (dom) => ({ raw: dom.textContent }) }], toDOM: (node) => ['pre', { 'data-atlas-source': '' }, node.attrs.raw] },
    ...tableNodes({ tableGroup: 'block', cellContent: 'block+' }),
  },
  marks: {
    strong: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: () => ['strong', 0] },
    em: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
    underline: { parseDOM: [{ tag: 'u' }], toDOM: () => ['u', 0] },
    strike: { parseDOM: [{ tag: 's' }, { tag: 'del' }], toDOM: () => ['s', 0] },
    code: { excludes: '_', code: true, parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
    link: { attrs: { href: {}, title: { default: '' } }, inclusive: false, parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => safeLink(dom.getAttribute('href')) ? { href: safeLink(dom.getAttribute('href')), title: dom.getAttribute('title') || '' } : false }], toDOM: (mark) => ['a', { href: safeLink(mark.attrs.href), title: mark.attrs.title, rel: 'noopener noreferrer' }, 0] },
  },
});

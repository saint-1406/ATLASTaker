// FictionBook 2 (.fb2): an XML book. Its description gives title, authors and cover; each <body>
// holds nested <section>s; pictures sit at the end as base64 <binary> elements.

import { attr, child, children, elements, find, findAll, local, parseXml, textOf } from './xml.js';
import { el, safeHref } from './model.js';

function base64Bytes(text) {
  const bin = atob(text.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const personName = (node) =>
  ['first-name', 'middle-name', 'last-name']
    .map((part) => textOf(child(node, part)).trim())
    .filter(Boolean)
    .join(' ') || textOf(child(node, 'nickname')).trim();

export function fb2Book(text) {
  const doc = parseXml(text);
  const book = find(doc, 'fictionbook') ?? doc;
  const resources = new Map();
  for (const bin of findAll(book, ['binary'])) {
    const id = bin.attrs.id;
    if (!id) continue;
    try {
      resources.set(id, { type: bin.attrs['content-type'] || 'image/jpeg', bytes: base64Bytes(textOf(bin)) });
    } catch {
      // a broken picture: the book reads fine without it
    }
  }
  const info = find(book, 'title-info');
  const ref = (href) => {
    const id = String(href ?? '').replace(/^#/, '');
    return resources.has(id) ? id : null;
  };
  const ctx = {
    ref,
    id: (raw) => (raw ? `fb-${raw}` : null),
    link(href) {
      const value = String(href ?? '');
      return value.startsWith('#') ? (value.length > 1 ? `#fb-${value.slice(1)}` : null) : safeHref(value);
    },
  };
  const blocks = [];
  for (const body of children(book, 'body')) {
    const inner = flow(body, ctx, 0);
    if (body.attrs.name === 'notes' || body.attrs.name === 'comments') blocks.push(el('section', { class: 'notes' }, inner));
    else blocks.push(...inner);
  }
  return {
    title: textOf(child(info, 'book-title')).replace(/\s+/g, ' ').trim(),
    author: children(info, 'author').map(personName).filter(Boolean).join(', '),
    lang: textOf(child(info, 'lang')).trim(),
    cover: ref(attr(find(child(info, 'coverpage'), 'image'), 'href')),
    blocks,
    resources,
  };
}

function flow(node, ctx, depth) {
  const out = [];
  for (const c of elements(node)) {
    const name = local(c.name);
    const id = ctx.id(c.attrs.id);
    switch (name) {
      case 'title': {
        // a title is a few paragraphs: one heading, lines kept apart
        const lines = children(c, 'p').map((p) => inline(p, ctx));
        const kids = lines.length ? lines.flatMap((line, i) => (i ? [el('br'), ...line] : line)) : inline(c, ctx);
        if (kids.length) out.push(el(`h${Math.min(6, depth + 1)}`, { id }, kids));
        break;
      }
      case 'section':
        out.push(el('section', { id }, flow(c, ctx, depth + 1)));
        break;
      case 'p':
        out.push(el('p', { id }, inline(c, ctx)));
        break;
      case 'subtitle':
        out.push(el('p', { id, class: 'subtitle' }, inline(c, ctx)));
        break;
      case 'empty-line':
        out.push(el('p', { class: 'gap' }));
        break;
      case 'epigraph':
        out.push(el('blockquote', { id, class: 'epigraph' }, flow(c, ctx, depth)));
        break;
      case 'cite':
      case 'annotation':
        out.push(el('blockquote', { id, class: 'cite' }, flow(c, ctx, depth)));
        break;
      case 'poem':
        out.push(el('blockquote', { id, class: 'poem' }, flow(c, ctx, depth)));
        break;
      case 'stanza':
        out.push(el('section', { id, class: 'stanza' }, flow(c, ctx, depth)));
        break;
      case 'v':
        out.push(el('p', { id, class: 'verse' }, inline(c, ctx)));
        break;
      case 'text-author':
      case 'date':
        out.push(el('p', { id, class: 'author' }, inline(c, ctx)));
        break;
      case 'image': {
        const ref = ctx.ref(attr(c, 'href'));
        if (ref) out.push(el('figure', { id }, [el('img', { ref, alt: c.attrs.alt ?? c.attrs.title ?? '' })]));
        break;
      }
      case 'table':
        out.push(
          el('table', { id }, [
            el(
              'tbody',
              {},
              children(c, 'tr').map((tr) =>
                el(
                  'tr',
                  {},
                  elements(tr)
                    .filter((cell) => ['td', 'th'].includes(local(cell.name)))
                    .map((cell) => el(local(cell.name), { colspan: cell.attrs.colspan, rowspan: cell.attrs.rowspan }, inline(cell, ctx))),
                ),
              ),
            ),
          ]),
        );
        break;
      default:
        out.push(...flow(c, ctx, depth));
    }
  }
  return out;
}

const INLINE = { emphasis: 'em', strong: 'strong', strikethrough: 's', sub: 'sub', sup: 'sup', code: 'code' };

function inline(node, ctx) {
  const out = [];
  for (const c of node.children) {
    if (typeof c === 'string') {
      out.push(c);
      continue;
    }
    const name = local(c.name);
    if (INLINE[name]) out.push(el(INLINE[name], {}, inline(c, ctx)));
    else if (name === 'a') {
      const href = ctx.link(attr(c, 'href'));
      const kids = inline(c, ctx);
      if (!href) out.push(...kids);
      else if (c.attrs.type === 'note') out.push(el('sup', {}, [el('a', { href }, kids)]));
      else out.push(el('a', { href }, kids));
    } else if (name === 'image') {
      const ref = ctx.ref(attr(c, 'href'));
      if (ref) out.push(el('img', { ref, alt: c.attrs.alt ?? '' }));
    } else out.push(...inline(c, ctx));
  }
  return out;
}

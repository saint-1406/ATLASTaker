// What every book becomes before it is shown: a small tree of known, harmless elements.
//   node = string | { tag, attrs, children }
// Only the tags in TAGS and the attributes in ATTRS exist; a picture names a resource of the book
// (attrs.ref), never a URL; a link is "#anchor" inside the book or an http(s)/mailto address. The
// reader builds the page from this tree with createElement, so nothing in a document can run.

export const TAGS = new Set([
  'section', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'tbody', 'tr', 'td', 'th', 'hr', 'figure', 'figcaption', 'em', 'strong', 'u', 's', 'sup', 'sub',
  'code', 'a', 'span', 'br', 'img',
]);
export const CLASSES = new Set(['epigraph', 'poem', 'stanza', 'verse', 'author', 'subtitle', 'cite', 'gap', 'notes', 'task']);
const BLOCKS = new Set(['section', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'dl', 'table', 'hr', 'figure']);

export function el(tag, attrs = {}, children = []) {
  const clean = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === '') continue;
    if (key === 'class' && !CLASSES.has(value)) continue;
    if ((key === 'colspan' || key === 'rowspan') && !/^[1-9]\d{0,2}$/.test(String(value))) continue;
    clean[key] = String(value);
  }
  return { tag, attrs: clean, children: children.filter((c) => c != null && c !== '') };
}

export const isBlock = (node) => typeof node !== 'string' && BLOCKS.has(node.tag);

/** A link a reader may follow: inside the book, or out to the web or mail. */
export function safeHref(href) {
  const value = String(href ?? '').trim();
  if (value.startsWith('#')) return value.length > 1 ? value : null;
  return /^(https?:\/\/|mailto:)/i.test(value) ? value : null;
}

/** The text a node shows. */
export function plain(node) {
  if (typeof node === 'string') return node;
  if (node.tag === 'br') return '\n';
  return node.children.map(plain).join('');
}

/**
 * Bytes to text: a byte-order mark or a declared encoding first, then UTF-8 if it decodes cleanly,
 * else Windows-1251 — what older Russian books and text files use.
 */
export function decodeText(bytes, hint) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const head = String.fromCharCode(...bytes.subarray(0, 1024));
  const declared = /<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1] ?? /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ?? hint;
  if (declared) {
    try {
      return new TextDecoder(declared.toLowerCase()).decode(bytes);
    } catch {
      // a name the browser does not know: guess below
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

// ---------- HTML (EPUB chapters, .html files, the HTML inside Markdown) ----------

const DROP = new Set([
  'script', 'style', 'head', 'noscript', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea',
  'svg', 'math', 'template', 'link', 'meta', 'title', 'video', 'audio', 'canvas', 'map', 'frameset', 'frame', 'applet',
]);
const CONTAINERS = new Set([
  '#root', 'html', 'body', 'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'center',
  'hgroup', 'details', 'summary', 'address', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'caption',
]);
const INLINE = {
  em: 'em', i: 'em', cite: 'em', dfn: 'em', var: 'em', strong: 'strong', b: 'strong', u: 'u', ins: 'u',
  s: 's', strike: 's', del: 's', sup: 'sup', sub: 'sub', code: 'code', tt: 'code', kbd: 'code', samp: 'code',
};
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const local = (name) => name.slice(name.indexOf(':') + 1);
const hasText = (nodes) => nodes.some((n) => (typeof n === 'string' ? n.trim() : n.tag === 'img' || hasText(n.children)));

function trimRun(run) {
  const out = [...run];
  while (typeof out[0] === 'string' && !out[0].trim()) out.shift();
  while (typeof out[out.length - 1] === 'string' && !out[out.length - 1].trim()) out.pop();
  if (typeof out[0] === 'string') out[0] = out[0].trimStart();
  if (typeof out[out.length - 1] === 'string') out[out.length - 1] = out[out.length - 1].trimEnd();
  return out;
}

const textOf = (node) => (typeof node === 'string' ? node : node.children.map(textOf).join(''));

/**
 * ctx: { image(src) → ref | null, link(href) → href | null, id(raw) → id } — how this document's
 * pictures, links and anchors map onto the book.
 */
export function htmlBlocks(nodes, ctx) {
  const out = [];
  let run = [];
  let pendingId = null;
  const takeId = () => {
    const id = pendingId;
    pendingId = null;
    return id;
  };
  const flush = () => {
    if (hasText(run)) out.push(el('p', { id: takeId() }, trimRun(run)));
    run = [];
  };
  for (const node of nodes) {
    if (typeof node === 'string') {
      run.push(node);
      continue;
    }
    const name = local(node.name);
    if (DROP.has(name)) continue;
    const id = node.attrs.id ? ctx.id(node.attrs.id) : null;
    if (CONTAINERS.has(name)) {
      flush();
      const inner = htmlBlocks(node.children, ctx);
      // a container's anchor goes to its first block
      if (id && inner[0] && !inner[0].attrs.id) inner[0].attrs.id = id;
      else if (id) pendingId = id;
      out.push(...inner);
      continue;
    }
    const block = htmlBlock(node, name, id, ctx);
    if (block !== undefined) {
      flush();
      if (block) {
        if (pendingId && !block.attrs.id) block.attrs.id = takeId();
        out.push(block);
      }
      continue;
    }
    run.push(...htmlInline(node, ctx));
  }
  flush();
  return out;
}

/** The block a tag makes; undefined when the tag is not a block one, null when it makes nothing. */
function htmlBlock(node, name, id, ctx) {
  if (name === 'p') {
    const kids = trimRun(htmlInlines(node.children, ctx));
    return hasText(kids) ? el('p', { id }, kids) : null;
  }
  if (HEADINGS.has(name)) {
    const kids = trimRun(htmlInlines(node.children, ctx));
    return hasText(kids) ? el(name, { id }, kids) : null;
  }
  if (name === 'pre') return el('pre', { id }, [textOf(node).replace(/^\n/, '')]);
  if (name === 'blockquote') return el('blockquote', { id }, htmlBlocks(node.children, ctx));
  if (name === 'hr') return el('hr');
  if (name === 'ul' || name === 'ol') {
    const items = node.children.filter((c) => typeof c !== 'string' && local(c.name) === 'li');
    if (!items.length) return null;
    return el(name, { id }, items.map((li) => el('li', { id: li.attrs.id ? ctx.id(li.attrs.id) : null }, listItem(li, ctx))));
  }
  if (name === 'dl') {
    const kids = [];
    for (const c of node.children) {
      if (typeof c === 'string') continue;
      const n = local(c.name);
      if (n === 'dt') kids.push(el('dt', {}, trimRun(htmlInlines(c.children, ctx))));
      else if (n === 'dd') kids.push(el('dd', {}, htmlBlocks(c.children, ctx)));
    }
    return kids.length ? el('dl', { id }, kids) : null;
  }
  if (name === 'table') {
    const rows = [];
    const collect = (n) => {
      for (const c of n.children) {
        if (typeof c === 'string') continue;
        const cn = local(c.name);
        if (cn === 'tr') rows.push(c);
        else if (cn === 'thead' || cn === 'tbody' || cn === 'tfoot') collect(c);
      }
    };
    collect(node);
    if (!rows.length) return null;
    return el('table', { id }, [
      el(
        'tbody',
        {},
        rows.map((tr) =>
          el(
            'tr',
            {},
            tr.children
              .filter((c) => typeof c !== 'string' && (local(c.name) === 'td' || local(c.name) === 'th'))
              .map((cell) => el(local(cell.name), { colspan: cell.attrs.colspan, rowspan: cell.attrs.rowspan }, listItem(cell, ctx))),
          ),
        ),
      ),
    ]);
  }
  if (name === 'figure') {
    const caption = node.children.find((c) => typeof c !== 'string' && local(c.name) === 'figcaption');
    const body = htmlBlocks(node.children.filter((c) => c !== caption), ctx).flatMap((b) => (b.tag === 'p' ? b.children : [b]));
    const kids = [...body, caption ? el('figcaption', {}, trimRun(htmlInlines(caption.children, ctx))) : null].filter(Boolean);
    return hasText(kids) ? el('figure', { id }, kids) : null;
  }
  return undefined;
}

/** A list item or table cell: plain inline text when that is all it has, blocks otherwise. */
function listItem(node, ctx) {
  const blocks = htmlBlocks(node.children, ctx);
  return blocks.length === 1 && blocks[0].tag === 'p' && !blocks[0].attrs.id ? blocks[0].children : blocks;
}

function htmlInlines(nodes, ctx) {
  return nodes.flatMap((n) => (typeof n === 'string' ? [n] : htmlInline(n, ctx)));
}

function htmlInline(node, ctx) {
  const name = local(node.name);
  if (DROP.has(name)) return [];
  const id = node.attrs.id ? ctx.id(node.attrs.id) : null;
  const wrap = (kids) => (id ? [el('span', { id }, kids)] : kids);
  if (name === 'br') return [el('br')];
  if (name === 'img' || name === 'image') {
    const ref = ctx.image(node.attrs.src ?? node.attrs['xlink:href'] ?? node.attrs.href);
    if (ref) return [el('img', { ref, alt: node.attrs.alt ?? '' })];
    return node.attrs.alt ? [node.attrs.alt] : [];
  }
  const kids = htmlInlines(node.children, ctx);
  if (name === 'a') {
    const href = node.attrs.href ? ctx.link(node.attrs.href) : null;
    return href ? [el('a', { href, id }, kids)] : wrap(kids);
  }
  if (INLINE[name]) return [el(INLINE[name], { id }, kids)];
  // a block inside running text (bad HTML, or a <p> in a <span>): keep its words apart
  if (BLOCKS.has(name) || CONTAINERS.has(name) || name === 'li') return [' ', ...wrap(kids), ' '];
  return wrap(kids);
}

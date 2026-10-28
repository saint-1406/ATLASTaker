// Which kind of document a file is, and how each kind (except PDF, which pdf.js draws page by page)
// becomes a book: { format, title, author, cover, blocks, resources, toc }.

import { Lexer } from 'marked';
import { isZip, joinPath, openZip } from './zip.js';
import { attr, children, find, findAll, parseXml, textOf } from './xml.js';
import { decodeText, el, htmlBlocks, plain, safeHref } from './model.js';
import { fb2Book } from './fb2.js';
import { docxBook, imageType } from './docx.js';

export const FORMATS = ['pdf', 'epub', 'fb2', 'docx', 'md', 'txt', 'html'];

const extOf = (name) => {
  const lower = String(name ?? '').toLowerCase();
  if (lower.endsWith('.fb2.zip')) return 'fb2.zip';
  return lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
};

export const baseName = (name) => String(name ?? '').replace(/\.fb2\.zip$/i, '').replace(/\.[^./\\]{1,8}$/, '').trim();

/**
 * The format of a file, from its first bytes and its name: one of FORMATS, or "unknown:<what>" for
 * a kind ATLAS knows but cannot read (an old .doc, .rtf, .odt).
 */
export function detectFormat(name, bytes) {
  const ext = extOf(name);
  const head = String.fromCharCode(...bytes.subarray(0, 8));
  if (head.startsWith('%PDF')) return 'pdf';
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'unknown:doc';
  if (head.startsWith('{\\rtf')) return 'unknown:rtf';
  if (isZip(bytes)) {
    let zip;
    try {
      zip = openZip(bytes);
    } catch {
      return 'unknown:zip';
    }
    if (zip.has('META-INF/container.xml')) return 'epub';
    if (zip.has('word/document.xml')) return 'docx';
    if (zip.names.some((n) => n.toLowerCase().endsWith('.fb2'))) return 'fb2';
    if (zip.has('content.xml')) return 'unknown:odt';
    return 'unknown:zip';
  }
  const start = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  if (/<FictionBook\b/i.test(start) || ext === 'fb2') return 'fb2';
  if (['md', 'markdown', 'mdown', 'mkd'].includes(ext)) return 'md';
  if (['html', 'htm', 'xhtml'].includes(ext) || /^\s*(<\?xml[^>]*>\s*)?<(!doctype html|html)\b/i.test(start.replace(/^ï»¿/, ''))) return 'html';
  if (['txt', 'text', 'log', ''].includes(ext) || !bytes.subarray(0, 4096).includes(0)) return 'txt';
  return `unknown:${ext}`;
}

/** Reads a non-PDF file into a book. */
export async function loadBook(name, bytes, format = detectFormat(name, bytes)) {
  let book;
  if (format === 'fb2') {
    const data = isZip(bytes) ? await fb2FromZip(bytes) : bytes;
    book = fb2Book(decodeText(data));
  } else if (format === 'epub') book = await epubBook(openZip(bytes));
  else if (format === 'docx') book = await docxBook(openZip(bytes));
  else if (format === 'md') book = markdownBook(decodeText(bytes));
  else if (format === 'html') book = htmlBook(decodeText(bytes));
  else if (format === 'txt') book = textBook(decodeText(bytes));
  else throw Object.assign(new Error(`cannot read ${format}`), { format });
  return finish({ ...book, format }, name);
}

async function fb2FromZip(bytes) {
  const zip = openZip(bytes);
  return zip.read(zip.names.find((n) => n.toLowerCase().endsWith('.fb2')));
}

/** Every heading gets an anchor and the table of contents is read off them; a missing title comes from the file name or the first heading. */
function finish(book, fileName) {
  const toc = [];
  let n = 0;
  const walk = (nodes) => {
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      const level = /^h([1-6])$/.exec(node.tag)?.[1];
      if (level) {
        node.attrs.id ??= `h-${++n}`;
        const text = plain(node).replace(/\s+/g, ' ').trim();
        if (text) toc.push({ level: Number(level), text: text.slice(0, 160), id: node.attrs.id });
      } else if (['section', 'blockquote', 'figure'].includes(node.tag)) walk(node.children);
    }
  };
  walk(book.blocks);
  const title = (book.title || '').replace(/\s+/g, ' ').trim() || baseName(fileName) || toc[0]?.text || '';
  return { ...book, title: title.slice(0, 300), author: (book.author || '').replace(/\s+/g, ' ').trim().slice(0, 300), toc };
}

// ---------- EPUB ----------

async function epubBook(zip) {
  const container = parseXml(await zip.text('META-INF/container.xml'));
  const opfPath = attr(find(container, 'rootfile'), 'full-path');
  if (!opfPath || !zip.has(opfPath)) throw new Error('epub: no package document');
  const opf = parseXml(await zip.text(opfPath));
  const meta = find(opf, 'metadata');
  const manifest = new Map();
  for (const item of children(find(opf, 'manifest'), 'item')) {
    manifest.set(item.attrs.id, { path: joinPath(opfPath, item.attrs.href), type: item.attrs['media-type'] ?? '', props: item.attrs.properties ?? '' });
  }
  const spine = children(find(opf, 'spine'), 'itemref')
    .map((ref) => manifest.get(ref.attrs.idref))
    .filter((item) => item && /html|xml/.test(item.type) && zip.has(item.path));
  const chapterOf = new Map(spine.map((item, i) => [item.path, i]));
  const wanted = new Set();

  const blocks = [];
  for (const [i, item] of spine.entries()) {
    const doc = parseXml(decodeText(await zip.read(item.path)));
    const ctx = {
      id: (raw) => `c${i}-${raw}`,
      image(src) {
        if (!src || /^[a-z]+:/i.test(src)) return null;
        const path = joinPath(item.path, src);
        if (!imageType(path) || !zip.has(path)) return null;
        wanted.add(path);
        return path;
      },
      link(href) {
        if (/^[a-z]+:/i.test(href)) return safeHref(href);
        const [file, fragment] = href.split('#');
        const target = file ? chapterOf.get(joinPath(item.path, file)) : i;
        if (target === undefined) return null;
        return fragment ? `#c${target}-${fragment}` : `#c${target}`;
      },
    };
    blocks.push(el('section', { id: `c${i}` }, htmlBlocks((find(doc, 'body') ?? doc).children, ctx)));
  }

  const coverItem =
    [...manifest.values()].find((item) => item.props.split(/\s+/).includes('cover-image')) ??
    manifest.get(findAll(meta, ['meta']).find((m) => m.attrs.name === 'cover')?.attrs.content);
  const cover = coverItem && imageType(coverItem.path) && zip.has(coverItem.path) ? coverItem.path : null;
  if (cover) wanted.add(cover);
  const resources = new Map();
  for (const path of wanted) {
    try {
      resources.set(path, { type: imageType(path), bytes: await zip.read(path) });
    } catch {
      // a missing picture: the text still reads
    }
  }
  return {
    title: textOf(find(meta, 'title')),
    author: findAll(meta, ['creator']).map((c) => textOf(c).trim()).filter(Boolean).join(', '),
    lang: textOf(find(meta, 'language')).trim(),
    cover: resources.has(cover) ? cover : null,
    blocks,
    resources,
  };
}

// ---------- plain text, HTML, Markdown ----------

const noPictures = { image: () => null, link: safeHref, id: (raw) => `x-${raw}` };

function htmlBook(text) {
  const doc = parseXml(text);
  return { title: textOf(find(doc, 'title')), author: '', cover: null, blocks: htmlBlocks((find(doc, 'body') ?? doc).children, noPictures), resources: new Map() };
}

/**
 * Paragraphs are separated by blank lines; a text without any has one paragraph per line. Lines
 * inside a paragraph were wrapped by hand and are joined back, unless they look like verse (short).
 */
function textBook(text) {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const chunks = /\n[ \t]*\n/.test(clean) ? clean.split(/\n[ \t]*\n+/) : clean.split('\n');
  const blocks = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const verse = lines.length > 1 && lines.every((l) => l.length < 48);
    blocks.push(el('p', {}, verse ? lines.flatMap((l, i) => (i ? [el('br'), l] : [l])) : [lines.join(' ')]));
  }
  return { title: '', author: '', cover: null, blocks, resources: new Map() };
}

function markdownBook(text) {
  const tokens = new Lexer({ gfm: true }).lex(text.replace(/\r\n?/g, '\n'));
  return { title: '', author: '', cover: null, blocks: mdBlocks(tokens), resources: new Map() };
}

function mdBlocks(tokens = []) {
  const out = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case 'heading':
        out.push(el(`h${tok.depth}`, {}, mdInline(tok.tokens)));
        break;
      case 'paragraph':
        out.push(el('p', {}, mdInline(tok.tokens)));
        break;
      case 'text':
        out.push(el('p', {}, tok.tokens ? mdInline(tok.tokens) : [decodeHtml(tok.text)]));
        break;
      case 'code':
        out.push(el('pre', {}, [tok.text]));
        break;
      case 'blockquote':
        out.push(el('blockquote', {}, mdBlocks(tok.tokens)));
        break;
      case 'hr':
        out.push(el('hr'));
        break;
      case 'list':
        out.push(
          el(
            tok.ordered ? 'ol' : 'ul',
            {},
            tok.items.map((item) => {
              const inner = mdBlocks(item.tokens.filter((t) => t.type !== 'checkbox'));
              const kids = inner.length === 1 && inner[0].tag === 'p' ? inner[0].children : inner;
              return el('li', { class: item.task ? 'task' : null }, item.task ? [item.checked ? '☑ ' : '☐ ', ...kids] : kids);
            }),
          ),
        );
        break;
      case 'table':
        out.push(
          el('table', {}, [
            el('tbody', {}, [
              el('tr', {}, tok.header.map((cell) => el('th', {}, mdInline(cell.tokens)))),
              ...tok.rows.map((row) => el('tr', {}, row.map((cell) => el('td', {}, mdInline(cell.tokens))))),
            ]),
          ]),
        );
        break;
      case 'html':
        out.push(...htmlBlocks(parseXml(tok.raw).children, noPictures));
        break;
      default:
      // space, def: nothing to show
    }
  }
  return out;
}

function mdInline(tokens = []) {
  const out = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text':
        out.push(...(tok.tokens ? mdInline(tok.tokens) : [decodeHtml(tok.text)]));
        break;
      case 'escape':
        out.push(decodeHtml(tok.text));
        break;
      case 'strong':
        out.push(el('strong', {}, mdInline(tok.tokens)));
        break;
      case 'em':
        out.push(el('em', {}, mdInline(tok.tokens)));
        break;
      case 'del':
        out.push(el('s', {}, mdInline(tok.tokens)));
        break;
      case 'codespan':
        out.push(el('code', {}, [decodeHtml(tok.text)]));
        break;
      case 'br':
        out.push(el('br'));
        break;
      case 'link': {
        const href = safeHref(tok.href);
        const kids = mdInline(tok.tokens);
        out.push(...(href ? [el('a', { href }, kids)] : kids));
        break;
      }
      case 'image':
        // a Markdown file alone has no pictures to show: its words stand in
        if (tok.text) out.push(el('em', {}, [`[${tok.text}]`]));
        break;
      case 'html':
        out.push(...htmlBlocks(parseXml(tok.raw).children, noPictures).flatMap((b) => b.children));
        break;
      default:
        if (tok.raw) out.push(tok.raw);
    }
  }
  return out;
}

// marked keeps &amp; and friends in some tokens' text
const decodeHtml = (text) => (text.includes('&') ? textOf(parseXml(text)) : text);

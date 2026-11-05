// A note in other forms: plain text (no marks), a web page (HTML) and, through the printer, a PDF.
// The page is built from the same Markdown tree the editor reads (lezer, with tables, tasks and
// strikethrough), so what is bold there is bold here; pictures go into the page itself.

import { markdownLanguage } from '@codemirror/lang-markdown';
import { outerAccordions } from './accordion.js';
import { parseTableHtml, renderSafeHtml } from './rich/html.js';
import { decodeEntities } from './entities.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
// links that may stay links in the page: the web and mail; anything else is shown as text
const safeHref = (url) => (/^(https?:|mailto:)/i.test(url.trim()) ? url.trim() : '');
const MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'HeaderMark', 'QuoteMark', 'ListMark', 'LinkMark', 'TaskMarker', 'LinkTitle', 'URL', 'CodeInfo']);

/** The note's body as HTML. images: Map of "assets/<name>" → a data: URL to show in its place. */
export function toHtml(md, { images = new Map(), expandDetails = false } = {}) {
  const accordions = outerAccordions(md);
  if (accordions.length) {
    let from = 0;
    let out = '';
    for (const part of accordions) {
      out += toHtml(md.slice(from, part.from), { images, expandDetails });
      const title = toHtml(md.slice(part.titleFrom, part.titleTo), { images, expandDetails }).replace(/^<p>|<\/p>\n?$/g, '').trim();
      out += `<details${expandDetails || part.open ? ' open' : ''}>\n<summary>${title}</summary>\n`;
      out += toHtml(md.slice(part.bodyFrom, part.closeFrom), { images, expandDetails });
      out += '</details>\n';
      from = part.to;
    }
    return out + toHtml(md.slice(from), { images, expandDetails });
  }
  const tree = markdownLanguage.parser.parse(md);
  const slice = (from, to) => md.slice(from, to);

  /** The inline content of a node between `from` and `to`: its text and its marked children. */
  function inline(node, from = node.from, to = node.to) {
    let out = '';
    let pos = from;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.to <= from || c.from >= to) continue;
      if (c.from > pos) out += esc(slice(pos, c.from));
      if (c.name === 'HTMLTag' && slice(c.from, c.to).toLowerCase() === '<code>') {
        let end = c.nextSibling;
        while (end && !(end.name === 'HTMLTag' && slice(end.from, end.to).toLowerCase() === '</code>')) end = end.nextSibling;
        if (end && end.to <= to) { out += `<code>${esc(decodeEntities(slice(c.to, end.from)))}</code>`; pos = end.to; c = end; continue; }
      }
      out += inlineNode(c);
      pos = c.to;
    }
    if (to > pos) out += esc(slice(pos, to));
    return out;
  }

  function inlineNode(n) {
    if (MARKS.has(n.name)) return '';
    switch (n.name) {
      case 'Emphasis':
        return `<em>${inline(n)}</em>`;
      case 'StrongEmphasis':
        return `<strong>${inline(n)}</strong>`;
      case 'Strikethrough':
        return `<s>${inline(n)}</s>`;
      case 'InlineCode':
        return `<code>${esc(slice(n.from, n.to).replace(/^`+\s?|\s?`+$/g, ''))}</code>`;
      case 'Link': {
        const marks = n.getChildren('LinkMark');
        const url = n.getChild('URL');
        const words = inline(n, marks[0]?.to ?? n.from, marks[1]?.from ?? n.to);
        const href = url ? safeHref(slice(url.from, url.to)) : '';
        return href ? `<a href="${esc(href)}">${words}</a>` : words;
      }
      case 'Image': {
        const marks = n.getChildren('LinkMark');
        const url = n.getChild('URL');
        const alt = slice(marks[0]?.to ?? n.from, marks[1]?.from ?? n.to);
        const src = url ? slice(url.from, url.to) : '';
        const data = images.get(src) ?? safeHref(src);
        return data ? `<img src="${esc(data)}" alt="${esc(alt)}">` : esc(alt);
      }
      case 'Autolink': {
        const url = n.getChild('URL');
        const href = url ? safeHref(slice(url.from, url.to)) : '';
        return href ? `<a href="${esc(href)}">${esc(href)}</a>` : esc(slice(n.from, n.to));
      }
      case 'HTMLTag': {
        const tag = slice(n.from, n.to).toLowerCase().replace(/\s+/g, '');
        return /^<\/?(?:u|strong|em|s|del|b|i)>$/.test(tag) || ['<br>', '<br/>'].includes(tag) ? tag : esc(slice(n.from, n.to));
      }
      case 'Escape':
        return esc(slice(n.from + 1, n.to));
      case 'Entity':
        return esc(decodeEntities(slice(n.from, n.to)));
      case 'HardBreak':
        return '<br>';
      default:
        return inline(n);
    }
  }

  const blocks = (node) => {
    let out = '';
    for (let c = node.firstChild; c; c = c.nextSibling) out += block(c);
    return out;
  };

  function block(n) {
    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(n.name);
    if (heading) return `<h${heading[1]}>${inline(n).trim()}</h${heading[1]}>\n`;
    switch (n.name) {
      case 'Paragraph':
        return `<p>${inline(n).trim().replace(/\n/g, '<br>\n')}</p>\n`;
      case 'BulletList':
        return `<ul>\n${blocks(n)}</ul>\n`;
      case 'OrderedList': {
        const first = n.firstChild?.getChild('ListMark');
        const start = first ? parseInt(slice(first.from, first.to), 10) : 1;
        return `<ol${start > 1 ? ` start="${start}"` : ''}>\n${blocks(n)}</ol>\n`;
      }
      case 'ListItem': {
        let out = '';
        let cls = '';
        for (let c = n.firstChild; c; c = c.nextSibling) {
          if (c.name === 'ListMark') continue;
          if (c.name === 'Task') {
            const marker = c.getChild('TaskMarker');
            const done = Boolean(marker) && /x/i.test(slice(marker.from, marker.to));
            cls = done ? ' class="task done"' : ' class="task"';
            out += `<span class="box">${done ? '☑' : '☐'}</span> ${inline(c).trim()}`;
          } else out += c.name === 'Paragraph' ? inline(c).trim() : block(c);
        }
        return `<li${cls}>${out}</li>\n`;
      }
      case 'Blockquote':
        return `<blockquote>\n${blocks(n)}</blockquote>\n`;
      case 'FencedCode':
      case 'CodeBlock': {
        const code = n.getChildren('CodeText').map((c) => slice(c.from, c.to)).join('\n');
        return `<pre><code>${esc(code)}</code></pre>\n`;
      }
      case 'HorizontalRule':
        return '<hr>\n';
      case 'Table': {
        let rows = '';
        for (let r = n.firstChild; r; r = r.nextSibling) {
          if (r.name !== 'TableHeader' && r.name !== 'TableRow') continue;
          const cell = r.name === 'TableHeader' ? 'th' : 'td';
          rows += `<tr>${r.getChildren('TableCell').map((c) => `<${cell}>${inline(c).trim()}</${cell}>`).join('')}</tr>\n`;
        }
        return `<table>\n${rows}</table>\n`;
      }
      case 'LinkReference':
      case 'CommentBlock':
      case 'ProcessingInstructionBlock':
        return '';
      case 'HTMLBlock':
        if (/^<table\s+data-atlas-table/i.test(slice(n.from, n.to))) {
          const table = parseTableHtml(slice(n.from, n.to));
          if (table) return renderSafeHtml(table) + '\n';
        }
        if (/^<p><\/p>\s*$/.test(slice(n.from, n.to))) return '<p></p>\n';
        return `<p>${esc(slice(n.from, n.to))}</p>\n`;
      default:
        return n.firstChild ? blocks(n) : '';
    }
  }

  return blocks(tree.topNode);
}

const PAGE_CSS = `
body { max-width: 720px; margin: 32px auto; padding: 0 20px; font: 16px/1.6 Georgia, 'Times New Roman', serif; color: #1d1b17; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.3em 0 .5em; }
h1 { font-size: 1.9em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #c9c2b4; color: #4b463d; }
pre { padding: 10px 12px; background: #f4f1ea; border-radius: 6px; overflow-x: auto; }
code { font: .9em Consolas, 'Courier New', monospace; background: #f4f1ea; padding: 0 .2em; border-radius: 3px; }
pre code { background: none; padding: 0; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; } th, td { border: 1px solid #d8d2c4; padding: 4px 8px; text-align: left; }
li.task { list-style: none; margin-left: -1.2em; } li.task.done { color: #7a7468; text-decoration: line-through; }
hr { border: 0; border-top: 1px solid #d8d2c4; margin: 1.5em 0; }
a { color: #2f5aa8; }
details { border-left: 2px solid #d8d2c4; padding-left: 1em; margin: 1em 0; }
summary { cursor: pointer; font-weight: bold; margin-bottom: .5em; }
@media print { body { margin: 0; max-width: none; } a { color: inherit; } }
`;

/** A whole page around the body: its title, and type for reading and for print (PDF). */
export function htmlPage(title, body, lang = 'ru') {
  return `<!doctype html>\n<html lang="${esc(lang)}">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${esc(title)}</title>\n<style>${PAGE_CSS}</style>\n</head>\n<body>\n${body}</body>\n</html>\n`;
}

/** The note as plain text: no marks, lists with •, tasks with ☐ ☑, links as "words (address)". */
export function toText(md) {
  const accordions = outerAccordions(md);
  if (accordions.length) {
    let from = 0;
    let out = '';
    for (const part of accordions) {
      out += toText(md.slice(from, part.from)) + toText(md.slice(part.titleFrom, part.titleTo)) + '\n';
      out += toText(md.slice(part.bodyFrom, part.closeFrom));
      from = part.to;
    }
    return out + toText(md.slice(from));
  }
  const tables = [];
  markdownLanguage.parser.parse(md).iterate({ enter(node) {
    if (node.name !== 'HTMLBlock') return;
    const raw = md.slice(node.from, node.to);
    if (!/^<table\s+data-atlas-table/i.test(raw)) return;
    const table = parseTableHtml(raw);
    if (table) tables.push({ from: node.from, to: node.to, text: table.textBetween(0, table.content.size, '\n') });
  } });
  if (tables.length) {
    let from = 0, result = '';
    for (const table of tables) { result += toText(md.slice(from, table.from)) + table.text; from = table.to; }
    return result + toText(md.slice(from));
  }
  const out = [];
  let fence = false;
  for (const raw of md.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      out.push(raw);
      continue;
    }
    const codes = [];
    const protectedLine = raw.replace(/<code>(.*?)<\/code>|`([^`]+)`/g, (_, html, code) => { codes.push(html === undefined ? code : decodeEntities(html)); return `\u0000${codes.length - 1}\u0000`; });
    let line = protectedLine
      .replace(/^(\s*)#{1,6}\s+/, '$1')
      .replace(/^(\s*)[-*+]\s\[[xX]\]\s/, '$1☑ ')
      .replace(/^(\s*)[-*+]\s\[ \]\s/, '$1☐ ')
      .replace(/^(\s*)[-*+]\s/, '$1• ')
      .replace(/^(\s*)>\s?/, '$1    ');
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) line = '—————';
    line = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt ? `[${alt}]` : ''))
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, words, url) => (words === url ? url : `${words} (${url})`))
      .replace(/<\/?(?:u|strong|em|s|del|b|i)>/gi, '')
      .replace(/^<p><\/p>$/, '')
      .replace(/(\*\*|__)(?=\S)(.*?\S)\1/g, '$2')
      .replace(/(\*|_)(?=\S)(.*?\S)\1(?![\p{L}\p{N}])/gu, '$2')
      .replace(/~~(?=\S)(.*?\S)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');
    out.push(decodeEntities(line).replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]));
  }
  return out.join('\n');
}

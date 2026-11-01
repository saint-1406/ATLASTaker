// More kinds of documents, each made into a book (model.js) like the others:
//   RTF  — WordPad, old Word exports: groups of control words around the text;
//   ODT  — LibreOffice / OpenOffice Writer: a zip with content.xml;
//   CBZ  — comics: a zip of pictures, one per page, in name order;
//   a single picture (JPEG, PNG, WebP, GIF) — a scan or a photo of a page.

import { attr, child, children, elements, find, findAll, local, parseXml, textOf } from './xml.js';
import { el, safeHref } from './model.js';
import { imageType } from './docx.js';

const hasText = (nodes) => nodes.some((n) => (typeof n === 'string' ? n.trim() : n.tag === 'img' || n.tag === 'br' || hasText(n.children)));

// ---------- pictures ----------

/** The picture type of some bytes, by their first bytes; null if they are not a picture. */
export function pictureType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

export function imageBook(bytes) {
  const type = pictureType(bytes) ?? 'image/png';
  return { title: '', author: '', cover: 'page', blocks: [el('figure', {}, [el('img', { ref: 'page', alt: '' })])], resources: new Map([['page', { type, bytes }]]) };
}

/** Pages of a comic in reading order: "page 2" before "page 10". */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

export const comicPages = (zip) => zip.names.filter((n) => !n.endsWith('/') && !/(^|\/)(__macosx|\.)/i.test(n) && imageType(n) && imageType(n) !== 'image/svg+xml').sort(byName);

export async function comicBook(zip) {
  const pages = comicPages(zip);
  if (!pages.length) throw new Error('cbz: no pictures');
  const resources = new Map();
  for (const path of pages) resources.set(path, { type: imageType(path), bytes: await zip.read(path) });
  // ComicInfo.xml, when there is one, has the title and the writer
  const info = zip.has('ComicInfo.xml') ? parseXml(await zip.text('ComicInfo.xml')) : null;
  const series = textOf(find(info, 'series')).trim();
  const number = textOf(find(info, 'number')).trim();
  const title = textOf(find(info, 'title')).trim() || [series, number && `#${number}`].filter(Boolean).join(' ');
  return {
    title,
    author: textOf(find(info, 'writer')).trim(),
    cover: pages[0],
    blocks: pages.map((path, i) => el('figure', { id: `page-${i + 1}` }, [el('img', { ref: path, alt: '' })])),
    resources,
  };
}

// ---------- ODT ----------

export async function odtBook(zip) {
  const content = parseXml(await zip.text('content.xml'));
  const styles = zip.has('styles.xml') ? parseXml(await zip.text('styles.xml')) : null;

  // what each named style does: bold / italic / underline / strike, and headings by their outline level
  const looks = new Map();
  const headingStyle = new Map();
  for (const style of [...findAll(styles, ['style']), ...findAll(content, ['style'])]) {
    const name = attr(style, 'name');
    const props = child(style, 'text-properties');
    if (props) {
      looks.set(name, {
        strong: /^(bold|[6-9]00)$/.test(attr(props, 'font-weight') ?? ''),
        em: (attr(props, 'font-style') ?? '') === 'italic',
        u: (attr(props, 'text-underline-style') ?? 'none') !== 'none',
        s: (attr(props, 'text-line-through-style') ?? 'none') !== 'none',
      });
    }
    const outline = attr(style, 'default-outline-level');
    if (outline) headingStyle.set(name, Number(outline));
    const parent = attr(style, 'parent-style-name');
    if (parent && !looks.has(name) && looks.has(parent)) looks.set(name, looks.get(parent));
  }

  const pictures = new Set();
  const inline = (nodes) => {
    const out = [];
    for (const node of nodes) {
      if (typeof node === 'string') {
        out.push(node.replace(/\s+/g, ' '));
        continue;
      }
      const name = local(node.name);
      if (name === 's') out.push(' '.repeat(Math.min(50, Number(attr(node, 'c')) || 1)));
      else if (name === 'tab') out.push('\t');
      else if (name === 'line-break') out.push(el('br'));
      else if (name === 'a') {
        const href = safeHref(attr(node, 'href'));
        out.push(href ? el('a', { href }, inline(node.children)) : el('span', {}, inline(node.children)));
      } else if (name === 'span') {
        let kids = inline(node.children);
        const look = looks.get(attr(node, 'style-name'));
        if (look?.s) kids = [el('s', {}, kids)];
        if (look?.u) kids = [el('u', {}, kids)];
        if (look?.em) kids = [el('em', {}, kids)];
        if (look?.strong) kids = [el('strong', {}, kids)];
        out.push(...kids);
      } else if (name === 'note') {
        const citation = textOf(find(node, 'note-citation')).trim();
        const body = textOf(find(node, 'note-body')).replace(/\s+/g, ' ').trim();
        if (body) out.push(el('sup', {}, [citation || '*']), ` [${body}] `);
      } else if (name === 'frame') {
        const image = find(node, 'image');
        const href = attr(image, 'href');
        if (href && zip.has(href) && imageType(href)) {
          pictures.add(href);
          out.push(el('img', { ref: href, alt: textOf(find(node, 'title')).trim() }));
        }
      } else if (!['annotation', 'bookmark', 'bookmark-start', 'bookmark-end', 'soft-page-break', 'sequence-decls', 'tracked-changes'].includes(name)) {
        out.push(...inline(node.children));
      }
    }
    return out;
  };
  const trimmed = (kids) => {
    const out = [...kids];
    if (typeof out[0] === 'string') out[0] = out[0].trimStart();
    if (typeof out[out.length - 1] === 'string') out[out.length - 1] = out[out.length - 1].trimEnd();
    return out.filter((k) => k !== '');
  };

  const blocks = (nodes) => {
    const out = [];
    for (const node of elements({ children: nodes })) {
      const name = local(node.name);
      if (name === 'p' || name === 'h') {
        const kids = trimmed(inline(node.children));
        if (!hasText(kids)) continue;
        const level = name === 'h' ? Number(attr(node, 'outline-level')) || 1 : headingStyle.get(attr(node, 'style-name'));
        out.push(level ? el(`h${Math.min(6, Math.max(1, level))}`, {}, kids) : el('p', {}, kids));
      } else if (name === 'list') {
        const items = children(node, 'list-item').map((item) => {
          const inner = blocks(item.children);
          return el('li', {}, inner.length === 1 && inner[0].tag === 'p' ? inner[0].children : inner);
        });
        if (items.length) out.push(el('ul', {}, items));
      } else if (name === 'table') {
        const rows = findAll(node, ['table-row']).map((row) =>
          el(
            'tr',
            {},
            children(row, 'table-cell').map((cell) => {
              const inner = blocks(cell.children);
              return el('td', { colspan: attr(cell, 'number-columns-spanned') }, inner.length === 1 && inner[0].tag === 'p' ? inner[0].children : inner);
            }),
          ),
        );
        if (rows.length) out.push(el('table', {}, [el('tbody', {}, rows)]));
      } else if (name === 'section' || name === 'text' || name === 'body' || name === 'index-body' || name === 'table-of-content') {
        out.push(...blocks(node.children));
      }
    }
    return out;
  };

  const body = find(content, 'text');
  const book = blocks(body ? body.children : []);
  const resources = new Map();
  for (const path of pictures) {
    try {
      resources.set(path, { type: imageType(path), bytes: await zip.read(path) });
    } catch {
      // a missing picture: the text still reads
    }
  }
  const meta = zip.has('meta.xml') ? parseXml(await zip.text('meta.xml')) : null;
  return { title: textOf(find(meta, 'title')).trim(), author: textOf(find(meta, 'initial-creator', 'creator')).trim(), cover: null, blocks: book, resources };
}

// ---------- RTF ----------

// groups whose text is not part of the document
const SKIP = new Set([
  'fonttbl', 'colortbl', 'listtable', 'listoverridetable', 'revtbl', 'rsidtbl', 'generator', 'pict', 'object',
  'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'xmlnstbl', 'themedata',
  'colorschememapping', 'latentstyles', 'datastore', 'filetbl', 'pgdsctbl', 'mmathPr', 'fldinst', 'bkmkstart', 'bkmkend',
]);
const CODEPAGES = { 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1257: 'windows-1257', 866: 'ibm866', 65001: 'utf-8' };
const FONT_CHARSETS = { 204: 'windows-1251', 238: 'windows-1250', 161: 'windows-1253', 162: 'windows-1254', 186: 'windows-1257', 0: null };

export function rtfBook(bytes) {
  const src = new TextDecoder('latin1').decode(bytes);
  let codepage = 'windows-1252';
  const fontCodepage = new Map(); // \fN → its charset's code page
  const blocks = [];
  const meta = { title: '', author: '' };

  // the state of a group: what it styles, whether its text counts, and where that text goes
  let state = { b: false, i: false, u: false, strike: false, skip: false, uc: 1, font: null, into: null, level: 0 };
  const stack = [];
  let para = []; // runs of the open paragraph: { text, b, i, u, strike } | { br: true }
  let level = 0; // \outlinelevelN of the open paragraph (0: none)
  let paraStyle = 0; // \sN of the open paragraph
  const styleNames = new Map(); // style number → its name, from the style sheet
  const styleLevels = new Map(); // style number → its outline level
  const headingOf = (n) => {
    if (styleLevels.has(n)) return styleLevels.get(n);
    const name = styleNames.get(n) ?? '';
    const m = /(?:heading|заголовок)\s*(\d)/i.exec(name);
    return m ? Number(m[1]) : /^\s*title\s*;?$/i.test(name) ? 1 : 0;
  };
  let pendingBytes = [];

  const decoder = (name) => {
    try {
      return new TextDecoder(name);
    } catch {
      return new TextDecoder('windows-1252');
    }
  };
  function flushBytes() {
    if (!pendingBytes.length) return;
    const page = (state.font != null && fontCodepage.get(state.font)) || codepage;
    put(decoder(page).decode(new Uint8Array(pendingBytes)));
    pendingBytes = [];
  }
  function put(text) {
    if (state.inStyles && state.styleNum != null && text) {
      styleNames.set(state.styleNum, (styleNames.get(state.styleNum) ?? '') + text);
      return;
    }
    if (state.skip || !text) return;
    if (state.into) {
      meta[state.into] += text;
      return;
    }
    const last = para[para.length - 1];
    if (last && !last.br && last.b === state.b && last.i === state.i && last.u === state.u && last.strike === state.strike) last.text += text;
    else para.push({ text, b: state.b, i: state.i, u: state.u, strike: state.strike });
  }
  function endParagraph() {
    flushBytes();
    const kids = para.map((run) => {
      if (run.br) return el('br');
      let node = run.text;
      if (run.strike) node = el('s', {}, [node]);
      if (run.u) node = el('u', {}, [node]);
      if (run.i) node = el('em', {}, [node]);
      if (run.b) node = el('strong', {}, [node]);
      return node;
    });
    const heading = level || headingOf(paraStyle);
    if (hasText(kids)) blocks.push(heading ? el(`h${Math.min(6, heading)}`, {}, kids) : el('p', {}, kids));
    para = [];
    level = 0;
  }

  let skipChars = 0; // characters to drop after \uN
  let i = 0;
  let describingFont = null; // in the font table: the font being described
  while (i < src.length) {
    const c = src[i];
    if (c === '{') {
      flushBytes();
      stack.push({ ...state });
      i++;
      // {\*\destination …}: a part this reader does not know is skipped whole
      if (src.startsWith('\\*', i)) state.skip = true;
      continue;
    }
    if (c === '}') {
      flushBytes();
      state = stack.pop() ?? state;
      i++;
      continue;
    }
    if (c === '\\') {
      const next = src[i + 1];
      if (next === "'") {
        const code = parseInt(src.substr(i + 2, 2), 16);
        i += 4;
        if (skipChars > 0) {
          skipChars--;
          continue;
        }
        if (Number.isFinite(code)) pendingBytes.push(code);
        continue;
      }
      if (next === '\\' || next === '{' || next === '}') {
        flushBytes();
        put(next);
        i += 2;
        continue;
      }
      if (next === '~') {
        flushBytes();
        put(' ');
        i += 2;
        continue;
      }
      if (next === '-' || next === '_') {
        if (next === '_') put('-');
        i += 2;
        continue;
      }
      if (next === '\n' || next === '\r') {
        endParagraph();
        i += 2;
        continue;
      }
      const m = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(src.slice(i + 1, i + 46));
      if (!m) {
        i += 2;
        continue;
      }
      i += 1 + m[0].length;
      const word = m[1];
      const n = m[2] === undefined ? null : Number(m[2]);
      if (word !== 'u') flushBytes();
      switch (word) {
        case 'ansicpg':
          codepage = CODEPAGES[n] ?? codepage;
          break;
        case 'f':
          if (state.inFonts) describingFont = n;
          else state.font = n;
          break;
        case 'fcharset':
          if (state.inFonts && describingFont != null && FONT_CHARSETS[n]) fontCodepage.set(describingFont, FONT_CHARSETS[n]);
          break;
        case 'par':
        case 'sect':
        case 'page':
          endParagraph();
          break;
        case 'line':
          para.push({ br: true });
          break;
        case 'tab':
          put('\t');
          break;
        case 'cell':
          put(' │ ');
          break;
        case 'row':
          endParagraph();
          break;
        case 'emdash':
          put('—');
          break;
        case 'endash':
          put('–');
          break;
        case 'bullet':
          put('•');
          break;
        case 'lquote':
          put('‘');
          break;
        case 'rquote':
          put('’');
          break;
        case 'ldblquote':
          put('“');
          break;
        case 'rdblquote':
          put('”');
          break;
        case 'b':
          state.b = n !== 0;
          break;
        case 'i':
          state.i = n !== 0;
          break;
        case 'ul':
          state.u = n !== 0;
          break;
        case 'ulnone':
          state.u = false;
          break;
        case 'strike':
          state.strike = n !== 0;
          break;
        case 'plain':
          Object.assign(state, { b: false, i: false, u: false, strike: false });
          break;
        case 'pard':
          level = 0;
          paraStyle = 0;
          break;
        case 's':
          if (state.inStyles) state.styleNum = n;
          else paraStyle = n ?? 0;
          break;
        case 'outlinelevel':
          if (state.inStyles) {
            if (state.styleNum != null && n < 9) styleLevels.set(state.styleNum, (n ?? 0) + 1);
          } else level = n < 9 ? (n ?? 0) + 1 : 0;
          break;
        case 'uc':
          state.uc = n ?? 1;
          break;
        case 'u': {
          flushBytes();
          put(String.fromCharCode(n < 0 ? n + 65536 : n));
          skipChars = state.uc;
          break;
        }
        case 'title':
          state.into = 'title';
          break;
        case 'author':
          state.into = 'author';
          break;
        case 'info':
          break;
        default:
          if (word === 'stylesheet') {
            state.inStyles = true;
            state.skip = true;
          } else if (word === 'fonttbl') {
            state.inFonts = true;
            state.skip = true;
          } else if (SKIP.has(word)) state.skip = true;
          else if (['subject', 'operator', 'keywords', 'comment', 'doccomm', 'company', 'manager', 'category', 'hlinkbase', 'creatim', 'revtim', 'printim', 'buptim'].includes(word)) state.skip = true;
      }
      continue;
    }
    if (c === '\r' || c === '\n') {
      i++;
      continue;
    }
    // plain text up to the next special character
    let j = i;
    while (j < src.length && !'{}\\\r\n'.includes(src[j])) j++;
    let text = src.slice(i, j);
    i = j;
    if (skipChars > 0) {
      const drop = Math.min(skipChars, text.length);
      text = text.slice(drop);
      skipChars -= drop;
    }
    for (const ch of text) pendingBytes.push(ch.charCodeAt(0) & 0xff);
  }
  endParagraph();
  return { title: meta.title.trim(), author: meta.author.trim(), cover: null, blocks, resources: new Map() };
}

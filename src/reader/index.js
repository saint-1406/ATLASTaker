// The reader, bundled apart from the app (dist/reader.js) and loaded the first time a document is
// added or opened: it carries pdf.js, which the notes alone never need.
//   window.AtlasReader = { FORMATS, detectFormat, inspect(name, bytes), open(host, options) }

import { baseName, detectFormat, FORMATS, loadBook } from './formats.js';
import { renderBook } from './view.js';
import { openPdf, pdfInfo } from './pdf.js';
import { applyEdits, openPages, pdfWithMarks, rebuildPdf } from './pdfedit.js';

/** A small JPEG of a picture, as a data: URL a library card can show. */
async function thumbnail(blob, width = 240) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, width / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.82);
}

function unsupported(format) {
  return Object.assign(new Error(`unsupported ${format}`), { unsupported: format.replace(/^unknown:/, '') || '?' });
}

/** Up to `max` characters of a book's text, from its first blocks. */
function textSample(blocks, max = 6000) {
  let out = '';
  const walk = (node) => {
    if (out.length >= max) return;
    if (typeof node === 'string') out += node;
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node?.children) {
      node.children.forEach(walk);
      out += ' ';
    }
  };
  walk(blocks);
  return out.slice(0, max);
}

/**
 * What a library card needs to know about a file: { format, title, author, cover }. With sample, also
 * { lang, text }: the language the book says it is in, and a piece of its text (Apocrypha).
 */
async function inspect(name, bytes, { sample = false } = {}) {
  const format = detectFormat(name, bytes);
  if (format.startsWith('unknown')) throw unsupported(format);
  if (format === 'pdf') {
    const info = await pdfInfo(bytes, 240, { sample });
    return { format, title: info.title || baseName(name), author: info.author, cover: info.cover, ...(sample ? { lang: info.lang, text: info.text } : {}) };
  }
  const book = await loadBook(name, bytes, format);
  const res = book.cover && book.resources.get(book.cover);
  const cover = res ? await thumbnail(new Blob([res.bytes], { type: res.type ?? '' })).catch(() => null) : null;
  return { format, title: book.title, author: book.author, cover, ...(sample ? { lang: book.lang ?? '', text: textSample(book.blocks) } : {}) };
}

/** Shows the document in `host` (a scrolling element); resolves to its controller. */
async function open(host, { name, bytes, format = detectFormat(name, bytes), ...options }) {
  if (format.startsWith('unknown')) throw unsupported(format);
  if (format === 'pdf') return openPdf(host, bytes, options);
  return renderBook(host, await loadBook(name, bytes, format), options);
}

window.AtlasReader = { FORMATS, detectFormat, inspect, open, openPages, rebuildPdf, pdfWithMarks, applyEdits };

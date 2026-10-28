// The reader, bundled apart from the app (dist/reader.js) and loaded the first time a document is
// added or opened: it carries pdf.js, which the notes alone never need.
//   window.AtlasReader = { FORMATS, detectFormat, inspect(name, bytes), open(host, options) }

import { baseName, detectFormat, FORMATS, loadBook } from './formats.js';
import { renderBook } from './view.js';
import { openPdf, pdfInfo } from './pdf.js';

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

/** What a library card needs to know about a file: { format, title, author, cover }. */
async function inspect(name, bytes) {
  const format = detectFormat(name, bytes);
  if (format.startsWith('unknown')) throw unsupported(format);
  if (format === 'pdf') {
    const info = await pdfInfo(bytes);
    return { format, title: info.title || baseName(name), author: info.author, cover: info.cover };
  }
  const book = await loadBook(name, bytes, format);
  const res = book.cover && book.resources.get(book.cover);
  const cover = res ? await thumbnail(new Blob([res.bytes], { type: res.type ?? '' })).catch(() => null) : null;
  return { format, title: book.title, author: book.author, cover };
}

/** Shows the document in `host` (a scrolling element); resolves to its controller. */
async function open(host, { name, bytes, format = detectFormat(name, bytes), ...options }) {
  if (format.startsWith('unknown')) throw unsupported(format);
  if (format === 'pdf') return openPdf(host, bytes, options);
  return renderBook(host, await loadBook(name, bytes, format), options);
}

window.AtlasReader = { FORMATS, detectFormat, inspect, open };

// Big synthetic documents for the optimization round (docs/performance.md): a ~2400-page FB2, a
// 1200-page PDF and a ~70 MB EPUB of 300 chapters and 30 big pictures, written to out/samples. Add them to the library and time opening, turning, jumping.
//
//   node scripts/perf-samples.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'samples');
fs.mkdirSync(OUT, { recursive: true });

// FB2: 80 chapters of 90 paragraphs
const sentence = 'Вечер был тих, над рекой стоял туман, и где-то далеко лаяли собаки. Князь Андрей смотрел на небо и думал о том, как странно устроена жизнь. ';
const chapters = Array.from({ length: 80 }, (_, c) => {
  const paragraphs = Array.from({ length: 90 }, (_, k) => `<p>Глава ${c + 1}, абзац ${k + 1}. ${sentence.repeat(3)}</p>`).join('');
  return `<section><title><p>Глава ${c + 1}</p></title>${paragraphs}</section>`;
}).join('');
fs.writeFileSync(
  path.join(OUT, 'huge.fb2'),
  `<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>Огромная книга</book-title><author><first-name>Тест</first-name><last-name>Большой</last-name></author></title-info></description><body>${chapters}</body></FictionBook>`,
);

// PDF: 1200 pages of text in a standard font
const objects = [];
const add = (body) => objects.push(body);
const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
const pagesId = add('placeholder');
const kids = [];
for (let p = 1; p <= 1200; p++) {
  const lines = [`BT /F1 22 Tf 72 740 Td (Page ${p}) Tj ET`];
  for (let k = 1; k <= 20; k++) lines.push(`BT /F1 12 Tf 72 ${724 - k * 24} Td (Line ${k} of page ${p}: the quick brown fox jumps over the lazy dog.) Tj ET`);
  const content = lines.join('\n');
  const stream = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${stream} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
}
objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
const info = add('<< /Title (A Huge PDF) >>');
const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
let pdf = '%PDF-1.4\n';
const offsets = objects.map((body, i) => {
  const at = Buffer.byteLength(pdf);
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  return at;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(path.join(OUT, 'huge.pdf'), pdf);

// EPUB: 300 chapter files and 30 pictures of noise (they do not compress, like real photos)
function zipFiles(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data, deflate] of files) {
    const raw = Buffer.from(data);
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(deflate ? 8 : 0, 8);
    head.writeUInt32LE(zlib.crc32(raw), 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    head.copy(dir, 8, 6, 30);
    dir.writeUInt32LE(offset, 42);
    local.push(head, nameBytes, body);
    central.push(dir, nameBytes);
    offset += head.length + nameBytes.length + body.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
function noisePng(width, height, seed) {
  const crcChunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  let x = Math.imul(seed, 2654435761) >>> 0;
  for (let i = 0; i < rows.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    rows[i] = i % (width * 3 + 1) === 0 ? 0 : x >>> 24;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), crcChunk('IHDR', header), crcChunk('IDAT', zlib.deflateSync(rows, { level: 1 })), crcChunk('IEND', Buffer.alloc(0))]);
}
{
  const CHAPTERS = 300;
  const PICTURES = 30;
  const files = [['mimetype', 'application/epub+zip', false]];
  files.push(['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', true]);
  const items = [];
  const spine = [];
  for (let c = 1; c <= CHAPTERS; c++) {
    const picture = c % (CHAPTERS / PICTURES) === 0 ? `<p><img src="img/p${c}.png" alt=""/></p>` : '';
    const paragraphs = Array.from({ length: 40 }, (_, k) => `<p>Chapter ${c}, paragraph ${k + 1}. ${sentence.repeat(2)}</p>`).join('');
    files.push([`OEBPS/ch${c}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${c}</title></head><body><h1>Chapter ${c}</h1>${picture}${paragraphs}</body></html>`, true]);
    items.push(`<item id="ch${c}" href="ch${c}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="ch${c}"/>`);
    if (picture) {
      files.push([`OEBPS/img/p${c}.png`, noisePng(800, 1000, c), false]);
      items.push(`<item id="p${c}" href="img/p${c}.png" media-type="image/png"${c === CHAPTERS / PICTURES ? ' properties="cover-image"' : ''}/>`);
    }
  }
  files.push(['OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Huge EPUB</dc:title><dc:creator>Test</dc:creator><dc:language>en</dc:language></metadata><manifest>${items.join('')}</manifest><spine>${spine.join('')}</spine></package>`, true]);
  fs.writeFileSync(path.join(OUT, 'huge.epub'), zipFiles(files));
}

for (const name of ['huge.fb2', 'huge.pdf', 'huge.epub']) console.log(`${path.join(OUT, name)} — ${(fs.statSync(path.join(OUT, name)).size / 1e6).toFixed(1)} МБ`);

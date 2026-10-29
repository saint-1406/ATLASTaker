// Big synthetic documents for the optimization round (docs/performance.md): a ~2400-page FB2 and a
// 1200-page PDF, written to out/samples. Add them to the library and time opening, turning, jumping.
//
//   node scripts/perf-samples.mjs

import fs from 'node:fs';
import path from 'node:path';
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

for (const name of ['huge.fb2', 'huge.pdf']) console.log(`${path.join(OUT, name)} — ${(fs.statSync(path.join(OUT, name)).size / 1e6).toFixed(1)} МБ`);

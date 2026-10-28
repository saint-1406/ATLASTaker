import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseXml, textOf } from '../src/reader/xml.js';
import { openZip, joinPath } from '../src/reader/zip.js';
import { decodeText, el, plain, safeHref, TAGS } from '../src/reader/model.js';
import { detectFormat, loadBook } from '../src/reader/formats.js';
import { crc32 } from '../src/backup.js';

const utf8 = (s) => new TextEncoder().encode(s);

/** A zip with every file deflated (the way real EPUB and DOCX files are packed). */
function zip(files) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = utf8(name);
    const data = typeof content === 'string' ? utf8(content) : content;
    const packed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    parts.push(header, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const size = directory.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...directory, end]));
}

/** Russian text in Windows-1251, as old .fb2 and .txt files have it. */
function cp1251(text) {
  return Uint8Array.from([...text].map((ch) => {
    const code = ch.codePointAt(0);
    if (code < 0x80) return code;
    if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
    if (ch === 'Ё') return 0xa8;
    if (ch === 'ё') return 0xb8;
    if (ch === '—') return 0x97;
    if (ch === '«') return 0xab;
    if (ch === '»') return 0xbb;
    throw new Error(`no ${ch} in the test table`);
  }));
}

/** Every tag and attribute in a book is one the reader knows. */
function assertSafe(nodes) {
  for (const node of nodes) {
    if (typeof node === 'string') continue;
    assert.ok(TAGS.has(node.tag), `unexpected <${node.tag}>`);
    for (const key of Object.keys(node.attrs)) assert.ok(['id', 'href', 'ref', 'alt', 'colspan', 'rowspan', 'class'].includes(key), `unexpected ${key}`);
    if (node.attrs.href) assert.equal(safeHref(node.attrs.href), node.attrs.href);
    assertSafe(node.children);
  }
}

const find = (nodes, tag) => {
  for (const node of nodes) {
    if (typeof node === 'string') continue;
    if (node.tag === tag) return node;
    const deeper = find(node.children, tag);
    if (deeper) return deeper;
  }
  return null;
};
const findAll = (nodes, tag, out = []) => {
  for (const node of nodes) {
    if (typeof node === 'string') continue;
    if (node.tag === tag) out.push(node);
    findAll(node.children, tag, out);
  }
  return out;
};
const words = (nodes) => nodes.map(plain).join('\n');

test('the parser forgives broken markup and runs nothing', () => {
  const doc = parseXml('<p class=a>One &amp; <b>two<i>three</b> four &nbsp;&#x41;&unknown;<br><script>alert(1)</script></p></div>');
  const p = doc.children[0];
  assert.equal(p.name, 'p');
  assert.equal(p.attrs.class, 'a');
  assert.equal(textOf(p).replace(/ /g, ' '), 'One & twothree four  A&unknown;alert(1)');
  assert.equal(textOf(parseXml('<a><![CDATA[<x>]]></a><!-- <b> -->')), '<x>');
  assert.equal(textOf(parseXml('<title><p>FB2 titles hold paragraphs</p></title>').children[0].children[0]), 'FB2 titles hold paragraphs');
});

test('zip: deflated files come out whole; paths join like a browser joins them', async () => {
  const archive = openZip(zip({ 'a/b.txt': 'привет '.repeat(200), 'c.bin': new Uint8Array([1, 2, 3]) }));
  assert.deepEqual(archive.names, ['a/b.txt', 'c.bin']);
  assert.equal(await archive.text('A/B.TXT'), 'привет '.repeat(200));
  assert.deepEqual([...(await archive.read('c.bin'))], [1, 2, 3]);
  assert.equal(joinPath('OEBPS/text/ch1.xhtml', '../images/a%20b.png#x'), 'OEBPS/images/a b.png');
  assert.equal(joinPath('word/document.xml', 'media/image1.png'), 'word/media/image1.png');
});

test('text: BOM, declared encoding, clean UTF-8, else Windows-1251', () => {
  assert.equal(decodeText(utf8('﻿Привет')), 'Привет');
  assert.equal(decodeText(utf8('Привет')), 'Привет');
  assert.equal(decodeText(cp1251('Ёжик в тумане')), 'Ёжик в тумане');
  assert.equal(decodeText(cp1251('<?xml version="1.0" encoding="windows-1251"?><a>Да</a>')), '<?xml version="1.0" encoding="windows-1251"?><a>Да</a>');
});

test('formats are told apart by their bytes first, then the name', () => {
  assert.equal(detectFormat('x.bin', utf8('%PDF-1.7\n')), 'pdf');
  assert.equal(detectFormat('old.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0])), 'unknown:doc');
  assert.equal(detectFormat('a.rtf', utf8('{\\rtf1\\ansi')), 'unknown:rtf');
  assert.equal(detectFormat('book', utf8('<?xml version="1.0"?><FictionBook xmlns="x">')), 'fb2');
  assert.equal(detectFormat('README.md', utf8('# Hi')), 'md');
  assert.equal(detectFormat('page', utf8('<!DOCTYPE html><html>')), 'html');
  assert.equal(detectFormat('notes.txt', utf8('hello')), 'txt');
  assert.equal(detectFormat('x.epub', zip({ mimetype: 'application/epub+zip', 'META-INF/container.xml': '<container/>' })), 'epub');
  assert.equal(detectFormat('x.docx', zip({ 'word/document.xml': '<w:document/>' })), 'docx');
  assert.equal(detectFormat('x.fb2.zip', zip({ 'book.fb2': '<FictionBook/>' })), 'fb2');
  assert.equal(detectFormat('x.odt', zip({ 'content.xml': '<x/>' })), 'unknown:odt');
});

const FB2 = `<?xml version="1.0" encoding="windows-1251"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
 <description><title-info>
  <author><first-name>Лев</first-name><last-name>Толстой</last-name></author>
  <book-title>Война и мир</book-title>
  <coverpage><image l:href="#cover.jpg"/></coverpage>
 </title-info></description>
 <body>
  <title><p>Война и мир</p><p>Том первый</p></title>
  <epigraph><p>Эпиграф</p><text-author>Автор</text-author></epigraph>
  <section id="ch1"><title><p>Часть первая</p></title>
   <p>— Ну, князь, <emphasis>Генуя</emphasis> и <strong>Лукка</strong><a l:href="#n1" type="note">1</a>.</p>
   <empty-line/>
   <section><title><p>Глава I</p></title><p>Текст главы.</p>
    <poem><stanza><v>Строка один</v><v>Строка два</v></stanza></poem>
   </section>
  </section>
 </body>
 <body name="notes"><section id="n1"><title><p>1</p></title><p>Примечание.</p></section></body>
 <binary id="cover.jpg" content-type="image/jpeg">/9j/4AAQ</binary>
</FictionBook>`;

test('FB2 in Windows-1251: title, author, cover, chapters, notes, verse', async () => {
  const book = await loadBook('tolstoy.fb2', cp1251(FB2));
  assert.equal(book.format, 'fb2');
  assert.equal(book.title, 'Война и мир');
  assert.equal(book.author, 'Лев Толстой');
  assert.equal(book.cover, 'cover.jpg');
  assert.deepEqual([...book.resources.get('cover.jpg').bytes], [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.deepEqual(book.toc.map((h) => [h.level, h.text]), [[1, 'Война и мир Том первый'], [2, 'Часть первая'], [3, 'Глава I'], [2, '1']]);
  const note = find(book.blocks, 'sup');
  assert.equal(note.children[0].attrs.href, '#fb-n1');
  assert.ok(findAll(book.blocks, 'section').some((s) => s.attrs.id === 'fb-n1'), 'the note it points to');
  assert.equal(findAll(book.blocks, 'p').filter((p) => p.attrs.class === 'verse').length, 2);
  assert.match(words(book.blocks), /Генуя/);
  assertSafe(book.blocks);
});

test('FB2 inside a zip opens the same way', async () => {
  const book = await loadBook('tolstoy.fb2.zip', zip({ 'tolstoy.fb2': cp1251(FB2) }));
  assert.equal(book.title, 'Война и мир');
});

test('DOCX: headings from styles, lists, tables, links, pictures, footnotes', async () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="r" xmlns:a="a"';
  const docx = zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': `<w:document ${W}><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Отчёт</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Жирный</w:t></w:r><w:r><w:t xml:space="preserve"> и </w:t></w:r><w:r><w:rPr><w:i/><w:b w:val="0"/></w:rPr><w:t>курсив</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Первый</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Вложенный</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Второй</w:t></w:r></w:p>
      <w:p><w:hyperlink r:id="rLink"><w:r><w:t>сайт</w:t></w:r></w:hyperlink> <w:hyperlink r:id="rBad"><w:r><w:t>плохая</w:t></w:r></w:hyperlink></w:p>
      <w:p><w:r><w:drawing><wp:docPr descr="схема"/><a:blip r:embed="rImg"/></w:drawing></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Ячейка</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p></w:p>
    </w:body></w:document>`,
    'word/styles.xml': `<w:styles ${W}><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
    'word/numbering.xml': `<w:numbering ${W}><w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num></w:numbering>`,
    'word/_rels/document.xml.rels': `<Relationships>
      <Relationship Id="rLink" Target="https://example.com/" TargetMode="External"/>
      <Relationship Id="rBad" Target="javascript:alert(1)" TargetMode="External"/>
      <Relationship Id="rImg" Target="media/image1.png"/></Relationships>`,
    'word/media/image1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    'word/footnotes.xml': `<w:footnotes ${W}><w:footnote w:id="2"><w:p><w:r><w:t>Сноска.</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    'docProps/core.xml': '<cp:coreProperties xmlns:dc="dc"><dc:title>Годовой отчёт</dc:title><dc:creator>Иван</dc:creator></cp:coreProperties>',
  });
  const book = await loadBook('report.docx', docx);
  assert.equal(book.title, 'Годовой отчёт');
  assert.equal(book.author, 'Иван');
  assert.equal(book.blocks[0].tag, 'h1');
  assert.deepEqual(book.toc.map((h) => h.text), ['Отчёт']);
  const p = book.blocks[1];
  assert.equal(p.children[0].tag, 'strong');
  assert.equal(p.children[2].tag, 'em', 'w:b w:val="0" is not bold');
  assert.equal(p.children[3].tag, 'sup');
  const ol = book.blocks[2];
  assert.equal(ol.tag, 'ol');
  assert.equal(ol.children.length, 2);
  assert.equal(find(ol.children[0].children, 'ul')?.children.length, 1, 'the nested item sits in a list of its own');
  assert.deepEqual(findAll(book.blocks, 'a').map((a) => a.attrs.href).filter((h) => !h.startsWith('#')), ['https://example.com/']);
  assert.match(words(book.blocks), /плохая/, 'a link that may not be followed keeps its words');
  const img = find(book.blocks, 'img');
  assert.equal(img.attrs.ref, 'word/media/image1.png');
  assert.equal(img.attrs.alt, 'схема');
  assert.equal(book.resources.get('word/media/image1.png').type, 'image/png');
  assert.equal(find(book.blocks, 'td').attrs.colspan, '2');
  const notes = book.blocks.at(-1);
  assert.equal(notes.attrs.class, 'notes');
  assert.match(words(notes.children), /1\. Сноска\./);
  assert.ok(findAll(notes.children, 'p').some((n) => n.attrs.id === 'docx-footnote-2'));
  assertSafe(book.blocks);
});

test('EPUB: spine order, links between chapters, pictures, cover, no scripts', async () => {
  const epub = zip({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    'OEBPS/content.opf': `<package><metadata><dc:title>Книга</dc:title><dc:creator>Автор Один</dc:creator><meta name="cover" content="cov"/></metadata>
      <manifest><item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="text/one.xhtml" media-type="application/xhtml+xml"/>
      <item id="cov" href="img/cover.jpg" media-type="image/jpeg"/><item id="pic" href="img/p.png" media-type="image/png"/></manifest>
      <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
    'OEBPS/text/one.xhtml': `<html><head><title>x</title><script>alert(1)</script></head><body onload="x()">
      <h1>Глава 1</h1><p>Смотри <a href="two.xhtml#end">дальше</a> и <a href="javascript:alert(1)">это</a>.</p>
      <div><img src="../img/p.png" alt="рисунок"/></div><iframe src="https://evil.example"></iframe></body></html>`,
    'OEBPS/text/two.xhtml': '<html><body><h2>Глава 2</h2><p id="end">Конец &mdash; всё.</p></body></html>',
    'OEBPS/img/cover.jpg': new Uint8Array([0xff, 0xd8]),
    'OEBPS/img/p.png': new Uint8Array([0x89, 0x50]),
  });
  const book = await loadBook('book.epub', epub);
  assert.equal(book.title, 'Книга');
  assert.equal(book.author, 'Автор Один');
  assert.equal(book.cover, 'OEBPS/img/cover.jpg');
  assert.deepEqual(book.toc.map((h) => h.text), ['Глава 1', 'Глава 2']);
  assert.deepEqual(book.blocks.map((s) => s.attrs.id), ['c0', 'c1']);
  const [inside, bad] = findAll(book.blocks, 'a');
  assert.equal(inside.attrs.href, '#c1-end');
  assert.equal(bad, undefined, 'a javascript: link is dropped');
  assert.ok(findAll(book.blocks, 'p').some((p) => p.attrs.id === 'c1-end'));
  assert.equal(find(book.blocks, 'img').attrs.ref, 'OEBPS/img/p.png');
  assert.ok(book.resources.has('OEBPS/img/p.png'));
  assert.doesNotMatch(words(book.blocks), /alert/);
  assert.match(words(book.blocks), /Конец — всё\./);
  assertSafe(book.blocks);
});

test('Markdown: headings, lists, tasks, tables, code; raw HTML is cleaned', async () => {
  const md = [
    '# Заметки',
    '',
    'Текст с **жирным**, *курсивом*, `кодом` и [ссылкой](https://example.com) и [плохой](javascript:alert(1)).',
    '',
    '- [x] сделано',
    '- [ ] нет',
    '',
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '```js',
    'const a = 1 < 2;',
    '```',
    '',
    '<script>alert(1)</script>',
    '',
    '<p onclick="x()">html абзац</p>',
    '',
    '![картинка](pic.png) a &amp; b',
  ].join('\n');
  const book = await loadBook('notes.md', utf8(md));
  assert.equal(book.title, 'notes');
  assert.deepEqual(book.toc.map((h) => h.text), ['Заметки']);
  const p = book.blocks[1];
  assert.deepEqual(p.children.filter((c) => typeof c !== 'string').map((c) => c.tag), ['strong', 'em', 'code', 'a']);
  assert.match(words([p]), /плохой/);
  const tasks = findAll(book.blocks, 'li');
  assert.equal(tasks[0].attrs.class, 'task');
  assert.match(plain(tasks[0]), /^☑ сделано/);
  assert.equal(findAll(book.blocks, 'th').length, 2);
  assert.equal(find(book.blocks, 'pre').children[0], 'const a = 1 < 2;');
  assert.doesNotMatch(words(book.blocks), /alert/);
  assert.match(words(book.blocks), /html абзац/);
  assert.match(words(book.blocks), /\[картинка\] a & b/);
  assertSafe(book.blocks);
});

test('plain text: paragraphs by blank lines, hand-wrapped lines joined, verse kept', async () => {
  const text = 'Первая строка абзаца, которая была перенесена вручную\nи продолжается здесь, на второй строке текста.\n\nМороз и солнце,\nдень чудесный!\n';
  const book = await loadBook('poem.txt', cp1251(text));
  assert.equal(book.blocks.length, 2);
  assert.equal(plain(book.blocks[0]), 'Первая строка абзаца, которая была перенесена вручную и продолжается здесь, на второй строке текста.');
  assert.equal(plain(book.blocks[1]), 'Мороз и солнце,\nдень чудесный!');
  const lines = await loadBook('list.txt', utf8('один\nдва\nтри'));
  assert.equal(lines.blocks.length, 3, 'no blank lines: a paragraph per line');
});

test('an HTML page keeps its words and loses everything active', async () => {
  const book = await loadBook('page.html', utf8('<html><head><title>Страница</title><style>p{}</style></head><body><p>Привет <a href="#x" onclick="steal()">ссылка</a></p><form><input value="секрет"></form></body></html>'));
  assert.equal(book.title, 'Страница');
  assert.equal(words(book.blocks), 'Привет ссылка');
  assertSafe(book.blocks);
});

test('el() keeps only known classes and sane spans', () => {
  assert.deepEqual(el('td', { class: 'evil', colspan: '2;x', rowspan: '3' }).attrs, { rowspan: '3' });
});

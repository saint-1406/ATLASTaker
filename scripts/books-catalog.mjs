// Makes the contents of Apocrypha's collection (src/apocrypha/collection.js) from a folder of EPUB books:
//   node scripts/books-catalog.mjs <folder with books> <the collection repository's folder>
// Each book is checked (a whole EPUB, at most 50 MB, marked as public domain), copied as it came to
// books/, its cover to covers/, and listed in catalog.json with its title, author, language, size
// and SHA-256. A file that fails a check is named and left out. The files are not changed: a Project
// Gutenberg book keeps its licence inside, as Project Gutenberg asks of copies that carry its name.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openZip, joinPath } from '../src/reader/zip.js';

const MAX = 50 * 1024 * 1024;
const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error('node scripts/books-catalog.mjs <folder with books> <collection folder>');
  process.exit(1);
}

const decode = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, key) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[key.toLowerCase()];
      if (named) return named;
      const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    })
    .replace(/\s+/g, ' ')
    .trim();
const tag = (xml, name) => decode((new RegExp(`<dc:${name}\\b[^>]*>([\\s\\S]*?)</dc:${name}>`, 'i').exec(xml) ?? [])[1]);
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<dc:${name}\\b[^>]*>([\\s\\S]*?)</dc:${name}>`, 'gi'))].map((m) => decode(m[1]));
const attr = (el, name) => (new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(el) ?? [])[1] ?? '';
const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'book';

/** "Shelley, Mary Wollstonecraft" → "Mary Wollstonecraft Shelley"; dates in brackets go. */
function authorName(s) {
  const clean = s.replace(/\s*\(?\d{3,4}\s*-\s*\d{0,4}\)?\s*$/, '').trim();
  const parts = clean.split(/\s*,\s*/);
  return parts.length === 2 && !/\s/.test(parts[0]) ? `${parts[1]} ${parts[0]}` : clean;
}

async function readBook(file) {
  const bytes = new Uint8Array(fs.readFileSync(file));
  if (bytes.length > MAX) throw new Error('bigger than 50 MB');
  const zip = openZip(bytes);
  if (!zip.has('META-INF/container.xml')) throw new Error('not an EPUB (no META-INF/container.xml)');
  const container = await zip.text('META-INF/container.xml');
  const opfPath = attr(/<rootfile\b[^>]*>/i.exec(container)?.[0] ?? '', 'full-path');
  if (!opfPath || !zip.has(opfPath)) throw new Error('no package file');
  const opf = await zip.text(opfPath);
  // every file the book names must unpack: a book cut short by a download stops here
  for (const name of zip.names) if (!name.endsWith('/')) await zip.read(name);

  const title = tag(opf, 'title');
  if (!title) throw new Error('no title');
  const rights = tag(opf, 'rights');
  if (!/public domain/i.test(rights)) throw new Error(`not marked as public domain ("${rights || 'no rights'}")`);
  const identifiers = tags(opf, 'identifier');
  const gutenberg = identifiers.map((id) => /gutenberg\.org\/ebooks\/(\d+)/.exec(id)?.[1]).find(Boolean) ?? /^(\d+)\.epub$/i.exec(path.basename(file))?.[1];
  const id = gutenberg ? `pg-${gutenberg}` : slug(title);

  // the cover: the manifest item marked as such (EPUB 3), or the one <meta name="cover"> names (EPUB 2)
  const items = [...opf.matchAll(/<item\b[^>]*>/gi)].map((m) => m[0]);
  const coverId = attr(/<meta\b[^>]*name="cover"[^>]*>/i.exec(opf)?.[0] ?? '', 'content');
  const coverItem = items.find((el) => /\bproperties="[^"]*cover-image/i.test(el)) ?? items.find((el) => coverId && attr(el, 'id') === coverId);
  let cover = null;
  if (coverItem) {
    const href = joinPath(opfPath, attr(coverItem, 'href'));
    const type = attr(coverItem, 'media-type');
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[type];
    if (ext && zip.has(href)) cover = { bytes: await zip.read(href), ext };
  }

  const year = Number(/\b(1[0-9]{3}|20[0-9]{2})\b/.exec(tag(opf, 'date'))?.[1]) || 0;
  return {
    bytes,
    entry: {
      id,
      title,
      author: tags(opf, 'creator').map(authorName).join(', '),
      language: (tag(opf, 'language') || 'und').toLowerCase().split('-')[0],
      format: 'epub',
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      rights,
      source: gutenberg ? 'Project Gutenberg' : '',
      sourceUrl: gutenberg ? `https://www.gutenberg.org/ebooks/${gutenberg}` : '',
      year,
    },
    cover,
  };
}

fs.mkdirSync(path.join(to, 'books'), { recursive: true });
fs.mkdirSync(path.join(to, 'covers'), { recursive: true });
const books = [];
const skipped = [];
for (const name of fs.readdirSync(from).filter((n) => n.toLowerCase().endsWith('.epub')).sort()) {
  try {
    const { bytes, entry, cover } = await readBook(path.join(from, name));
    if (books.some((b) => b.sha256 === entry.sha256 || b.id === entry.id)) throw new Error('already in the list');
    entry.path = `books/${entry.id}.epub`;
    fs.writeFileSync(path.join(to, entry.path), bytes);
    if (cover) {
      entry.cover = `covers/${entry.id}.${cover.ext}`;
      fs.writeFileSync(path.join(to, entry.cover), cover.bytes);
    }
    books.push(entry);
    console.log(`ok    ${name}  ${entry.title} — ${entry.author} [${entry.language}] ${(entry.size / 1024).toFixed(0)} KB`);
  } catch (err) {
    skipped.push({ name, why: err.message });
    console.log(`skip  ${name}  ${err.message}`);
  }
}
books.sort((a, b) => a.title.localeCompare(b.title));
const catalog = { version: 1, updated: new Date().toISOString(), books };
fs.writeFileSync(path.join(to, 'catalog.json'), `${JSON.stringify(catalog, null, 1)}\n`);
// the repository says what it is and where the books come from
const fromGutenberg = books.filter((b) => b.source === 'Project Gutenberg').length;
fs.writeFileSync(
  path.join(to, 'README.md'),
  `# ATLAS Apocrypha — collection

Books in the public domain for the ATLAS Notetaker app (the Apocrypha tab). The app reads \`catalog.json\`
and downloads the files from here; each download is checked against the SHA-256 in the list.

- \`books/\` — the books, exactly as they were published (not changed in any way)
- \`covers/\` — their cover pictures, taken from the books themselves
- \`catalog.json\` — title, author, language, size, SHA-256, source and rights of each book

${fromGutenberg ? `${fromGutenberg} of the ${books.length} books come from [Project Gutenberg](https://www.gutenberg.org). They are distributed free of charge, unchanged, with the Project Gutenberg License inside each file. They are in the public domain in the USA; check the copyright laws of your country before using them.\n` : ''}
This repository is made by \`scripts/books-catalog.mjs\` in the ATLAS repository.
`,
);
console.log(`\n${books.length} books listed, ${skipped.length} left out.`);

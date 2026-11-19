// The library's authors, for the shelf's filter. A book's author line may hold several people: the
// readers join an FB2's or an EPUB's authors with ", " (src/reader/fb2.js, formats.js), and other
// tools use ";" or " & ". A comma splits only names that are whole names on both sides ("Ilya Ilf,
// Evgeny Petrov"), so "Tolstoy, Leo" stays one person.

const HARD_SPLIT = /\s*(?:;|\s&\s)\s*/;

/** The people of one author line, each trimmed; none for an empty line. */
export function authorsOf(line) {
  const people = [];
  for (const part of String(line ?? '').split(HARD_SPLIT)) {
    const pieces = part.split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean);
    if (pieces.length > 1 && pieces.every((p) => /\s/.test(p))) people.push(...pieces);
    else if (part.trim()) people.push(part.trim().replace(/\s+/g, ' '));
  }
  return people;
}

/** How a name is compared: case and spacing do not make another author. */
export const authorKey = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/** Is this book by that author (by key)? '' stands for the books with no author. */
export function byAuthor(doc, key) {
  const people = authorsOf(doc.author);
  if (key === '') return people.length === 0;
  return people.some((name) => authorKey(name) === key);
}

/**
 * The authors of the books, by name, each once: [{ key, name, count }]; the books with no author
 * last, as { key: '', name: '', count } when there are any.
 */
export function authorList(docs, locale = 'ru') {
  const byKey = new Map();
  let nameless = 0;
  for (const doc of docs) {
    const people = authorsOf(doc.author);
    if (!people.length) nameless++;
    for (const key of new Set(people.map(authorKey))) {
      const entry = byKey.get(key) ?? { key, name: people.find((p) => authorKey(p) === key), count: 0 };
      entry.count++;
      byKey.set(key, entry);
    }
  }
  const list = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, locale, { sensitivity: 'base' }));
  if (nameless) list.push({ key: '', name: '', count: nameless });
  return list;
}

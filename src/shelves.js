// The library's sections ("shelves"): genres, documents, whatever the person sorts books into. A book
// names its section on its card (doc.shelf, '' for none), so it travels with sync; the list kept in
// the app's state holds the order and the sections still empty.

export const MAX_SHELVES = 60;
export const MAX_SHELF_NAME = 60;

/** A section name as kept: spaces folded, trimmed, cut to size; '' when nothing is left. */
export const cleanShelf = (name) =>
  String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SHELF_NAME);

const same = (a, b) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** The sections in order: the saved list first, then any a book names that the list lacks (synced in). */
export function shelfList(saved, docs) {
  const out = [];
  const add = (name) => {
    const clean = cleanShelf(name);
    if (clean && !out.some((n) => same(n, clean)) && out.length < MAX_SHELVES) out.push(clean);
  };
  (Array.isArray(saved) ? saved : []).forEach(add);
  for (const doc of docs) if (doc.shelf) add(doc.shelf);
  return out;
}

/** The books of each section, newest read first; and those in none. */
export function groupShelves(shelves, docs) {
  const order = (a, b) => (b.opened || b.added || 0) - (a.opened || a.added || 0);
  const groups = shelves.map((name) => ({ name, docs: docs.filter((d) => d.shelf && same(cleanShelf(d.shelf), name)).sort(order) }));
  const unsorted = docs.filter((d) => !d.shelf || !shelves.some((n) => same(cleanShelf(d.shelf), n))).sort(order);
  return { groups, unsorted };
}

/** The list with one section renamed (books are renamed by the caller); null when the name is taken. */
export function renameShelf(shelves, from, to) {
  const name = cleanShelf(to);
  if (!name) return null;
  if (shelves.some((n) => same(n, name) && !same(n, from))) return null;
  return shelves.map((n) => (same(n, from) ? name : n));
}

/** The list with a section added at the end; null when it is already there or empty. */
export function addShelf(shelves, name) {
  const clean = cleanShelf(name);
  if (!clean || shelves.some((n) => same(n, clean)) || shelves.length >= MAX_SHELVES) return null;
  return [...shelves, clean];
}

export const isShelf = (doc, name) => Boolean(doc.shelf) && same(cleanShelf(doc.shelf), name);

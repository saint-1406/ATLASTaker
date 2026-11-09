// A series of books ("Harry Potter"): the person says which books belong to it and which part each is.
// Like a section, a book names its series on its own card (doc.series, '' for none; doc.seriesNo, the
// part, null for none), so it travels with sync. On the shelf the books of a series lie together as one
// folder; opened, it lists them by part.

export const MAX_SERIES_NAME = 120;
export const MAX_SERIES_NO = 99999;

/** A series name as kept: spaces folded, trimmed, cut to size; '' when nothing is left. */
export const cleanSeries = (name) =>
  String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SERIES_NAME);

const same = (a, b) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** The part as typed ("2", "2.5", "2,5", "#3", "часть 4"): a number, or null when there is none. */
export function seriesNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && value <= MAX_SERIES_NO ? value : null;
  const match = /\d+(?:[.,]\d+)?/.exec(String(value ?? ''));
  if (!match) return null;
  const n = Number(match[0].replace(',', '.'));
  return n <= MAX_SERIES_NO ? Math.round(n * 100) / 100 : null;
}

/** Is the book in this series? */
export const inSeries = (doc, name) => Boolean(doc.series) && same(cleanSeries(doc.series), cleanSeries(name));

/** The books of a series in reading order: by part (those without one last), then by title. */
export function seriesOrder(docs) {
  const no = (d) => (Number.isFinite(d.seriesNo) ? d.seriesNo : Infinity);
  return [...docs].sort((a, b) => no(a) - no(b) || String(a.title || a.name).localeCompare(String(b.title || b.name)));
}

/** Every series named on the shelf, each once, as first written. */
export function seriesNames(docs) {
  const out = [];
  for (const doc of docs) {
    const name = cleanSeries(doc.series);
    if (name && !out.some((n) => same(n, name))) out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * The books as the shelf shows them: a series becomes one item where its first book (in the order
 * given) was, holding all its books in reading order; a book of no series stays itself.
 *   [{ series: name, docs }, { doc }, …]
 */
export function foldSeries(docs) {
  const items = [];
  const folders = new Map();
  for (const doc of docs) {
    const name = cleanSeries(doc.series);
    if (!name) {
      items.push({ doc });
      continue;
    }
    const key = name.toLocaleLowerCase();
    let folder = folders.get(key);
    if (!folder) {
      folder = { series: name, docs: [] };
      folders.set(key, folder);
      items.push(folder);
    }
    folder.docs.push(doc);
  }
  for (const folder of folders.values()) folder.docs = seriesOrder(folder.docs);
  return items;
}

/** The words a search looks through for a book: title, author, file name, section and series. */
export const searchText = (doc) => `${doc.title ?? ''} ${doc.author ?? ''} ${doc.name ?? ''} ${doc.shelf ?? ''} ${doc.series ?? ''}`.toLowerCase();

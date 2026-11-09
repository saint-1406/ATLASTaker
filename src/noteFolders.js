// Folders for notes, the way the library has sections: a note names its folder in its meta
// (note.folder, '' for none), so the folder travels with sync; the list kept in the app's state
// (noteFolders) holds the order and the folders still empty. Pure functions, no DOM.

import { addShelf, cleanShelf, renameShelf, shelfList } from './shelves.js';
import { decodeEntities } from './entities.js';

export const ALL = ':all';
export const NONE = ':none';

export const cleanFolder = cleanShelf;
const same = (a, b) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** The folders in order: the saved list first, then any a note names that the list lacks (synced in). */
export const folderList = (saved, notes) =>
  shelfList(
    saved,
    notes.map((n) => ({ shelf: n.folder })),
  );

/** The list with a folder added at the end; null when the name is empty or taken. */
export const addFolder = addShelf;

/** The list with a folder renamed (notes are moved by the caller); null when the name is empty or taken. */
export const renameFolder = renameShelf;

/** Is the note in this folder? `folder` may also be ALL or NONE. */
export function inFolder(note, folder, folders = []) {
  if (folder === ALL) return true;
  const own = cleanFolder(note.folder);
  if (folder === NONE) return !own || !folders.some((n) => same(n, own));
  return Boolean(own) && same(own, folder);
}

/** How many notes each folder holds: { [ALL], [NONE], name: n }. */
export function folderCounts(notes, folders) {
  const out = { [ALL]: notes.length, [NONE]: 0 };
  for (const name of folders) out[name] = 0;
  for (const note of notes) {
    const own = cleanFolder(note.folder);
    const name = own && folders.find((n) => same(n, own));
    if (name) out[name]++;
    else out[NONE]++;
  }
  return out;
}

/** A note's first lines without markdown marks: the title and a short piece after it. */
export function preview(content, size = 140) {
  const lines = String(content ?? '')
    .split('\n')
    // the visual editor's marks for an empty line and an accordion are no words of the note
    .filter((line) => !/^\s*(<p><\/p>|<\/?details(?: open)?>)\s*$/.test(line))
    .map((line) =>
      decodeEntities(
        line
          .replace(/^\s*<summary>(.*)<\/summary>\s*$/, '$1')
          // a character kept literal by a backslash (\. \* \#) stays as itself, not as a mark
          .replace(/\\([!-/:-@[-`{-~])/g, (_, ch) => `&#${ch.codePointAt(0)};`)
          .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
          .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<\/?(?:u|strong|em|s|del|b|i|code|mark|sub|sup)>/gi, '')
          .replace(/[*_`~]+/g, '')
          .replace(/<!--.*?-->/g, ''),
      ).trim(),
    )
    .filter((line) => line && !/^(-{3,}|`{3,}|~{3,})$/.test(line));
  const title = lines[0] ?? '';
  const rest = lines.slice(1).join(' ');
  return {
    title,
    snippet: rest.length > size ? `${rest.slice(0, size).trimEnd()}…` : rest,
  };
}

/** The notes to show: in the folder, matching every word of the query, newest first. */
export function pickNotes(notes, { folder = ALL, folders = [], query = '' } = {}) {
  const words = String(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return notes
    .filter((n) => inFolder(n, folder, folders))
    .filter((n) => {
      if (!words.length) return true;
      const text = `${n.content ?? ''} ${n.folder ?? ''}`.toLocaleLowerCase();
      return words.every((w) => text.includes(w));
    })
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
}

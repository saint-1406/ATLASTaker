// Marks: what a reader leaves in a document — a coloured highlight, optionally with a comment.
// They live on the document's library card (doc.marks) and are drawn over the text each time it opens.
//   { id, color, note, text, where, anchor, created, edited }
// anchor says where the passage is, in the reader's own terms:
//   a book (EPUB, FB2, DOCX, …): { a, ao, b, bo } — block number and character offset of its start and end,
//     so it survives a change of font, size, window or reading mode;
//   a PDF: { rects: [[page, x, y, w, h], …] } — boxes as fractions of the page.

export const MARK_COLORS = ['yellow', 'green', 'blue', 'pink'];
export const MAX_MARKS = 5000;
export const MAX_NOTE = 10_000;
export const MAX_TEXT = 2000;

const ID_RE = /^m-[a-z0-9]{4,40}$/;
const num = (v) => Number.isFinite(v);
const int = (v) => Number.isInteger(v) && v >= 0;
// `trashed`: when a mark, bookmark or text went to the trash (absent or 0: it is in the document)
const inTrash = (item) => item.trashed === undefined || item.trashed === null || (num(item.trashed) && item.trashed >= 0);

/** Items not in the trash. */
export const live = (list) => (Array.isArray(list) ? list.filter((item) => !item.trashed) : []);

export const MAX_BOOKMARKS = 1000;

export function newMarkId() {
  return `m-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** An anchor a reader can find again, or false. */
export function validAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return false;
  if ('rects' in anchor) {
    const { rects } = anchor;
    return (
      Array.isArray(rects) &&
      rects.length > 0 &&
      rects.length <= 400 &&
      rects.every((r) => Array.isArray(r) && r.length === 5 && Number.isInteger(r[0]) && r[0] >= 1 && r.slice(1).every((v) => num(v) && v >= -0.05 && v <= 1.05))
    );
  }
  return int(anchor.a) && int(anchor.ao) && int(anchor.b) && int(anchor.bo) && (anchor.b > anchor.a || (anchor.b === anchor.a && anchor.bo > anchor.ao));
}

export function validMark(mark) {
  return (
    Boolean(mark) &&
    typeof mark === 'object' &&
    typeof mark.id === 'string' &&
    ID_RE.test(mark.id) &&
    MARK_COLORS.includes(mark.color) &&
    typeof mark.note === 'string' &&
    mark.note.length <= MAX_NOTE &&
    typeof mark.text === 'string' &&
    mark.text.length <= MAX_TEXT &&
    (mark.where === undefined || (typeof mark.where === 'string' && mark.where.length <= 300)) &&
    num(mark.created) &&
    (mark.edited === undefined || num(mark.edited)) &&
    inTrash(mark) &&
    validAnchor(mark.anchor)
  );
}

export function validMarks(marks) {
  return Array.isArray(marks) && marks.length <= MAX_MARKS && marks.every(validMark) && new Set(marks.map((m) => m.id)).size === marks.length;
}

/** Marks in reading order: by block / page, then by place in it. */
export function sortMarks(marks) {
  const key = (m) => (m.anchor.rects ? [m.anchor.rects[0][0], m.anchor.rects[0][2], m.anchor.rects[0][1]] : [m.anchor.a, m.anchor.ao, 0]);
  return [...marks].sort((x, y) => {
    const a = key(x);
    const b = key(y);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || x.created - y.created;
  });
}

/** PDF boxes of one selection, merged where they sit side by side on one line. */
export function mergeRects(rects) {
  const out = [];
  for (const r of [...rects].sort((x, y) => x[0] - y[0] || x[2] - y[2] || x[1] - y[1])) {
    const last = out[out.length - 1];
    if (last && last[0] === r[0] && Math.abs(last[2] - r[2]) < 0.006 && Math.abs(last[4] - r[4]) < 0.008 && r[1] <= last[1] + last[3] + 0.012) {
      const right = Math.max(last[1] + last[3], r[1] + r[3]);
      const bottom = Math.max(last[2] + last[4], r[2] + r[4]);
      last[1] = Math.min(last[1], r[1]);
      last[2] = Math.min(last[2], r[2]);
      last[3] = right - last[1];
      last[4] = bottom - last[2];
    } else out.push([...r]);
  }
  const round = (v) => Math.round(v * 10000) / 10000;
  return out.map(([page, ...box]) => [page, ...box.map(round)]);
}

// Bookmarks: places to come back to, without a passage — the reader's own position at that moment.
//   { id, position, progress, label, snippet, created }

export function newBookmarkId() {
  return `b-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function validBookmark(b) {
  return (
    Boolean(b) &&
    typeof b === 'object' &&
    typeof b.id === 'string' &&
    /^b-[a-z0-9]{4,40}$/.test(b.id) &&
    Boolean(b.position) &&
    typeof b.position === 'object' &&
    !Array.isArray(b.position) &&
    JSON.stringify(b.position).length <= 2000 &&
    num(b.progress) &&
    b.progress >= 0 &&
    b.progress <= 1 &&
    typeof b.label === 'string' &&
    b.label.length <= 300 &&
    (b.snippet === undefined || (typeof b.snippet === 'string' && b.snippet.length <= 300)) &&
    num(b.created) &&
    (b.edited === undefined || num(b.edited)) &&
    inTrash(b)
  );
}

export function validBookmarks(list) {
  return Array.isArray(list) && list.length <= MAX_BOOKMARKS && list.every(validBookmark) && new Set(list.map((b) => b.id)).size === list.length;
}

// ---------- after a PDF's pages were edited ----------

/** A box [x, y, w, h] (fractions of the page) on a page turned clockwise by `turn` degrees. */
export function turnBox([x, y, w, h], turn) {
  switch (((turn % 360) + 360) % 360) {
    case 90:
      return [1 - y - h, x, h, w];
    case 180:
      return [1 - x - w, 1 - y - h, w, h];
    case 270:
      return [y, 1 - x - w, h, w];
    default:
      return [x, y, w, h];
  }
}

/**
 * plan: the new pages in order, [{ src, page (1-based in its source), turn }]; source 0 is the document
 * itself. Marks and bookmarks on its pages follow them; those on removed pages go.
 */
export function remapPdf({ marks = [], bookmarks = [] }, plan) {
  const moved = new Map(); // old page → { page, turn }
  plan.forEach((p, i) => {
    if (p.src === 0 && !moved.has(p.page)) moved.set(p.page, { page: i + 1, turn: p.turn || 0 });
  });
  const round = (v) => Math.round(v * 10000) / 10000;
  const outMarks = [];
  for (const mark of marks) {
    if (!mark.anchor?.rects) continue;
    const rects = mark.anchor.rects
      .filter(([page]) => moved.has(page))
      .map(([page, ...box]) => {
        const to = moved.get(page);
        return [to.page, ...turnBox(box, to.turn).map(round)];
      });
    if (rects.length) outMarks.push({ ...mark, anchor: { rects }, where: mark.where && /\d/.test(mark.where) ? mark.where.replace(/\d+/, String(rects[0][0])) : mark.where });
  }
  const outBookmarks = [];
  const count = Math.max(1, plan.length);
  for (const b of bookmarks) {
    const to = moved.get(b.position?.page);
    if (!to) continue;
    outBookmarks.push({ ...b, position: { ...b.position, page: to.page, frac: to.turn ? 0 : b.position.frac }, progress: count > 1 ? (to.page - 1) / (count - 1) : 0, label: b.label.replace(/\d+/, String(to.page)) });
  }
  return { marks: outMarks, bookmarks: outBookmarks };
}

// ---------- texts: words a reader writes on a PDF page ----------
//   { id, page, x, y, w, text, size, color, created, edited }
// x, y: the top left corner and w: the width of the box, as fractions of the page as shown; size: the
// letter height as a fraction of the page width, so the text keeps its place and size at any zoom.

export const TEXT_COLORS = ['black', 'red', 'blue', 'green'];
export const TEXT_SIZES = [0.016, 0.022, 0.03, 0.042];
export const MAX_TEXTS = 2000;
export const MAX_TEXT_LENGTH = 4000;

export function newTextId() {
  return `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function validText(item) {
  const frac = (v) => num(v) && v >= 0 && v <= 1;
  return (
    Boolean(item) &&
    typeof item === 'object' &&
    typeof item.id === 'string' &&
    /^t-[a-z0-9]{4,40}$/.test(item.id) &&
    Number.isInteger(item.page) &&
    item.page >= 1 &&
    frac(item.x) &&
    frac(item.y) &&
    num(item.w) &&
    item.w >= 0.02 &&
    item.w <= 1 &&
    typeof item.text === 'string' &&
    item.text.length <= MAX_TEXT_LENGTH &&
    num(item.size) &&
    item.size >= 0.005 &&
    item.size <= 0.2 &&
    TEXT_COLORS.includes(item.color) &&
    num(item.created) &&
    (item.edited === undefined || num(item.edited)) &&
    inTrash(item)
  );
}

export function validTexts(list) {
  return Array.isArray(list) && list.length <= MAX_TEXTS && list.every(validText) && new Set(list.map((x) => x.id)).size === list.length;
}

/** Texts in reading order: by page, then top to bottom. */
export const sortTexts = (list) => [...list].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x || a.created - b.created);

/** After a PDF's pages changed (plan as in remapPdf): texts follow their pages; those on removed pages go. */
export function remapTexts(texts = [], plan) {
  const moved = new Map();
  plan.forEach((p, i) => {
    if (p.src === 0 && !moved.has(p.page)) moved.set(p.page, { page: i + 1, turn: p.turn || 0 });
  });
  const round = (v) => Math.round(v * 10000) / 10000;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const out = [];
  for (const item of texts) {
    const to = moved.get(item.page);
    if (!to) continue;
    // the corner turns with the page; the words stay upright, as wide as before (within the page)
    const [x, y] = turnBox([item.x, item.y, 0, 0], to.turn);
    const w = clamp(item.w, 0.02, 1);
    out.push({ ...item, page: to.page, x: round(clamp(x, 0, 1 - w)), y: round(clamp(y, 0, 0.98)), w });
  }
  return out;
}

// ---------- edits: a line of a PDF's own text, rewritten ----------
//   { id, page, x, y, w, h, base, size, font, bold, ink, bg, original, text, created, edited }
// x, y, w, h: the box of the original line (fractions of the page as shown), covered with the page's
// colour (bg); base: where the new words stand (their baseline), size: the letter height as a fraction
// of the page width; font: 'sans' | 'serif' | 'mono'. Shown over the page until written into the file.

export const EDIT_FONTS = ['sans', 'serif', 'mono'];
export const MAX_EDITS = 2000;
const COLOR_RE = /^#[0-9a-f]{6}$/;

export function newEditId() {
  return `e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function validEdit(item) {
  const frac = (v) => num(v) && v >= -0.05 && v <= 1.05;
  return (
    Boolean(item) &&
    typeof item === 'object' &&
    typeof item.id === 'string' &&
    /^e-[a-z0-9]{4,40}$/.test(item.id) &&
    Number.isInteger(item.page) &&
    item.page >= 1 &&
    [item.x, item.y, item.base].every(frac) &&
    num(item.w) &&
    item.w > 0 &&
    item.w <= 1.1 &&
    num(item.h) &&
    item.h > 0 &&
    item.h <= 0.5 &&
    num(item.size) &&
    item.size > 0.001 &&
    item.size <= 0.3 &&
    EDIT_FONTS.includes(item.font) &&
    typeof item.bold === 'boolean' &&
    COLOR_RE.test(item.ink) &&
    COLOR_RE.test(item.bg) &&
    typeof item.original === 'string' &&
    item.original.length <= MAX_TEXT_LENGTH &&
    typeof item.text === 'string' &&
    item.text.length <= MAX_TEXT_LENGTH &&
    num(item.created) &&
    (item.edited === undefined || num(item.edited))
  );
}

export function validEdits(list) {
  return Array.isArray(list) && list.length <= MAX_EDITS && list.every(validEdit) && new Set(list.map((x) => x.id)).size === list.length;
}

/**
 * The line of text under a point, from a page's runs of text: [{ str, left, top, right, bottom, base,
 * size, font, bold }] in the page's units as shown (y down). Runs on the same baseline, of about the same
 * size and close enough to read as one phrase, make the line; a wide gap (another column) ends it.
 */
export function pickLine(runs, px, py) {
  const hit = runs.find((r) => r.str.trim() && px >= r.left - r.size * 0.2 && px <= r.right + r.size * 0.2 && py >= r.top - r.size * 0.15 && py <= r.bottom + r.size * 0.15);
  if (!hit) return null;
  const same = runs
    .filter((r) => r.str.length && Math.abs(r.base - hit.base) < hit.size * 0.35 && r.size > hit.size * 0.7 && r.size < hit.size * 1.4)
    .sort((a, b) => a.left - b.left);
  const at = same.indexOf(hit);
  let lo = at;
  let hi = at;
  const close = (a, b) => b.left - a.right < hit.size * 1.6;
  while (lo > 0 && close(same[lo - 1], same[lo])) lo--;
  while (hi < same.length - 1 && close(same[hi], same[hi + 1])) hi++;
  const parts = same.slice(lo, hi + 1);
  let text = '';
  parts.forEach((r, i) => {
    const prev = parts[i - 1];
    if (prev && r.left - prev.right > hit.size * 0.15 && !/\s$/.test(text) && !/^\s/.test(r.str)) text += ' ';
    text += r.str;
  });
  return {
    text: text.replace(/\s+/g, ' ').trim(),
    left: Math.min(...parts.map((r) => r.left)),
    right: Math.max(...parts.map((r) => r.right)),
    top: Math.min(...parts.map((r) => r.top)),
    bottom: Math.max(...parts.map((r) => r.bottom)),
    base: hit.base,
    size: hit.size,
    font: hit.font,
    bold: hit.bold,
  };
}

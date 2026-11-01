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
    num(b.created)
  );
}

export function validBookmarks(list) {
  return Array.isArray(list) && list.length <= MAX_BOOKMARKS && list.every(validBookmark) && new Set(list.map((b) => b.id)).size === list.length;
}

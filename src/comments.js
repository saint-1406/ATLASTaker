// Comments live inside the note, one line under the line they talk about:
//
//   - [ ] Позвонить подрядчику
//         💬 26.10.2026 17:52 · перенесли на четверг
//
// so they survive restarts, exports and opening the .md in any other editor.

export const COMMENT_MARK = '💬';
export const COMMENT_RE = /^(\s*)💬 (\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}) · (.*)$/u;

const LIST_PREFIX_RE = /^(\s*)((?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/;

export function isCommentLine(line) {
  return COMMENT_RE.test(line ?? '');
}

export function formatStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getDate())}.${p(date.getMonth() + 1)}.${date.getFullYear()} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** The line a comment belongs to: clicking on a comment means "add to this task's thread". 1-based. */
export function commentTarget(lines, lineNumber) {
  let target = Math.max(1, Math.min(lineNumber, lines.length));
  while (target > 1 && isCommentLine(lines[target - 1])) target--;
  return target;
}

/** Existing comments under a target line, oldest first. */
export function commentsUnder(lines, target) {
  const out = [];
  for (let i = target; i < lines.length; i++) {
    const m = COMMENT_RE.exec(lines[i]);
    if (!m) break;
    out.push({ line: i + 1, stamp: m[2], text: m[3] });
  }
  return out;
}

/**
 * Plans a new comment for `lineNumber` (1-based) in `lines`.
 * Returns { afterLine, text } — insert `text` as a new line after line `afterLine` — or null for an empty comment.
 */
export function planComment(lines, lineNumber, body, date = new Date()) {
  const clean = String(body ?? '')
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' / ');
  if (!clean) return null;

  const target = commentTarget(lines, lineNumber);
  const parent = (lines[target - 1] ?? '').replace(/\t/g, '    ');
  const m = LIST_PREFIX_RE.exec(parent);
  const indent = m[1] + ' '.repeat((m[2] ?? '').length);

  const existing = commentsUnder(lines, target);
  const afterLine = existing.length ? existing[existing.length - 1].line : target;
  return { afterLine, text: `${indent}${COMMENT_MARK} ${formatStamp(date)} · ${clean}` };
}

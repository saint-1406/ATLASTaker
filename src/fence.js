// "/#" typed alone on a line is the quick way in and out of a code block: outside one it opens a
// block (both fences at once, cursor inside), inside one it closes it — the cursor leaves the block,
// or, with code still below, the block is split there. Pure text in, one change out.

const OPEN_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/;
const SLASH_RE = /^(\s*)\/#\s*$/;

/** Fenced blocks as line indexes: { open, close (−1: never closed), indent, fence, info }. */
export function fencedBlocks(lines) {
  const blocks = [];
  let current = null;
  lines.forEach((line, i) => {
    if (current) {
      const close = CLOSE_RE.exec(line);
      if (close && close[1][0] === current.fence[0] && close[1].length >= current.fence.length) {
        current.close = i;
        current = null;
      }
      return;
    }
    const open = OPEN_RE.exec(line);
    if (open && !(open[2][0] === '`' && open[3].includes('`'))) {
      current = { open: i, close: -1, indent: open[1], fence: open[2], info: open[3].trim() };
      blocks.push(current);
    }
  });
  return blocks;
}

/**
 * The change that "/#" just typed at `pos` (right after the "#") turns into, or null when the line
 * holds anything else. { from, to, insert, cursor } are offsets into `text`.
 */
export function planSlashFence(text, pos) {
  const lines = text.split('\n');
  let index = 0;
  let start = 0;
  while (index < lines.length - 1 && start + lines[index].length < pos) {
    start += lines[index].length + 1;
    index++;
  }
  const line = lines[index];
  const slash = SLASH_RE.exec(line);
  if (!slash || pos !== start + slash[1].length + 2) return null;
  const indent = slash[1];
  const lineEnd = start + line.length;
  const block = fencedBlocks(lines).find((b) => b.open < index && (b.close === -1 || index < b.close));

  if (!block) {
    const head = `${indent}\`\`\``;
    return { from: start, to: lineEnd, insert: `${head}\n${indent}\n${indent}\`\`\``, cursor: start + head.length + 1 + indent.length };
  }

  const closing = `${block.indent}${block.fence}`;
  if (block.close === -1) {
    return { from: start, to: lineEnd, insert: `${closing}\n${block.indent}`, cursor: start + closing.length + 1 + block.indent.length };
  }
  const codeBelow = lines.slice(index + 1, block.close).some((l) => l.trim());
  if (codeBelow) {
    // close here and open again under an empty line: the code below stays code
    const insert = `${closing}\n${block.indent}\n${closing}${block.info}`;
    return { from: start, to: lineEnd, insert, cursor: start + closing.length + 1 + block.indent.length };
  }
  // only blank lines up to the closing fence: step out below it
  let closeEnd = start;
  for (let i = index; i <= block.close; i++) closeEnd += lines[i].length + (i < block.close ? 1 : 0);
  const next = lines[block.close + 1];
  const reuse = next !== undefined && !next.trim();
  const insert = reuse ? lines[block.close] : `${lines[block.close]}\n${block.indent}`;
  return { from: start, to: closeEnd, insert, cursor: start + lines[block.close].length + 1 + (reuse ? next.length : block.indent.length) };
}

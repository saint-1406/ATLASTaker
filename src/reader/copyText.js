// A selection in a book as plain text that keeps its shape: a blank line between paragraphs, a line
// break where the book breaks a line. The selection's own text (Range.toString) runs it all together.

// what makes a paragraph of its own
const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'TABLE', 'TR', 'FIGURE', 'FIGCAPTION', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE']);

/**
 * The text of `range` (or of any node with childNodes): blocks apart, <br> as a line break, a table's
 * cells apart by a tab. Spaces and line ends in the book's own markup are only spaces, as on screen,
 * except inside <pre>.
 */
export function rangeText(range) {
  const out = [];
  const walk = (node, pre) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out.push(pre ? child.data : child.data.replace(/\s+/g, ' '));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toUpperCase();
      if (tag === 'BR') {
        out.push('\n');
        continue;
      }
      if (SKIP.has(tag) || child.getAttribute('aria-hidden') === 'true') continue;
      const block = BLOCKS.has(tag) || child.classList.contains('rd-u');
      if (block) out.push('\n\n');
      else if (tag === 'TD' || tag === 'TH') out.push('\t');
      walk(child, pre || tag === 'PRE');
      if (block) out.push('\n\n');
    }
  };
  walk(typeof range.cloneContents === 'function' ? range.cloneContents() : range, false);
  return out.join('');
}

/** Runs of spaces as one, no spaces at the ends of lines, at most one blank line in a row. */
export function tidyText(text) {
  return text
    .replace(/[  ]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

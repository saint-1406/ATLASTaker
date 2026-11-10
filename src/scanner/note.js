// A finished scan as a note's Markdown (app.js saves it with createNote). No DOM here: tested in Node.

/** The scan as a note's Markdown: a heading, the text (lines that Markdown would take for marks escaped), the pictures. */
export function scanNote(title, text, imageNames = [], alts = []) {
  const safe = (text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^(\s{0,3})([#>])/, '$1\\$2'))
    .join('\n')
    .trim();
  const heading = `# ${String(title ?? '').replace(/\s+/g, ' ').trim()}`;
  const pictures = imageNames.map((name, i) => `![${(alts[i] ?? '').replace(/[[\]\n]/g, ' ')}](assets/${name})`);
  return [heading, safe, ...pictures].filter(Boolean).join('\n\n') + '\n';
}

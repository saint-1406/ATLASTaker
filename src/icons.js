// One set of line icons for the buttons that had emoji and odd symbols (🖼 🔗 💬 🌐 🔖 ⧉ ☰ …): drawn on a
// 16×16 grid with the stroke of the side menu's icons (sidemenu.js), so they look like one family and
// take the colour of the button they are in.

const PATHS = {
  copy: '<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.75"/><path d="M10.75 5.25V3.5a1.25 1.25 0 0 0-1.25-1.25h-6A1.25 1.25 0 0 0 2.25 3.5v6a1.25 1.25 0 0 0 1.25 1.25h1.75"/>',
  image: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><circle cx="5.5" cy="6.25" r="1.25"/><path d="M2 12.25l3.75-3.5 2.75 2.5 2.25-2 3.25 3"/>',
  link: '<path d="M6.75 9.25a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.85.85"/><path d="M9.25 6.75a2.6 2.6 0 0 0-3.7 0l-2.2 2.2a2.6 2.6 0 0 0 3.7 3.7l.85-.85"/>',
  bullet: '<circle cx="3" cy="4" r=".9" fill="currentColor"/><circle cx="3" cy="8" r=".9" fill="currentColor"/><circle cx="3" cy="12" r=".9" fill="currentColor"/><path d="M6.25 4h7.5M6.25 8h7.5M6.25 12h7.5"/>',
  numbered: '<path d="M2.25 2.9l1-.65v3.5M2.1 9.4c.25-.5.7-.8 1.2-.8.6 0 1.05.4 1.05.95 0 .8-1.4 1.45-2.25 2.7h2.4"/><path d="M7 4h6.75M7 8h6.75M7 12h6.75"/>',
  task: '<rect x="1.75" y="2" width="4.5" height="4.5" rx="1"/><path d="M2.85 4.3l.95.95 1.4-1.85"/><rect x="1.75" y="9.5" width="4.5" height="4.5" rx="1"/><path d="M8.5 4.25h5.25M8.5 11.75h5.25"/>',
  quote: '<path d="M2.75 3v10" stroke-width="2"/><path d="M6.25 4.5h7.5M6.25 8h7.5M6.25 11.5h5"/>',
  rule: '<path d="M1.75 8h12.5"/><path d="M4 4h8M4 12h8" opacity=".4"/>',
  codeblock: '<path d="M5.5 4.25L1.75 8l3.75 3.75M10.5 4.25L14.25 8l-3.75 3.75"/>',
  accordion: '<path d="M2.25 3l2.5 2.25-2.5 2.25"/><path d="M7.25 5.25h6.5"/><path d="M7.25 9.75h6.5M7.25 12.75h4.5" opacity=".45"/>',
  keyboard: '<rect x="1.25" y="2.75" width="13.5" height="8" rx="1.6"/><path d="M4 5.5h.01M6.67 5.5h.01M9.33 5.5h.01M12 5.5h.01M5.25 8.25h5.5" stroke-width="1.5"/><path d="M6 13l2 1.5 2-1.5"/>',
  next: '<path d="M4 2.5v6a2 2 0 0 0 2 2h7.25M10.5 7.75l2.75 2.75-2.75 2.75"/>',
  newline: '<path d="M13.25 2.75v4.75a2.25 2.25 0 0 1-2.25 2.25H2.75M5.5 7L2.75 9.75 5.5 12.5"/>',
  after: '<rect x="1.75" y="1.75" width="12.5" height="6.5" rx="1.5"/><path d="M8 10.5v4M6 12.5l2 2 2-2"/>',
  plus: '<path d="M8 2.75v10.5M2.75 8h10.5"/>',
  indent: '<path d="M7 3.5h6.75M7 8h6.75M7 12.5h6.75M1.75 5.5L4.25 8l-2.5 2.5"/>',
  outdent: '<path d="M7 3.5h6.75M7 8h6.75M7 12.5h6.75M4.25 5.5L1.75 8l2.5 2.5"/>',
  comment: '<path d="M2.25 3.75A1.5 1.5 0 0 1 3.75 2.25h8.5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5h-.25a1.5 1.5 0 0 1-1.5-1.5z"/>',
  translate: '<circle cx="8" cy="8" r="6.25"/><path d="M1.75 8h12.5M8 1.75c1.7 1.75 2.5 3.8 2.5 6.25S9.7 12.5 8 14.25M8 1.75C6.3 3.5 5.5 5.55 5.5 8s.8 4.5 2.5 6.25"/>',
  bookmark: '<path d="M4 1.75h8a.5.5 0 0 1 .5.5v12l-4.5-3.25L3.5 14.25v-12a.5.5 0 0 1 .5-.5z"/>',
  marks: '<path d="M10.25 2.25l3.5 3.5-7.5 7.5H2.75v-3.5z"/><path d="M8.75 3.75l3.5 3.5"/>',
  contents: '<path d="M5.5 3.5h8.25M5.5 8h8.25M5.5 12.5h8.25"/><path d="M2.25 3.5h.01M2.25 8h.01M2.25 12.5h.01" stroke-width="1.8"/>',
  more: '<path d="M3.25 8h.01M8 8h.01M12.75 8h.01" stroke-width="2.2"/>',
  find: '<circle cx="7" cy="7" r="4.75"/><path d="M10.5 10.5l3.75 3.75"/>',
  back: '<path d="M13.5 8H2.75M7 3.75L2.75 8 7 12.25"/>',
  paragraph: '<path d="M9.5 2.75v10.5M12.25 2.75v10.5M13.5 2.75H6.75a3 3 0 0 0 0 6H9.5"/>',
  copyAll: '<path d="M3.25 1.75h6l3.5 3.5v9H3.25z"/><path d="M5.5 7.25h5M5.5 9.5h5M5.5 11.75h3.25"/>',
  tag: '<path d="M2.25 2.25h5.5l6 6-5.5 5.5-6-6z"/><circle cx="5.25" cy="5.25" r="1"/>',
  tags: '<path d="M6.25 2.25l-1.5 11.5M11.25 2.25l-1.5 11.5M2.5 5.75h11.25M2.25 10.25H13.5"/>',
  versions: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.25 2.5v2.25H4.5"/><path d="M8 5v3.25l2.25 1.5"/>',
  stats: '<path d="M2.25 13.75h11.5"/><path d="M4 11V8M7 11V4.5M10 11V6.5M13 11V2.75" stroke-width="1.6"/>',
  source: '<path d="M5.25 4.5L1.75 8l3.5 3.5M10.75 4.5l3.5 3.5-3.5 3.5M9.25 2.75l-2.5 10.5"/>',
  visual: '<path d="M2.25 13.75h11.5"/><path d="M4.5 11.25L7.75 2.5h.5l3.25 8.75M5.6 8.25h4.8"/>',
  clear: '<path d="M6 13.75h7.75M2.6 9.4l5.9-6.15a1.4 1.4 0 0 1 2 0l2.4 2.4a1.4 1.4 0 0 1 0 2L7.1 13.75H4.9L2.6 11.4a1.4 1.4 0 0 1 0-2zM5.75 6.25l4.25 4.25"/>',
};

/** Whether there is a drawn icon by this name. */
export const hasIcon = (name) => Object.hasOwn(PATHS, name);

/** An <svg> of the named icon (decorative: the button it is in carries the words). */
export function icon(name, className = 'ico') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('class', className);
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.3');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  node.innerHTML = PATHS[name] ?? ''; // fixed markup from PATHS above, never user text
  return node;
}

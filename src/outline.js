// Table of contents for the open note: its headings, indented by level, with the section that holds
// the cursor marked. A click jumps to the heading.

import { h } from './overlays.js';
import { formatNumber } from './i18n.js';

/** Index of the last heading at or above `line`, or -1 before the first one. */
export function activeHeading(headings, line) {
  let found = -1;
  for (let i = 0; i < headings.length && headings[i].line <= line; i++) found = i;
  return found;
}

export class Outline {
  constructor(root, { onJump }) {
    this.root = root;
    this.label = root.querySelector('.outline-label');
    this.list = root.querySelector('.outline-list');
    this.onJump = onJump;
    this.headings = [];
    this.key = null;
    this.active = -1;
    this.emptyText = '';
  }

  setCopy(copy) {
    this.label.textContent = copy.outline;
    this.emptyText = copy.noHeadings;
    this.key = null;
    this.setHeadings(this.headings);
  }

  setHeadings(headings) {
    const key = headings.map((hd) => `${hd.level}|${hd.line}|${hd.words}|${hd.text}`).join('\n');
    if (key === this.key) return;
    this.key = key;
    this.headings = headings;
    const top = Math.min(...headings.map((hd) => hd.level));
    this.list.replaceChildren(
      ...headings.map((hd) => {
        const item = h(
          'li',
          { class: 'outline-item', title: hd.text },
          h('span', { class: 'outline-text' }, hd.text),
          h('span', { class: 'outline-words' }, formatNumber(hd.words)),
        );
        item.style.setProperty('--depth', String(hd.level - top));
        item.addEventListener('click', () => this.onJump(hd.line));
        return item;
      }),
    );
    if (!headings.length) this.list.append(h('li', { class: 'outline-empty' }, this.emptyText));
    this.active = -2; // force a repaint of the marker
  }

  setCursorLine(line) {
    const active = activeHeading(this.headings, line);
    if (active === this.active) return;
    this.active = active;
    [...this.list.children].forEach((li, i) => li.classList.toggle('active', i === active));
  }
}

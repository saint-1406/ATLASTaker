// The menu that slides in from the right: four sections (notes, library, settings, account), each
// drawn by the app (app.js: menuSections) every time it is shown, so it always tells what is true now.
// The notes list on the left stays where it was; this panel holds everything else.

import { h } from './overlays.js';
import { t } from './i18n.js';
import { motionOn } from './motion.js';

export const SIDE_TABS = ['notes', 'library', 'settings', 'account'];

const ICONS = {
  notes: '<path d="M4 1.75h5.5L12.5 4.75v9.5H4z M9.5 1.75v3h3 M6 8h4.5M6 10.5h4.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
  library: '<path d="M2.25 2.75h2.9v10.5h-2.9zM6.35 2.75h2.9v10.5h-2.9zM10.35 3.55l2.75-.75 2.55 10.1-2.75.75z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/>',
  settings: '<path d="M2.5 4.5h11M2.5 11.5h11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="6" cy="4.5" r="1.8" fill="var(--side-bg)" stroke="currentColor" stroke-width="1.2"/><circle cx="10.5" cy="11.5" r="1.8" fill="var(--side-bg)" stroke="currentColor" stroke-width="1.2"/>',
  account: '<circle cx="8" cy="5.5" r="2.75" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.75 14c.6-2.9 2.7-4.4 5.25-4.4s4.65 1.5 5.25 4.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
};

const svg = (inner) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('aria-hidden', 'true');
  node.innerHTML = inner; // fixed markup from ICONS above, never user text
  return node;
};

/** A row that does something: icon, words, a hint under them, a key on the right. */
export function sideItem({ icon = '', text, hint, kbd, run, disabled = false, danger = false, chevron = false }) {
  return h(
    'button',
    { type: 'button', class: `side-item${danger ? ' danger' : ''}`, disabled: disabled || null, onclick: run },
    h('span', { class: 'side-ico', 'aria-hidden': 'true' }, icon),
    h('span', { class: 'side-text' }, h('span', { class: 'side-label' }, text), hint ? h('span', { class: 'side-hint' }, hint) : null),
    kbd ? h('kbd', { class: 'side-kbd' }, kbd) : null,
    chevron ? h('span', { class: 'side-chev', 'aria-hidden': 'true' }, '›') : null,
  );
}

/** A row with a switch. */
export function sideToggle({ icon = '', text, hint, on, toggle }) {
  return h(
    'button',
    { type: 'button', class: 'side-item side-toggle', role: 'switch', 'aria-checked': String(Boolean(on)), onclick: toggle },
    h('span', { class: 'side-ico', 'aria-hidden': 'true' }, icon),
    h('span', { class: 'side-text' }, h('span', { class: 'side-label' }, text), hint ? h('span', { class: 'side-hint' }, hint) : null),
    h('span', { class: 'switch', 'aria-hidden': 'true' }, h('i')),
  );
}

/** A titled card of rows. */
export function sideGroup(title, ...rows) {
  const items = rows.flat().filter(Boolean);
  if (!items.length) return null;
  return h('section', { class: 'side-group' }, title ? h('div', { class: 'side-group-title' }, title) : null, h('div', { class: 'side-card' }, items));
}

/**
 * sections: { notes, library, settings, account }: each (close) → an array of nodes.
 * onClose: after the panel has gone (the app gives the focus back to the text).
 */
export function createSideMenu({ sections, onClose }) {
  let scrim = null;
  let tab = 'notes';
  let panel;
  let body;
  let tabBar;

  function draw() {
    if (!scrim) return;
    const top = body.scrollTop;
    const keep = body.dataset.tab === tab;
    tabBar.replaceChildren(
      ...SIDE_TABS.map((id) =>
        h(
          'button',
          { type: 'button', class: 'side-tab', role: 'tab', 'aria-selected': String(id === tab), 'data-tab': id, onclick: () => show(id) },
          svg(ICONS[id]),
          h('span', {}, t(`side.tabs.${id}`)),
        ),
      ),
    );
    // a redraw keeps the keyboard on the control just used (settings mark theirs with data-focus-key)
    const focused = keep && body.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    body.dataset.tab = tab;
    body.replaceChildren(...(sections[tab]?.(close) ?? []).filter(Boolean));
    body.scrollTop = keep ? top : 0;
    // the chosen section's background slides over to it; another section's contents come in
    tabBar.style.setProperty('--side-i', String(Math.max(0, SIDE_TABS.indexOf(tab))));
    body.classList.remove('m-switch');
    if (!keep && motionOn()) {
      void body.offsetWidth;
      body.classList.add('m-switch');
    }
    if (focused) body.querySelector(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  function show(id) {
    if (SIDE_TABS.includes(id)) tab = id;
    draw();
    tabBar.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
  }

  const onKey = (e) => {
    if (!scrim) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target.closest?.('.side-tab')) {
      e.preventDefault();
      const i = SIDE_TABS.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
      show(SIDE_TABS[(i + SIDE_TABS.length) % SIDE_TABS.length]);
    } else if (e.key === 'Tab') {
      const focusable = [...panel.querySelectorAll('button:not([disabled]), input, select')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  function open(id = tab) {
    if (SIDE_TABS.includes(id)) tab = id;
    if (scrim) {
      show(tab);
      return;
    }
    body = h('div', { class: 'side-body', role: 'tabpanel' });
    tabBar = h('div', { class: 'side-tabs', role: 'tablist', 'aria-label': t('side.title') });
    panel = h(
      'aside',
      { class: 'side', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('side.title') },
      h(
        'div',
        { class: 'side-head' },
        h('span', { class: 'side-title' }, t('side.title')),
        h('button', { type: 'button', class: 'tb-btn icon side-close', title: t('side.close'), 'aria-label': t('side.close'), onclick: () => close() }, '✕'),
      ),
      tabBar,
      body,
    );
    scrim = h('div', { class: 'side-scrim' }, panel);
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) close();
    });
    // a finger pulls it away to the right, as it came: it follows the finger, and once let go it either
    // goes (far enough, or flicked) or springs back
    let drag = null;
    panel.addEventListener(
      'touchstart',
      (e) => {
        drag = e.touches.length === 1 && !e.target.closest('input[type="range"], .side-tabs') ? { x: e.touches[0].clientX, y: e.touches[0].clientY, at: performance.now(), dx: 0, on: false } : null;
      },
      { passive: true },
    );
    panel.addEventListener(
      'touchmove',
      (e) => {
        if (!drag) return;
        const dx = e.touches[0].clientX - drag.x;
        const dy = e.touches[0].clientY - drag.y;
        if (!drag.on) {
          if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
            drag = null; // a scroll of the menu
            return;
          }
          if (dx < 10) return;
          drag.on = true;
          panel.classList.add('m-dragging');
        }
        drag.dx = Math.max(0, dx);
        panel.style.transform = `translate3d(${drag.dx}px, 0, 0)`;
        scrim.style.backgroundColor = `rgba(0, 0, 0, ${0.38 * Math.max(0, 1 - drag.dx / panel.offsetWidth)})`;
      },
      { passive: true },
    );
    const letGo = () => {
      if (!drag?.on) {
        drag = null;
        return;
      }
      const speed = drag.dx / Math.max(1, performance.now() - drag.at);
      const away = drag.dx > panel.offsetWidth * 0.33 || (speed > 0.6 && drag.dx > 40);
      panel.classList.remove('m-dragging');
      panel.style.transform = '';
      scrim.style.backgroundColor = '';
      drag = null;
      if (away) close();
    };
    panel.addEventListener('touchend', letGo);
    panel.addEventListener('touchcancel', letGo);
    document.getElementById('overlays').append(scrim);
    document.addEventListener('keydown', onKey, true);
    draw();
    requestAnimationFrame(() => {
      scrim?.classList.add('open');
      tabBar.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
    });
  }

  /** then: something to do once the panel is gone (open a dialog, the library…). */
  function close(then) {
    if (!scrim) {
      then?.();
      return;
    }
    const leaving = scrim;
    scrim = null;
    document.removeEventListener('keydown', onKey, true);
    leaving.classList.remove('open');
    leaving.classList.add('leaving');
    setTimeout(() => leaving.remove(), 220);
    if (then) then();
    else onClose?.();
  }

  return {
    open,
    close,
    toggle: (id) => (scrim && (!id || id === tab) ? close() : open(id)),
    isOpen: () => Boolean(scrim),
    /** Something it shows has changed (a sign-in, the language): draw it again if it is open. */
    refresh: () => draw(),
  };
}

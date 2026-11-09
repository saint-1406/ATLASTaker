// The app's motion: how screens change, how a press answers, how lists come in. The tokens (curves,
// durations) are CSS variables in styles.css ("motion tokens"); this file holds the moves that need a
// script. Everything here gives way to the system's "reduce motion" and to the person's own switch
// (Settings → Animations, kept on this device): then the app changes at once, as it did before.

const KEY = 'atlas-motion';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const root = document.documentElement;

function readFlag() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

let enabled = readFlag();
root.dataset.motion = enabled ? 'on' : 'off';

/** Is the app to move now? Not when the system asks for less motion or the person turned it off. */
export const motionOn = () => enabled && !reduced.matches;

export const motionEnabled = () => enabled;

/** The person's switch (Settings → Animations). */
export function setMotion(on) {
  enabled = Boolean(on);
  root.dataset.motion = enabled ? 'on' : 'off';
  try {
    if (enabled) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'off');
  } catch {
    // only a convenience
  }
}

const canTransition = () => typeof document.startViewTransition === 'function';
let running = null;

/**
 * Changes the screen with the old and the new one overlapping: the old one goes a little the other
 * way and fades, the new one comes in from the side it lies on (dir: 'forward' | 'back' | 'up' |
 * 'fade'). update() does the change itself, as it would without motion. A change asked for while
 * another runs ends that one at once, so quick taps never queue up.
 */
export function navigate(dir, update) {
  if (!motionOn() || !canTransition()) {
    update();
    return Promise.resolve();
  }
  running?.skipTransition?.();
  root.dataset.nav = dir;
  let transition;
  try {
    transition = document.startViewTransition(() => update());
  } catch {
    delete root.dataset.nav;
    update();
    return Promise.resolve();
  }
  running = transition;
  // a transition skipped by a quicker one rejects these: expected, nothing to report
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});
  return transition.finished
    .catch(() => {})
    .finally(() => {
      if (running === transition) {
        running = null;
        delete root.dataset.nav;
      }
    });
}

/**
 * The items of a list come in one after another, a few tens of ms apart — the first time the list
 * shows (key: what it shows; the same key again does nothing, so scrolling or a redraw do not
 * replay it). Only the first `max` items move; the rest are there at once.
 */
const staggered = new WeakMap();
export function stagger(container, key = 'first', { max = 12, step = 45 } = {}) {
  if (!container) return;
  if (staggered.get(container) === key) return;
  staggered.set(container, key);
  if (!motionOn()) return;
  const items = [...container.children].filter((el) => !el.hidden).slice(0, max);
  items.forEach((el, i) => {
    el.style.setProperty('--m-i', String(i));
    el.style.setProperty('--m-step', `${step}ms`);
    el.classList.remove('m-in');
    // the class comes on in the next frame, so a list drawn again starts its entrance afresh
  });
  requestAnimationFrame(() => {
    for (const el of items) el.classList.add('m-in');
    // the class leaves once the entrance is over: hover and press transforms are theirs again
    setTimeout(() => {
      for (const el of items) el.classList.remove('m-in');
    }, step * items.length + 700);
  });
}

/** Lets a list come in again next time (another folder, another search). */
export const restagger = (container) => staggered.delete(container);

/**
 * Names elements for one transition, so the screen change moves each of them from where it was to
 * where it is (a card growing into the editor, books finding their new places after a filter).
 * name(el) → a name, or '' to leave it out. The names go once the transition has finished.
 */
export function shared(elements, name) {
  const named = [];
  for (const el of elements) {
    const id = name(el);
    if (!id) continue;
    el.style.viewTransitionName = id;
    named.push(el);
  }
  return () => {
    for (const el of named) el.style.viewTransitionName = '';
  };
}

/** A name a view transition takes: letters, digits, - and _ only. */
export const transitionName = (prefix, id) => `${prefix}-${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

// A press answers at once: on a touch screen :active comes late or not at all, so the pressed
// element gets .m-press for as long as the finger is down (styles.css draws it).
const PRESSABLE = 'button, [role="button"], .lib-card, .notes-card, .home-book, .home-tile, .lib-pocket, .lib-chip, .side-item, .ctx-item, a.btn';
let pressed = null;
function release() {
  pressed?.classList.remove('m-press');
  pressed = null;
}
document.addEventListener(
  'pointerdown',
  (event) => {
    if (event.button !== 0) return;
    const el = event.target.closest?.(PRESSABLE);
    if (!el || el.disabled) return;
    release();
    pressed = el;
    el.classList.add('m-press');
  },
  { capture: true, passive: true },
);
for (const type of ['pointerup', 'pointercancel', 'dragstart']) document.addEventListener(type, release, { capture: true, passive: true });
// a press that turns into a scroll is no press
document.addEventListener('scroll', release, { capture: true, passive: true });

/**
 * A list drawn again (a filter, a search) without a jump: items that stay glide from where they were
 * to where they are now, new ones fade up in. Items are known by `key(el)` (a book's or a note's id).
 * redraw() replaces the list. The page is not frozen meanwhile, so typing in a search stays quick.
 */
export function flip(container, key, redraw) {
  if (!container || !motionOn()) {
    redraw();
    return;
  }
  const before = new Map();
  for (const el of container.children) {
    const id = key(el);
    if (id) before.set(id, el.getBoundingClientRect());
  }
  redraw();
  const items = [...container.children];
  let fresh = 0;
  for (const el of items) {
    const id = key(el);
    const was = id ? before.get(id) : null;
    if (!was) {
      if (fresh < 10) el.animate([{ opacity: 0, transform: 'translate3d(0, 10px, 0) scale(0.97)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 30 * fresh, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' });
      fresh++;
      continue;
    }
    const now = el.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }
}

/** A short pulse on an element (a count changed, something was added): it swells and settles. */
export function pulse(el) {
  if (!el || !motionOn()) return;
  el.classList.remove('m-pulse');
  void el.offsetWidth;
  el.classList.add('m-pulse');
  el.addEventListener('animationend', () => el.classList.remove('m-pulse'), { once: true });
}

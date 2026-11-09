// An easter egg: "I love cats" typed into the notes search and sent (Enter, or "Go" on a phone) lets
// a cat run across the screen — paw prints, one after another — and the app turns into its cat look:
// night-violet and peach, striped fur on the cards, ears on the round buttons, a black cat peeking over
// the tab bar. The look is in no menu. Typing the words again, or choosing any theme, ends it.
// Kept on this device only.

import { motionOn } from './motion.js';

const KEY = 'atlas-easter';
const root = document.documentElement;

/** Did the person type the words? Spaces and case do not matter. */
export const isCatWords = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === 'i love cats';

export const catsOn = () => root.dataset.easter === 'cats';

// a paw print: the big pad and four toe beans (drawn for this app)
const PAW =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 14.5c-4.6 0-8.4 3.9-8.4 7.6 0 2.6 2 4.2 4.4 4.2 1.7 0 2.6-.8 4-.8s2.3.8 4 .8c2.4 0 4.4-1.6 4.4-4.2 0-3.7-3.8-7.6-8.4-7.6z"/><ellipse cx="7.2" cy="12.4" rx="2.6" ry="3.3" transform="rotate(-24 7.2 12.4)"/><ellipse cx="12.6" cy="7.6" rx="2.7" ry="3.5" transform="rotate(-8 12.6 7.6)"/><ellipse cx="19.4" cy="7.6" rx="2.7" ry="3.5" transform="rotate(8 19.4 7.6)"/><ellipse cx="24.8" cy="12.4" rx="2.6" ry="3.3" transform="rotate(24 24.8 12.4)"/></svg>';

// the black cat that peeks over the tab bar: a round head, two ears, big white eyes (drawn for this app)
const PEEK =
  '<svg viewBox="0 0 120 64" aria-hidden="true"><path class="cat-body" d="M14 64C14 38 32 20 60 20s46 18 46 44z"/><path class="cat-body" d="M24 34 22 6l24 16zM96 34l2-28-24 16z"/><path class="cat-ear" d="M27 26 26 13l11 8zM93 26l1-13-11 8z"/><g class="cat-eyes"><ellipse cx="45" cy="44" rx="10" ry="11"/><ellipse cx="75" cy="44" rx="10" ry="11"/></g><g class="cat-pupils"><circle cx="47" cy="46" r="5.2"/><circle cx="77" cy="46" r="5.2"/></g><path class="cat-whisk" d="M30 52 12 50M30 56l-17 3M90 52l18-2M90 56l17 3"/></svg>';

let peek = null;
let lifeTimer = 0;

// The cat blinks now and then and looks about: short moves at random moments, not an endless
// animation, which would keep the phone drawing every frame for nothing.
function live() {
  clearTimeout(lifeTimer);
  if (!peek) return;
  lifeTimer = setTimeout(() => {
    if (!peek) return;
    if (document.visibilityState === 'visible' && motionOn()) {
      const move = Math.random() < 0.65 ? 'blink' : Math.random() < 0.5 ? 'look-left' : 'look-right';
      peek.classList.add(move);
      setTimeout(() => peek?.classList.remove(move), move === 'blink' ? 180 : 1400);
    }
    live();
  }, 2500 + Math.random() * 4000);
}

function setPeek(on) {
  if (!on) {
    clearTimeout(lifeTimer);
    peek?.remove();
    peek = null;
    return;
  }
  if (peek) return;
  peek = document.createElement('button');
  peek.type = 'button';
  peek.className = 'cat-peek';
  peek.setAttribute('aria-label', 'meow');
  peek.innerHTML = PEEK;
  // a tap: it ducks and comes back
  peek.addEventListener('click', () => {
    peek.classList.remove('ducking');
    void peek.offsetWidth;
    peek.classList.add('ducking');
  });
  document.body.append(peek);
  live();
}

/** The cat look on or off, kept on this device. */
export function setCats(on, { save = true } = {}) {
  if (on) root.dataset.easter = 'cats';
  else delete root.dataset.easter;
  setPeek(on);
  if (!save) return;
  try {
    if (on) localStorage.setItem(KEY, 'cats');
    else localStorage.removeItem(KEY);
  } catch {
    // only a convenience
  }
}

/** On start: the look as it was left. */
export function restoreCats() {
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // a private window
  }
  if (saved === 'cats') setCats(true, { save: false });
}

/**
 * The run: paw prints across the screen from the lower left to the upper right, left and right paws
 * by turns, each fading after a moment. Resolves with where the last print fell, when the cat is gone.
 */
export function runPaws() {
  return new Promise((resolve) => {
    const w = innerWidth;
    const h = innerHeight;
    if (!motionOn()) {
      resolve({ x: w / 2, y: h / 2 });
      return;
    }
    const layer = document.createElement('div');
    layer.className = 'cat-run';
    layer.setAttribute('aria-hidden', 'true');
    document.body.append(layer);
    const steps = Math.max(9, Math.min(16, Math.round(Math.hypot(w, h) / 70)));
    const start = { x: -20, y: h * 0.86 };
    const end = { x: w + 20, y: h * 0.12 };
    const angle = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI + 90;
    let last = { x: w / 2, y: h / 2 };
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      // a gentle wave in the path, and the paws a little to each side of it
      const nx = -(end.y - start.y);
      const ny = end.x - start.x;
      const len = Math.hypot(nx, ny) || 1;
      const side = (i % 2 ? 1 : -1) * 14 + Math.sin(t * Math.PI * 2) * 26;
      const x = start.x + (end.x - start.x) * t + (nx / len) * side;
      const y = start.y + (end.y - start.y) * t + (ny / len) * side;
      const paw = document.createElement('span');
      paw.className = 'cat-paw';
      paw.innerHTML = PAW;
      paw.style.left = `${x}px`;
      paw.style.top = `${y}px`;
      paw.style.setProperty('--turn', `${angle + (i % 2 ? 8 : -8)}deg`);
      paw.style.animationDelay = `${i * 85}ms`;
      layer.append(paw);
      last = { x: Math.max(0, Math.min(w, x)), y: Math.max(0, Math.min(h, y)) };
    }
    setTimeout(() => resolve(last), steps * 85 + 120);
    setTimeout(() => layer.remove(), steps * 85 + 1400);
  });
}

/**
 * The words were typed: the cat runs, then the look changes — spreading out from the last paw print
 * (where the browser can draw that), or at once. Typed again: the look goes back the same way.
 */
export async function catWords() {
  const on = !catsOn();
  const at = on ? await runPaws() : { x: innerWidth / 2, y: innerHeight / 2 };
  root.style.setProperty('--cat-x', `${Math.round(at.x)}px`);
  root.style.setProperty('--cat-y', `${Math.round(at.y)}px`);
  if (motionOn() && typeof document.startViewTransition === 'function') {
    root.dataset.catReveal = '';
    const transition = document.startViewTransition(() => setCats(on));
    transition.ready.catch(() => {});
    transition.updateCallbackDone.catch(() => {});
    transition.finished.catch(() => {}).finally(() => delete root.dataset.catReveal);
    await transition.finished.catch(() => {});
  } else setCats(on);
  return on;
}

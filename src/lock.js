// The PIN lock: the app opens behind a screen that asks for the PIN, and closes behind it again when it
// has been away for a while (in the background, or minimised). Only a salted PBKDF2 hash of the PIN is
// kept (state.pinLock, on this device only: not synced). It keeps the notes from other eyes in the app;
// the files on the disk are not encrypted by it.

import { h, openDialog, toast } from './overlays.js';
import { t } from './i18n.js';

export const PIN_RE = /^\d{4,8}$/;
export const LOCK_AFTER = [0, 60, 300, 900]; // seconds away before the lock closes again
const ITERATIONS = 150_000;
const HINT_KEY = 'atlas-notetaker:pin'; // "a PIN is set": the screen is covered before the state loads
const FAILS_KEY = 'atlas-notetaker:pin-fails'; // { count, until }: wrong PINs in a row, and the wait
const FREE_TRIES = 5;

const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function derive(pin, salt, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}

/** What is kept of a new PIN: { salt, hash, iter, len, after }. */
export async function hashPin(pin, after = 0, iter = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: toB64(salt), hash: toB64(await derive(pin, salt, iter)), iter, len: pin.length, after };
}

/** Is this the PIN kept in `lock`? Compared byte by byte to the end, whatever differs. */
export async function checkPin(pin, lock) {
  if (!lock || !PIN_RE.test(pin)) return false;
  const want = fromB64(lock.hash);
  const got = await derive(pin, fromB64(lock.salt), lock.iter);
  let diff = want.length ^ got.length;
  for (let i = 0; i < want.length; i++) diff |= want[i] ^ (got[i] ?? 0);
  return diff === 0;
}

/** The wait after `count` wrong PINs in a row: none for the first few, then 30 s doubling up to 15 min. */
export function waitAfter(count) {
  if (count < FREE_TRIES) return 0;
  return Math.min(15 * 60, 30 * 2 ** (count - FREE_TRIES)) * 1000;
}

const kept = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // only a convenience: without it the screen is covered a moment later, when the state loads
    }
  },
};

/** Covers the page at once when this device has a PIN, before anything of the notes is drawn. */
export function coverEarly() {
  if (kept.get(HINT_KEY, false)) document.documentElement.classList.add('locked');
}

/** getLock(): the kept lock or null. The screen is built once and shown over everything. */
export function createLock({ getLock }) {
  // hashing needs crypto.subtle (a secure page: 127.0.0.1, the Android app, a file)
  const canLock = typeof crypto === 'object' && Boolean(crypto.subtle);
  let locked = false;
  let entered = '';
  let hiddenAt = 0;
  let checking = false;

  const dots = h('div', { class: 'lock-dots', 'aria-hidden': 'true' });
  const message = h('p', { class: 'lock-msg', role: 'status', 'aria-live': 'polite' });
  const title = h('h2', { class: 'lock-title' });
  const keys = h('div', { class: 'lock-keys' });
  const box = h('div', { class: 'lock-box' }, h('div', { class: 'lock-icon', 'aria-hidden': 'true' }, '🔒'), title, dots, message, keys);
  const screen = h('div', { class: 'lock-screen', hidden: true, role: 'dialog', 'aria-modal': 'true' }, box);
  document.body.append(screen);

  const key = (label, run, cls = '') => {
    const b = h('button', { type: 'button', class: `lock-key ${cls}`.trim() }, label);
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', run);
    return b;
  };
  const erase = key('⌫', () => back(), 'lock-back');
  keys.append(...'123456789'.split('').map((d) => key(d, () => press(d))), h('span'), key('0', () => press('0')), erase);

  const length = () => getLock()?.len ?? 4;

  function draw() {
    title.textContent = t('lock.title');
    erase.setAttribute('aria-label', t('lock.erase'));
    erase.title = t('lock.erase');
    dots.replaceChildren(...Array.from({ length: length() }, (_, i) => h('i', { class: i < entered.length ? 'on' : '' })));
    const wait = kept.get(FAILS_KEY, { count: 0, until: 0 }).until - Date.now();
    if (wait > 0) message.textContent = t('lock.wait', Math.ceil(wait / 1000));
  }

  function press(digit) {
    if (checking || entered.length >= length()) return;
    entered += digit;
    message.textContent = '';
    draw();
    if (entered.length === length()) attempt();
  }

  function back() {
    entered = entered.slice(0, -1);
    draw();
  }

  async function attempt() {
    const fails = kept.get(FAILS_KEY, { count: 0, until: 0 });
    if (fails.until > Date.now()) {
      entered = '';
      draw();
      return;
    }
    checking = true;
    const ok = await checkPin(entered, getLock()).catch(() => false);
    checking = false;
    entered = '';
    if (ok) {
      kept.set(FAILS_KEY, null);
      unlock();
      return;
    }
    const count = fails.count + 1;
    kept.set(FAILS_KEY, { count, until: Date.now() + waitAfter(count) });
    box.classList.remove('shake');
    void box.offsetWidth; // the shake plays again on every wrong PIN
    box.classList.add('shake');
    message.textContent = t('lock.wrong');
    draw();
  }

  // while locked, the keyboard types the PIN and reaches nothing else
  window.addEventListener(
    'keydown',
    (e) => {
      if (!locked) return;
      e.stopPropagation();
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') back();
      if (e.key !== 'Tab') e.preventDefault();
    },
    true,
  );

  function lock() {
    if (!getLock() || !canLock) return;
    locked = true;
    entered = '';
    message.textContent = '';
    document.documentElement.classList.add('locked');
    document.activeElement?.blur?.();
    screen.hidden = false;
    draw();
  }

  function unlock() {
    locked = false;
    entered = '';
    screen.hidden = true;
    document.documentElement.classList.remove('locked');
  }

  // away and back: the lock closes again after the time chosen (at once: already while going away, so
  // the phone's list of recent apps shows the lock, not the note)
  document.addEventListener('visibilitychange', () => {
    const pin = getLock();
    if (!pin) return;
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      if (!pin.after) lock();
    } else if (hiddenAt && Date.now() - hiddenAt >= pin.after * 1000) lock();
  });

  return {
    canLock,
    isLocked: () => locked,
    /** The state has loaded: covered if this device has a PIN, uncovered if not. */
    start() {
      const pin = getLock();
      kept.set(HINT_KEY, pin ? true : null);
      if (pin && canLock) lock();
      else unlock();
    },
    lock,
    /** A PIN was set, changed or taken off. */
    changed() {
      kept.set(HINT_KEY, getLock() ? true : null);
    },
  };
}

/** Asks for a PIN in a dialog: resolves with the digits, or null when cancelled. */
export function askPin({ title, text = '', confirmLabel = null }) {
  return new Promise((resolve) => {
    openDialog(
      (dialog, close) => {
        const input = h('input', {
          class: 'field lock-field',
          type: 'password',
          inputmode: 'numeric',
          pattern: '[0-9]*',
          maxlength: '8',
          autocomplete: 'off',
          'data-autofocus': true,
          'aria-label': title,
        });
        const done = () => {
          if (!PIN_RE.test(input.value)) {
            toast(t('lock.digits'));
            return;
          }
          close(input.value);
        };
        input.addEventListener('input', () => (input.value = input.value.replace(/\D/g, '').slice(0, 8)));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            done();
          }
        });
        dialog.append(
          h('div', { class: 'modal-kicker' }, t('lock.kicker')),
          h('h2', { class: 'modal-title' }, title),
          text ? h('p', { class: 'modal-text' }, text) : null,
          input,
          h(
            'div',
            { class: 'modal-actions' },
            h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, t('dialog.cancel')),
            h('button', { type: 'button', class: 'btn primary', onclick: done }, confirmLabel ?? t('lock.next')),
          ),
        );
      },
      { onClose: (v) => resolve(typeof v === 'string' ? v : null) },
    );
  });
}

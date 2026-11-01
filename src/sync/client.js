// The page's side of sync: when to run a round, what the settings show, and telling the rest of the
// app what came in. The rounds themselves run where the data is — the local server on Windows,
// the page on Android — behind api.sync: { status, signIn, cancel, signOut, run }.

import { count, formatDay, formatTime, t } from '../i18n.js';

const AFTER_EDIT = 30_000; // a round this long after the last change
const EVERY = 10 * 60_000; // and now and then while the window is open
const ON_RETURN = 2 * 60_000; // coming back to the window, if the last round is older than this

/**
 * beforeRound(): saves what is being typed. openDocs(): ids of documents open in the reader.
 * afterRound(result): reloads what came in. h: overlays' element helper. toast: a short message.
 */
export function createSyncClient({ api, beforeRound, openDocs, afterRound, h, toast }) {
  if (!api.sync) return null;
  let status = { available: false, signedIn: false };
  let timer = 0;
  let polling = 0;
  let round = null;
  let note = ''; // the last round's trouble, in words
  let panel = null;

  async function refreshStatus() {
    try {
      status = await api.sync.status();
    } catch {
      // the server is restarting: keep what we knew
    }
    draw();
    return status;
  }

  async function run({ quiet = true } = {}) {
    if (!status.signedIn || round) return round;
    round = (async () => {
      draw(true);
      try {
        await beforeRound();
        const first = !status.lastSync;
        const result = { ...(await api.sync.run({ skipDocs: openDocs() })), first };
        if (!result.ok) {
          note = result.auth ? t('sync.expired') : result.offline ? t('sync.offline') : t('sync.failed', result.error);
          if (!quiet || result.auth) toast(note, { timeout: 7000 });
          return result;
        }
        note = '';
        await afterRound(result);
        if (!quiet && !result.pulled.length && !result.trashed.length) toast(t('sync.done'), { timeout: 2500 });
        else if (result.pulled.length) toast(t('sync.pulled', count(result.pulled.length, 'note')), { timeout: 3500 });
        return result;
      } catch (err) {
        note = t('sync.failed', err.message);
        if (!quiet) toast(note, { timeout: 7000 });
        return null;
      } finally {
        round = null;
        await refreshStatus();
      }
    })();
    return round;
  }

  /** Something changed here: a round soon, once the typing settles. */
  function changed() {
    if (!status.signedIn) return;
    clearTimeout(timer);
    timer = setTimeout(() => run(), AFTER_EDIT);
  }

  // every change that reaches storage asks for a round soon
  const watch = (owner, names) => {
    for (const name of names) {
      const fn = owner?.[name];
      if (typeof fn !== 'function') continue;
      owner[name] = async (...args) => {
        const out = await fn.apply(owner, args);
        changed();
        return out;
      };
    }
  };
  watch(api, ['create', 'write', 'trash', 'saveAsset']);
  watch(api.library, ['add', 'update', 'replace', 'remove']);

  async function signIn() {
    note = '';
    try {
      // Windows: the server opens the system browser; Android: Google's own sign-in sheet
      await api.sync.signIn();
    } catch (err) {
      note = t('sync.failed', err.message);
      draw();
      return;
    }
    await refreshStatus();
    // the browser does the rest; look in until the account shows up
    clearInterval(polling);
    const until = Date.now() + 10 * 60_000;
    polling = setInterval(async () => {
      const s = await refreshStatus();
      if (s.signedIn && !s.signingIn) {
        clearInterval(polling);
        toast(t('sync.welcome', s.email), { timeout: 4000 });
        run();
      } else if (!s.signingIn || Date.now() > until) clearInterval(polling);
    }, 1500);
  }

  async function cancel() {
    clearInterval(polling);
    await api.sync.cancel?.().catch(() => {});
    await refreshStatus();
  }

  async function signOut() {
    clearTimeout(timer);
    await api.sync.signOut().catch(() => {});
    note = t('sync.signedOut');
    await refreshStatus();
  }

  const when = (ms) => (new Date(ms).toDateString() === new Date().toDateString() ? formatTime(ms) : `${formatDay(ms)} ${formatTime(ms)}`);

  /** The settings group, kept up to date while the dialog is open. */
  function draw(busy = Boolean(round)) {
    if (!panel?.isConnected) return;
    const button = (text, run, primary = false) => h('button', { type: 'button', class: `seg-btn${primary ? ' primary' : ''}`, onclick: run }, text);
    const lines = [];
    const actions = [];
    if (!status.available) {
      lines.push(t('sync.unavailable'));
    } else if (status.signingIn) {
      lines.push(t('sync.signingIn'));
      actions.push(button(t('sync.cancel'), cancel));
    } else if (!status.signedIn) {
      lines.push(t('sync.about'));
      actions.push(button(t('sync.signIn'), signIn, true));
    } else {
      lines.push(t('sync.signedIn', status.email || '—'));
      lines.push(busy ? t('sync.running') : status.lastSync ? t('sync.lastSync', when(status.lastSync)) : t('sync.never'));
      if (status.needsLogin) {
        lines.push(t('sync.expired'));
        actions.push(button(t('sync.signIn'), signIn, true));
      }
      actions.push(button(t('sync.now'), () => run({ quiet: false })));
      actions.push(button(t('sync.signOut'), signOut));
    }
    if (note && !status.signingIn) lines.push(note);
    panel.replaceChildren(
      h('div', { class: 'set-label' }, t('sync.title')),
      ...lines.map((line) => h('div', { class: 'set-note' }, line)),
      h('div', { class: 'set-actions' }, actions),
    );
    for (const b of panel.querySelectorAll('button')) b.disabled = busy && b.textContent === t('sync.now');
  }

  function section() {
    panel ??= h('section', { class: 'set-group set-sync' });
    draw();
    refreshStatus();
    return panel;
  }

  async function start() {
    await refreshStatus();
    if (status.signedIn) run();
    setInterval(() => run(), EVERY);
    let away = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) away = Date.now();
      else if (away && Date.now() - (status.lastSync || 0) > ON_RETURN) run();
    });
  }

  return { start, changed, run: () => run({ quiet: false }), section, signedIn: () => status.signedIn };
}

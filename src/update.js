// Updates. On Android the app asks GitHub for a newer version and, when the person says so, downloads
// it, checks it (size, SHA-256, package, version, signing key: Updater.java) and opens Android's
// installer, which puts it over this one — everything written and read stays. What is being typed is
// saved, and synced when sync is on, before the installer opens. On Windows the local server asks GitHub
// (server/server.js, /api/update) and the app points to the release page.

import { formatDay, t } from './i18n.js';

const CHECK_KEY = 'atlas-notetaker:update-checked';
const DAY = 24 * 60 * 60 * 1000;

/**
 * android: window.AtlasAndroid or null; api: the bridge (api.update() on Windows); beforeInstall():
 * saves and syncs; h, toast: overlays'. Returns { start, event, section, check } or null where nothing updates.
 */
export function createUpdater({ api, android, beforeInstall, h, toast }) {
  const canAndroid = Boolean(android?.checkUpdate && android?.installUpdate);
  if (!canAndroid && !api.update) return null;
  let latest = null; // { version, current, newer, size, notes, page }
  let checking = false;
  let installing = false;
  let note = '';
  let panel = null;
  let waitingForPermission = false; // Android's settings are open for "install unknown apps"
  let retrying = false; // the try made by itself on coming back from those settings
  let phase = ''; // 'download' while the file comes and is checked, 'installer' once Android's installer opens
  let pendingCheck = null;

  const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  function remember() {
    try {
      localStorage.setItem(CHECK_KEY, String(Date.now()));
    } catch {
      // only a convenience
    }
  }

  function lastCheck() {
    try {
      return Number(localStorage.getItem(CHECK_KEY)) || 0;
    } catch {
      return 0;
    }
  }

  /** Asks for the newest version; quiet: says something only when there is one. */
  async function check({ quiet = false } = {}) {
    if (checking) return;
    checking = true;
    note = '';
    draw();
    if (canAndroid) {
      // the answer comes back as an event (below)
      pendingCheck = { quiet };
      android.checkUpdate();
      return;
    }
    try {
      took(await api.update(), { quiet });
    } catch (err) {
      checking = false;
      note = t('update.failed.check', err.message);
      if (!quiet) toast(note, { timeout: 6000 });
      draw();
    }
  }

  function took(found, { quiet }) {
    checking = false;
    remember();
    latest = found;
    if (found.newer) {
      note = '';
      toast(t('update.available', found.version), { timeout: 10_000, action: { text: t(canAndroid ? 'update.install' : 'update.download'), run: install } });
    } else {
      note = t('update.latest', found.current || found.version);
      if (!quiet) toast(note, { timeout: 3000 });
    }
    draw();
  }

  /** Android: save, sync, download, check, install. Windows: the release page. */
  async function install() {
    if (!latest?.newer) return;
    if (!canAndroid) {
      if (latest.page) api.openExternal(latest.page);
      return;
    }
    if (installing) return;
    installing = true;
    phase = 'download';
    note = t('update.saving');
    draw();
    toast(note, { timeout: 60_000 });
    try {
      await beforeInstall();
    } catch {
      // saving is retried by the app itself; the update goes on, it overwrites none of it
    }
    note = t('update.downloading', 0);
    draw();
    android.installUpdate(true);
  }

  /** What the Android side reports (MainActivity → window.__atlas.updateEvent). */
  function event(e) {
    switch (e?.type) {
      case 'check':
        took(e, { quiet: pendingCheck?.quiet ?? false });
        pendingCheck = null;
        break;
      case 'progress': {
        const percent = e.total ? Math.min(100, Math.round((e.done / e.total) * 100)) : 0;
        note = t('update.downloading', percent);
        toast(note, { timeout: 60_000 });
        draw();
        break;
      }
      case 'verified':
        phase = 'installer';
        retrying = false;
        note = t('update.verified', e.version);
        toast(note, { timeout: 8000 });
        draw();
        break;
      case 'permission':
        // Android's settings open; coming back from them, the installer is tried once more by itself
        // after the try made by itself, the settings are not opened again: the person taps "Update" when ready
        installing = false;
        waitingForPermission = !retrying;
        retrying = false;
        note = t('update.permission');
        toast(note, { timeout: 15_000 });
        draw();
        break;
      case 'error': {
        const quietCheck = e.step === 'check' && pendingCheck?.quiet;
        installing = false;
        retrying = false;
        phase = '';
        checking = false;
        pendingCheck = null;
        note = t(`update.failed.${['check', 'download', 'verify', 'install'].includes(e.step) ? e.step : 'install'}`, e.message || '');
        if (!quietCheck) toast(note, { timeout: 10_000 });
        draw();
        break;
      }
      default:
    }
  }

  // back in the app: from Android's settings, the installer is tried once more (without reopening the
  // settings if permission is still off); from a cancelled installer, the button works again
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !canAndroid) return;
    if (waitingForPermission) {
      waitingForPermission = false;
      retrying = true;
      installing = true;
      android.installUpdate(false);
      return;
    }
    if (installing && phase === 'installer') {
      installing = false;
      phase = '';
    }
    draw();
  });

  /** The settings group (the account tab): this version, the newest one, the buttons. */
  function draw() {
    if (!panel?.isConnected) return;
    const button = (text, run, primary = false) => h('button', { type: 'button', class: `seg-btn${primary ? ' primary' : ''}`, onclick: run }, text);
    const current = canAndroid ? android.appVersion?.() || '' : latest?.current || '';
    const lines = [];
    if (current) lines.push(t('update.current', current));
    if (latest?.newer) lines.push(t('update.available', latest.version) + (latest.size ? ` · ${megabytes(latest.size)}` : ''));
    if (note) lines.push(note);
    const last = lastCheck();
    if (!latest && last) lines.push(t('update.lastCheck', formatDay(last)));
    const actions = [];
    if (latest?.newer) actions.push(button(t(canAndroid ? 'update.install' : 'update.download'), install, true));
    actions.push(button(checking ? t('update.checking') : t('update.check'), () => check()));
    const children = [
      h('div', { class: 'set-label' }, t('update.title')),
      ...lines.map((line) => h('div', { class: 'set-note' }, line)),
      latest?.newer && latest.notes ? h('details', { class: 'set-note update-notes' }, h('summary', {}, t('update.whatsNew')), h('pre', {}, latest.notes.slice(0, 4000))) : null,
      h('div', { class: 'set-actions' }, actions),
    ];
    panel.replaceChildren(...children.filter(Boolean));
    for (const b of panel.querySelectorAll('button')) b.disabled = (checking && b.textContent === t('update.checking')) || (installing && b.classList.contains('primary'));
  }

  function section() {
    panel ??= h('section', { class: 'set-group set-update' });
    draw();
    return panel;
  }

  /** Once a day, a while after start, quietly: a word only when there is something new. */
  function start() {
    if (Date.now() - lastCheck() < DAY) return;
    setTimeout(() => check({ quiet: true }), 15_000);
  }

  return { start, event, section, check: () => check() };
}

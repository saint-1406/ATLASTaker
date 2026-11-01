// ATLAS Notetaker, renderer entry point: wires the editor, the chrome around it (in one of two looks)
// and keeps every keystroke saved.

import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { android, api, rescue } from './bridge.js';
import { createLibrary } from './library.js';
import { createEditor, insertComment, insertCodeBlock, insertDictation, pasteText, codeLanguageAt, showDictationPreview, urlAt } from './editor.js';
import { createDictation } from './dictation.js';
import { createTranslator } from './translateCard.js';
import { analyze, imageRefs } from './markdown.js';
import { commentTarget, commentsUnder, formatStamp } from './comments.js';
import { normalizeLook, normalizeReading, PALETTES, toneOf } from './skins.js';
import { browserLanguages, count, formatDay, formatTime, isLang, pickLang, setLang, t, ui } from './i18n.js';
import { Outline } from './outline.js';
import { hashString } from './terrain.js';
import { TerrainView } from './terrainView.js';
import { AtlasView, readAtlasPalette } from './atlasView.js';
import { drawIslandThumb } from './archipelago.js';
import {
  h,
  showMenu,
  openCommentDialog,
  confirmDialog,
  commandPalette,
  settingsSection,
  openRestoreDialog,
  showImage,
  toast,
  isOverlayOpen,
  showBlocker,
} from './overlays.js';
import { fileNameFor, makeZip } from './backup.js';
import { createSyncClient } from './sync/client.js';
import { createSideMenu, sideGroup, sideItem, sideToggle } from './sidemenu.js';
import { openAppearance } from './appearance.js';
import welcomeText from './welcome.md';
import welcomeBrowserText from './welcome-browser.md';
import welcomeAndroidText from './welcome-android.md';
import welcomeTextEn from './welcome-en.md';
import welcomeBrowserTextEn from './welcome-browser-en.md';
import welcomeAndroidTextEn from './welcome-android-en.md';
import { avatarNode, drawHome, shrinkPicture } from './home.js';

const $ = (sel) => document.querySelector(sel);
const WELCOME = {
  ru: { server: welcomeText, browser: welcomeBrowserText, android: welcomeAndroidText },
  en: { server: welcomeTextEn, browser: welcomeBrowserTextEn, android: welcomeAndroidTextEn },
};
const SAVE_DELAY = 400;
const LOOK_KEY = 'atlas-notetaker:look';
const BACKUP_EVERY = 7 * 24 * 60 * 60 * 1000;
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const narrow = matchMedia('(max-width: 820px)'); // the list becomes a panel that slides over the text
const inBrowser = api.kind !== 'server'; // the single-file build: notes live in this browser

const notes = new Map(); // id → { id, content, created, updated, cursor, scroll, info }
const editorStates = new Map(); // id → EditorState, keeps undo history while the window is open
const indexItems = new Map(); // id → <li>
const cached = cachedLook();
// a cached look without a language is someone who used ATLAS when it spoke only Russian
const prefs = {
  ...normalizeLook(cached),
  lang: pickLang({ saved: cached.lang, existing: Boolean(cached.skin), preferred: browserLanguages() }),
  sidebar: true,
  fontScale: 1,
  ...normalizeReading(),
};
let currentId = null;
let dirty = false;
let focusMode = false;
let suspended = false; // another window took over
let lost = false; // the server is gone or restarted
let trashing = null; // id being archived right now: no saves for it
let saveChain = Promise.resolve(true); // saves run one after another
let navigation = Promise.resolve(); // so do note switches
let lastSave = { state: 'saved', at: 0 };
let saveTimer = 0;
let analysisTimer = 0;
let terrainTimer = 0;
let positionTimer = 0;
let terrainKey = '';
let editor;
let terrain;
let atlas;
let outline;
let library = null; // the shelf and the reader, where this build has a place for documents
let dictation = null; // speech to text at the cursor (dictation.js)
const translator = createTranslator({ api, android }); // a selected passage, Russian ↔ English (translateCard.js)
const phone = Boolean(android) || matchMedia('(pointer: coarse)').matches;
let sync = null; // Google Drive sync (sync/client.js), where this build has it
let sideMenu = null; // the menu sliding in from the right (sidemenu.js)
const profile = { avatar: null, name: '' }; // the picture and the name the person gave (Account)
const homeEl = h('section', { class: 'home', hidden: true }); // the main page (home.js)
let readingTimer = 0;

let markReady;
const ready = new Promise((resolve) => {
  markReady = resolve;
});

const copy = () => ui().look[prefs.skin];
const isAtlas = () => prefs.skin === 'atlas';
const when = (ms) => (new Date(ms).toDateString() === new Date().toDateString() ? formatTime(ms) : formatDay(ms));
const titleOf = (note) => note?.info.title || t('untitled');
const newestId = () => [...notes.values()].sort((a, b) => b.updated - a.updated)[0]?.id ?? null;
/** "light" or "dark": the tone the chosen theme sits on (sepia is a light one, night a dark one). */
const effectiveTheme = () => toneOf(prefs.theme, systemDark.matches);

// The look is remembered in this browser too, so the window opens in it before the server answers.
function cachedLook() {
  try {
    return JSON.parse(localStorage.getItem(LOOK_KEY)) ?? {};
  } catch {
    return {};
  }
}

applyLanguage({ persist: false });

boot().catch((err) => {
  console.error(err);
  showBlocker({
    title: t('boot.title'),
    text: t('boot.text', err.message),
    action: { text: t('boot.reload'), run: () => location.reload() },
  });
});

async function boot() {
  await claimWindow();
  const saved = (await api.getState()) ?? {};
  Object.assign(prefs, normalizeLook({ ...prefs, ...pickDefined(saved, ['skin', 'theme', 'accent']) }));
  if (typeof saved.sidebar === 'boolean') prefs.sidebar = saved.sidebar;
  if (typeof saved.fontScale === 'number') prefs.fontScale = saved.fontScale;
  if (typeof saved.avatar === 'string') profile.avatar = saved.avatar;
  if (typeof saved.profileName === 'string') profile.name = saved.profileName;
  Object.assign(prefs, normalizeReading(saved));
  // the language is settled once and stored, so it no longer follows the browser's afterwards
  const lang = pickLang({ saved: saved.lang, existing: Boolean(saved.welcomed), preferred: browserLanguages() });
  if (saved.lang !== lang) api.setState({ lang }).catch(() => {});
  if (lang !== prefs.lang) {
    prefs.lang = lang;
    applyLanguage({ persist: false });
  }
  applySidebar(prefs.sidebar, { persist: false });
  applyFontScale(prefs.fontScale, { persist: false });

  let list = await api.list();
  const firstRun = !list.length && !saved.welcomed;
  if (!list.length) {
    list = [await api.create(saved.welcomed ? '' : WELCOME[prefs.lang][android ? 'android' : inBrowser ? 'browser' : 'server'])];
    api.setState({ welcomed: true }).catch(() => {});
  }
  for (const note of list) notes.set(note.id, { ...note, info: analyze(note.content) });
  const drafts = unsavedDrafts();

  editor = createEditor({
    parent: $('#editor'),
    onDocChange,
    onSelectionChange,
    onSmartPaste,
    onOpenLink: openLink,
    onContextMenu: openEditorMenu,
    onCopy: (text) => api.copy(text),
    onImage: addImage,
    resolveImage: (name) => (api.assetUrl ? api.assetUrl(name) : Promise.resolve(null)),
    openImage: showImage,
  });
  editor.view.scrollDOM.addEventListener(
    'scroll',
    () => {
      schedulePositionSave();
      updateProgress();
    },
    { passive: true },
  );
  outline = new Outline($('#outline'), { onJump: jumpToLine });
  terrain = new TerrainView($('#terrain'), { getLayout, onPeakClick: jumpToLine });
  atlas = new AtlasView($('#atlas'), {
    getNotes: () => [...notes.values()],
    getCurrentId: () => currentId,
    onOpen: (id) => openNote(id),
    onCreate: () => createNote(),
    onClose: () => editor.view.focus(),
  });
  dictation = createDictation({
    android,
    handlers: {
      partial: (text) => showDictationPreview(editor.view, text),
      final: (text) => insertDictation(editor.view, text),
      state: showDictating,
      error: (code) => toast(t(DICTATION_ERRORS[code] ?? 'dictation.failed'), { timeout: 7000 }),
    },
  });
  $('#btn-dictate').hidden = false;
  if (api.library) {
    library = createLibrary({
      api,
      phone,
      translator,
      getReading: () => normalizeReading(prefs),
      onReading: setReading,
      onCustomize: () => showAppearance({ pdf: library.openDocKind?.() === 'pdf' }),
      onReaderColors: (bg, light) => (bg ? android?.setBars(bg, light) : applyBars()),
      onQuote: quoteToNote,
      onOpenNote: (id) => openNote(id),
      onLink: (url) => api.openExternal(url),
      onClose: () => editor.view.focus(),
    });
  }
  sideMenu = createSideMenu({ sections: menuSections(), onClose: () => editor.view.focus({ preventScroll: true }) });
  bindChrome();
  applyLook({ persist: false });

  const fonts = ['500 16px "Inter Variable"', '500 10px "JetBrains Mono Variable"', 'italic 600 16px "Cormorant Garamond"'];
  await Promise.all([...fonts.map((f) => document.fonts.load(f)), document.fonts.ready].map((p) => p.catch(() => {})));
  const restoredId = drafts.length ? await offerRestore(drafts) : null;
  await openNote(restoredId ?? (notes.has(saved.lastOpen) ? saved.lastOpen : newestId()));
  if (inBrowser && !firstRun && !drafts.length && Date.now() - (saved.lastBackup ?? 0) > BACKUP_EVERY) remindBackup(saved.lastBackup);
  if (api.ping) setInterval(ping, 20_000);
  setInterval(tickPace, 10_000);
  markReady();
  // the app opens on the main page, where the person picks where to go
  document.body.append(homeEl);
  showAvatar();
  await showHome();
  if (android) receiveIncoming();
  sync = createSyncClient({
    api,
    h,
    toast,
    beforeRound: async () => {
      library?.flush();
      await flushSave();
    },
    openDocs: () => [library?.openDocId()].filter(Boolean),
    afterRound: afterSync,
  });
  sync?.start();
}

/** A sync round brought notes or cards from another device: show them. */
async function afterSync({ pulled, trashed, conflicts, docsChanged, first }) {
  if (docsChanged) await library?.reload();
  if (!pulled.length && !trashed.length && !conflicts.length) return;
  if (first) {
    // a device signing in for the first time: its untouched welcome note would sit next to the one the
    // other devices already have; it goes to the trash (and, being untouched, off the Drive next round)
    const welcomes = new Set(Object.values(WELCOME).flatMap((byKind) => Object.values(byKind)));
    for (const note of [...notes.values()]) {
      if (pulled.includes(note.id) || !welcomes.has(note.content) || (note.id === currentId && dirty)) continue;
      await api.trash(note.id).catch(() => {});
    }
  }
  const fresh = new Map((await api.list()).map((n) => [n.id, n]));
  for (const [id, note] of fresh) {
    const known = notes.get(id);
    if (known && known.content === note.content) continue;
    if (id === currentId && known) {
      if (dirty) {
        // typed here while the round ran: the text on screen stays, the incoming version becomes a note of its own
        const copy = await api.create(note.content);
        notes.set(copy.id, { ...copy, info: analyze(copy.content) });
        continue;
      }
      const sel = editor.view.state.selection.main;
      const fit = (v) => Math.min(v, note.content.length);
      editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: note.content }, selection: { anchor: fit(sel.anchor), head: fit(sel.head) } });
      dirty = false; // the change came from the disk, nothing to save
      clearTimeout(saveTimer);
      setSaveState('saved', note.updated, { quiet: true });
    } else editorStates.delete(id);
    notes.set(id, { ...known, ...note, info: analyze(note.content) });
  }
  for (const id of [...notes.keys()]) if (!fresh.has(id)) forget(id);
  if (currentId && !notes.has(currentId)) {
    currentId = null;
    await openNote(newestId());
  }
  for (const { id } of conflicts) toast(t('sync.conflict', titleOf(notes.get(id))), { timeout: 8000 });
  renderIndex();
  refreshChrome();
}

/** Files another Android app handed over ("Open with" / "Share"): onto the shelf, the last one opened. */
async function receiveIncoming() {
  await ready;
  let list = [];
  try {
    list = JSON.parse(android.takeIncoming() || '[]');
  } catch {
    return;
  }
  const files = [];
  for (const { file, name, type } of list) {
    try {
      // the app put the file where the page can fetch it: /incoming/<file>
      const res = await fetch(`/incoming/${encodeURIComponent(file)}`, { cache: 'no-store' });
      if (res.ok) files.push(new File([await res.blob()], name || file, { type: type || '' }));
    } catch (err) {
      console.error(err);
    } finally {
      android.release(file);
    }
  }
  if (files.length && library) await library.receive(files);
}

/** The shelf over the notes (with `pick`, the file picker too): dictation stops, the text is saved. */
function openLibrary({ pick = false } = {}) {
  if (!library) return;
  if (dictation?.listening) dictation.stop();
  flushSave();
  if (pick) library.pickFiles();
  else library.open();
}

// In the browser build clearing the browser's data would take the notes with it, hence the nudge.
function remindBackup(lastBackup) {
  const since = lastBackup ? t('backup.lastCopy', formatDay(lastBackup)) : t('backup.noCopy');
  toast(t('backup.onlyHere', since), { action: { text: t('backup.download'), run: exportAll }, timeout: 10_000 });
}

function pickDefined(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function ping() {
  api.ping?.().catch((err) => {
    if (err.offline || err.status === 403) connectionLost(err);
  });
}

// ---------- unsaved text from the last run ----------

/**
 * Text that never reached the disk (the server died, or an update replaced it, before a save landed)
 * waits in the rescue copy. Copies older than what the disk holds are put aside without asking; the
 * rest are offered back at start. Nothing is dropped unless the disk has exactly that text.
 */
function unsavedDrafts() {
  const offer = [];
  for (const [id, saved] of Object.entries(rescue.all())) {
    const note = notes.get(id);
    if (typeof saved?.content !== 'string' || (note && saved.content === note.content)) rescue.drop(id);
    else if (note && saved.at <= note.updated) putAside(id, saved, t('restore.olderLabel'));
    else offer.push({ id, content: saved.content, at: saved.at, note });
  }
  return offer.sort((a, b) => b.at - a.at);
}

/** Keeps the text in the backups folder (the browser's trash in the browser build), then forgets the copy. */
async function putAside(id, saved, label) {
  try {
    await api.keepDraft?.({ title: analyze(saved.content).title || t('untitled'), content: saved.content, at: saved.at, label });
    rescue.drop(id, saved.content);
    return true;
  } catch (err) {
    console.error(err); // the copy stays and is offered again next time
    return false;
  }
}

const changeSize = (before, after) => {
  const diff = after.length - before.length;
  return diff ? `${diff > 0 ? '+' : '−'}${count(Math.abs(diff), 'char')}` : t('restore.sameLength');
};

/** Asks which texts to put back; returns the note to open when one came back. */
async function offerRestore(drafts) {
  const keptWhere = t(api.openBackupsFolder ? 'restore.toBackups' : 'restore.toTrash');
  const items = drafts.map((d) => ({
    title: analyze(d.content).title || t('untitled'),
    meta: `${formatDay(d.at)}, ${formatTime(d.at)} · ${d.note ? changeSize(d.note.content, d.content) : t('restore.noteGone')}`,
  }));
  const answers = await openRestoreDialog({ items, keptWhere });
  let back = 0;
  let aside = 0;
  let openId = null;
  for (const [i, d] of drafts.entries()) {
    if (!answers[i]) {
      if (await putAside(d.id, d, t('restore.skippedLabel'))) aside++;
      continue;
    }
    const id = await restoreDraft(d);
    if (id) {
      back++;
      openId ??= id;
    }
  }
  if (back) toast(t('restore.restored', count(back, 'note')), { timeout: 6000 });
  else if (aside) {
    const action = api.openBackupsFolder ? { text: t('notes.open'), run: () => api.openBackupsFolder() } : undefined;
    toast(t('restore.putAside', keptWhere, count(aside, 'note')), { action, timeout: 8000 });
  }
  return openId;
}

/** Puts a rescued text back; the version it replaces goes to the backups first. */
async function restoreDraft(d) {
  try {
    if (!d.note) {
      const note = await api.create(d.content);
      notes.set(note.id, { ...note, info: analyze(note.content) });
      rescue.drop(d.id, d.content);
      return note.id;
    }
    await api.keepDraft?.({ title: titleOf(d.note), content: d.note.content, at: d.note.updated, label: t('restore.replacedLabel') }).catch((err) => console.error(err));
    const { updated } = await api.write(d.id, d.content);
    Object.assign(d.note, { content: d.content, info: analyze(d.content), updated });
    rescue.drop(d.id, d.content);
    return d.id;
  } catch (err) {
    console.error(err);
    toast(t('restore.failed', analyze(d.content).title || t('untitled'), err.message));
    return null;
  }
}

// ---------- one window at a time ----------

const channel = (() => {
  try {
    return new BroadcastChannel('atlas-notetaker');
  } catch {
    return null; // no BroadcastChannel (or not for file:// pages): one-window mode is off
  }
})();
const windowId = Math.random().toString(36).slice(2);

// The newest window wins. Before it reads any note it asks older windows to save and step aside,
// so it never starts from text that is about to change.
function claimWindow() {
  if (!channel) return Promise.resolve();
  channel.addEventListener('message', (e) => {
    if (e.data?.type === 'takeover' && e.data.from !== windowId) yieldTo(e.data.from);
  });
  return new Promise((resolve) => {
    let busy = false;
    const done = () => {
      clearTimeout(quiet);
      clearTimeout(limit);
      channel.removeEventListener('message', onReply);
      resolve();
    };
    const onReply = (e) => {
      if (e.data?.to !== windowId) return;
      if (e.data.type === 'busy') busy = true;
      if (e.data.type === 'released') done();
    };
    channel.addEventListener('message', onReply);
    channel.postMessage({ type: 'takeover', from: windowId });
    const quiet = setTimeout(() => {
      if (!busy) done();
    }, 200);
    const limit = setTimeout(done, 5000);
  });
}

async function yieldTo(claimant) {
  channel.postMessage({ type: 'busy', to: claimant });
  let saved = true;
  if (!suspended && editor) {
    saved = await flushSave();
    rememberPosition();
  }
  suspended = true;
  channel.postMessage({ type: 'released', to: claimant });
  showBlocker({
    title: t('window.title'),
    text: t(saved ? 'window.saved' : 'window.unsaved'),
    action: { text: t('window.continue'), run: () => location.reload() },
  });
}

function connectionLost(err) {
  if (lost) return;
  lost = true;
  setSaveState('error');
  const restarted = err.status === 403;
  showBlocker({
    title: t(restarted ? 'connection.restartedTitle' : 'connection.lostTitle'),
    text: t(restarted ? 'connection.restartedText' : 'connection.lostText'),
    action: { text: t(restarted ? 'connection.reload' : 'connection.retry'), run: () => location.reload() },
  });
}

// ---------- notes ----------

function savedSelection(note) {
  const c = note.cursor;
  if (!c || !Number.isInteger(c.anchor)) return undefined;
  const fit = (v) => Math.max(0, Math.min(note.content.length, v));
  return EditorSelection.single(fit(c.anchor), fit(c.head ?? c.anchor));
}

// Switches run one at a time: a second click while the first is still saving waits its turn.
function openNote(id, options) {
  const run = navigation.then(() => openNoteNow(id, options));
  navigation = run.catch((err) => console.error(err));
  return run;
}

async function openNoteNow(id, { transition = 'reveal', origin } = {}) {
  const note = notes.get(id);
  if (!note || suspended || lost) return;
  if (atlas?.isOpen) atlas.hide();
  if (id === currentId) {
    editor.view.focus();
    return;
  }
  if (dictation?.listening) dictation.stop(); // the words would land in another note
  if (currentId && !(await leaveCurrent())) {
    toast(t('notes.stayed'));
    return;
  }

  currentId = id;
  note.blankAtOpen = !note.content.trim();
  editor.view.setState(editorStates.get(id) ?? editor.makeState(note.content, savedSelection(note)));
  editor.localize(); // a kept state may still speak the language it was made in
  dirty = false;
  setSaveState('saved', note.updated, { quiet: true });
  const scroll = note.scroll || 0;
  requestAnimationFrame(() => {
    editor.view.scrollDOM.scrollTop = scroll;
    updateProgress();
  });
  refreshChrome();
  showCursorStatus(editor.view.state);
  renderIndex();
  terrainKey = '';
  updateTerrain(transition, origin);
  api.setState({ lastOpen: id }).catch(() => {});
  editor.view.focus();
}

/** Saves the open note before moving on; false when the save failed and the switch must not happen. */
async function leaveCurrent() {
  const id = currentId;
  if (!(await flushSave())) return false;
  rememberPosition();
  editorStates.set(id, editor.view.state);
  // A note that was blank when opened and is still blank was never really started: drop it.
  // One that was emptied on purpose keeps its (empty) file, so undo and the file history stay possible.
  if (notes.get(id)?.blankAtOpen && !editor.view.state.doc.toString().trim() && notes.size > 1) {
    await api.trash(id).catch(() => {});
    forget(id);
  }
  return true;
}

function forget(id) {
  notes.delete(id);
  editorStates.delete(id);
  indexItems.get(id)?.remove();
  indexItems.delete(id);
  rescue.drop(id);
}

async function createNote(content = '') {
  if (suspended || lost) return;
  if (currentId && !content && !editor.view.state.doc.length) {
    editor.view.focus(); // already standing on a blank page
    return;
  }
  const note = await api.create(content);
  notes.set(note.id, { ...note, info: analyze(note.content) });
  await openNote(note.id);
  if (content) editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
}

async function deleteNote(id) {
  const note = notes.get(id);
  if (!note) return;
  const c = copy();
  const ok = await confirmDialog({ kicker: c.deleteKicker, title: c.deleteTitle(titleOf(note)), text: c.deleteText, ok: c.deleteOk, danger: true });
  if (!ok) return;
  const wasOpen = id === currentId;
  if (wasOpen) clearTimeout(saveTimer);
  trashing = id;
  try {
    await api.trash(id);
  } catch (err) {
    trashing = null;
    // the file is still there: keep the note open and saving as if nothing happened
    if (wasOpen && dirty) saveTimer = setTimeout(flushSave, SAVE_DELAY);
    toast(t('notes.deleteFailed', err.message));
    return;
  }
  trashing = null;
  if (id === currentId) {
    dirty = false;
    currentId = null;
  }
  forget(id);
  if (!notes.size) await createNote();
  else if (!currentId) await openNote(newestId());
  renderIndex();
  toast(copy().deleted(titleOf(note)), api.openNotesFolder ? { action: { text: t('notes.openFolder'), run: () => api.openNotesFolder() } } : {});
}

// ---------- dictation ----------

const DICTATION_ERRORS = {
  'not-allowed': 'dictation.notAllowed',
  network: 'dictation.network',
  language: 'dictation.language',
  busy: 'dictation.busy',
  'no-service': 'dictation.noService',
};
const CLOUD_NOTICE_KEY = 'atlas-notetaker:dictation-cloud-told';

/** The microphone button: on, off, or a word on why dictation cannot work here. */
function toggleDictation() {
  if (!dictation) return;
  if (dictation.listening) {
    dictation.stop();
    return;
  }
  if (!dictation.supported || suspended || lost) {
    toast(t('dictation.unsupported'), { timeout: 8000 });
    return;
  }
  // in a browser the speech goes to the browser maker's cloud: said once, on the first use
  let told = true;
  try {
    told = Boolean(android) || localStorage.getItem(CLOUD_NOTICE_KEY) === '1';
    if (!told) localStorage.setItem(CLOUD_NOTICE_KEY, '1');
  } catch {
    told = true;
  }
  editor.view.focus();
  dictation.start(prefs.lang);
  toast(t(told ? 'dictation.listening' : 'dictation.cloud'), { timeout: told ? 3000 : 9000 });
}

function showDictating(on) {
  const button = $('#btn-dictate');
  button.classList.toggle('listening', on);
  button.setAttribute('aria-pressed', String(on));
  button.title = t(on ? 'dictation.stop' : 'chrome.dictateKey');
  if (!on) showDictationPreview(editor.view, '');
}

/** Adds text at the end of a note, whether it is open in the editor or not. */
async function appendToNote(id, addition) {
  const note = notes.get(id);
  if (!note) return false;
  const gap = (text) => (!text.trim() ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n');
  if (id === currentId) {
    const { view } = editor;
    const text = view.state.doc.toString();
    view.dispatch({ changes: { from: text.length, insert: gap(text) + addition }, userEvent: 'input.quote' });
    return flushSave();
  }
  const content = note.content + gap(note.content) + addition;
  const { updated } = await api.write(id, content);
  // a note kept open in memory (for its undo history) gets the same lines
  const kept = editorStates.get(id);
  if (kept) editorStates.set(id, kept.update({ changes: { from: kept.doc.length, insert: content.slice(kept.doc.length) } }).state);
  Object.assign(note, { content, updated, info: analyze(content) });
  renderIndex();
  return true;
}

/** A passage from the reader, as a quote in the document's own note (made on the first quote). */
/** link: atlas:<document>#<mark> — the quote's "where" leads back to the place (Ctrl+click). */
async function quoteToNote(doc, text, where, link) {
  if (suspended || lost) throw new Error(t('errors.offline'));
  const label = (where || (link ? doc.title || doc.name : '')).replace(/[[\]]/g, '');
  const source = label && link ? `[${label}](${link})` : label;
  const quote = `${text.split('\n').map((line) => `> ${line}`).join('\n')}\n${source ? `>\n> — ${source}\n` : ''}`;
  let id = doc.notesId && notes.has(doc.notesId) ? doc.notesId : null;
  if (id) {
    if (!(await appendToNote(id, quote))) throw new Error(t('notes.stayed'));
  } else {
    const head = `# ${t('reader.notesTitle', doc.title || doc.name)}\n\n${doc.author ? `*${doc.author}*\n\n` : ''}`;
    const note = await api.create(head + quote);
    notes.set(note.id, { ...note, info: analyze(note.content) });
    renderIndex();
    id = note.id;
  }
  return { id, title: titleOf(notes.get(id)) };
}

// ---------- saving ----------

function onDocChange(update) {
  if (suspended) return;
  if (lost) {
    // no server to save to: the text goes straight into the rescue copy
    if (currentId) rescue.put(currentId, update.state.doc.toString());
    return;
  }
  notePace(update);
  dirty = true;
  setSaveState('pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DELAY);
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(refreshAnalysis, 160);
}

/** Saves the open note if it changed. Resolves true once the disk has it (or there was nothing to save). */
function flushSave() {
  clearTimeout(saveTimer);
  saveChain = saveChain.then(saveNow, saveNow);
  return saveChain;
}

async function saveNow() {
  if (!currentId || currentId === trashing || !dirty) return true;
  const id = currentId;
  const content = editor.view.state.doc.toString();
  // first of all, whatever happens next: a server that is gone (or was just replaced by an update)
  // must not take the text with it
  rescue.put(id, content);
  if (suspended || lost) return false;
  dirty = false;
  setSaveState('pending');
  try {
    const { updated } = await api.write(id, content);
    rescue.drop(id, content);
    const note = notes.get(id);
    if (note) {
      note.content = content;
      note.updated = updated;
    }
    if (!dirty && id === currentId) setSaveState('saved', updated);
    renderIndex();
    return true;
  } catch (err) {
    console.error(err);
    if (id === currentId) dirty = true;
    if (err.offline || err.status === 403) {
      connectionLost(err);
    } else if (id === currentId) {
      setSaveState('error');
      saveTimer = setTimeout(flushSave, 2500);
    }
    return false;
  }
}

function rememberPosition() {
  clearTimeout(positionTimer);
  const note = notes.get(currentId);
  if (!note || suspended) return;
  const sel = editor.view.state.selection.main;
  note.cursor = { anchor: sel.anchor, head: sel.head };
  note.scroll = Math.round(editor.view.scrollDOM.scrollTop);
  api.setMeta(currentId, { cursor: note.cursor, scroll: note.scroll }).catch(() => {});
}

function schedulePositionSave() {
  clearTimeout(positionTimer);
  positionTimer = setTimeout(rememberPosition, 1200);
}

function flushOnExit() {
  if (!currentId || suspended || currentId === trashing) return;
  clearTimeout(saveTimer);
  const sel = editor.view.state.selection.main;
  const meta = { cursor: { anchor: sel.anchor, head: sel.head }, scroll: Math.round(editor.view.scrollDOM.scrollTop) };
  const content = dirty ? editor.view.state.doc.toString() : null;
  if (content !== null) rescue.put(currentId, content); // in case the request doesn't make it out
  if (!lost) api.flushOnExit(currentId, content, meta);
  dirty = false;
}

function setSaveState(state, at, { quiet = false } = {}) {
  lastSave = { state, at: at ?? lastSave.at };
  const el = $('#sb-save');
  const label = el.querySelector('b');
  const c = copy();
  el.dataset.state = state;
  if (state === 'pending') label.textContent = c.pending;
  else if (state === 'error') label.textContent = c.failed;
  else {
    label.textContent = lastSave.at ? `${c.saved} · ${formatTime(lastSave.at)}` : c.saved;
    if (!quiet) {
      el.classList.remove('stamp');
      void el.offsetWidth;
      el.classList.add('stamp');
    }
  }
}

// ---------- typing pace: a sparkline of the last two minutes ----------

const pace = new Array(12).fill(0); // characters typed per 10-second slot

function notePace(update) {
  for (const tr of update.transactions) {
    if (!tr.isUserEvent('input.type')) continue;
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      pace[pace.length - 1] += inserted.length;
    });
  }
}

function tickPace() {
  pace.shift();
  pace.push(0);
  renderPace();
}

function renderPace() {
  const el = $('#sb-pace');
  if (!pace.some(Boolean)) {
    el.hidden = true;
    return;
  }
  const bars = '▁▂▃▄▅▆▇█';
  const max = Math.max(60, ...pace);
  const perMinute = pace.slice(-6).reduce((a, b) => a + b, 0);
  el.hidden = false;
  // about six characters per word, space included, in Russian and in English alike
  el.textContent = `${pace.map((v) => bars[Math.min(7, Math.round((v / max) * 7))]).join('')} ${t('status.pace', Math.round(perMinute / 6))}`;
}

// ---------- what the chrome shows ----------

function refreshAnalysis() {
  const note = notes.get(currentId);
  if (!note) return;
  note.info = analyze(editor.view.state.doc.toString());
  refreshChrome();
  updateIndexItem(note);
  renderPace();
  clearTimeout(terrainTimer);
  terrainTimer = setTimeout(() => updateTerrain('fade'), 900);
}

function refreshChrome() {
  const note = notes.get(currentId);
  if (!note) return;
  const { info } = note;
  $('#crumb').textContent = titleOf(note);
  document.title = `${titleOf(note)} — ATLAS`;
  const comments = info.comments ? count(info.comments, 'comment') : '';
  const words = `${count(info.words, 'word')} · ${count(info.chars, 'char')}`;
  $('#sb-words').textContent = !isAtlas() && comments ? `${words} · ${comments}` : words;
  const peaks = info.headings.length ? t('status.peaks', count(info.headings.length, 'peak')) : copy().noHeadings;
  $('#sb-peaks').textContent = comments ? `${peaks} · 💬 ${comments}` : peaks;
  outline.setHeadings(info.headings);
  outline.setCursorLine(editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number);
}

function onSelectionChange(update) {
  showCursorStatus(update.state);
  schedulePositionSave();
  // on a phone a long press shows the phone's own copy bar: "Translate" floats over the text instead
  if (phone) $('#btn-translate').hidden = update.state.selection.main.empty;
}

/** The selection in the note, in the translation card; "To note" puts the translation under it. */
function translateSelection(view = editor.view) {
  const sel = view.state.selection.main;
  if (sel.empty) {
    toast(t('translate.nothingSelected'));
    return;
  }
  const text = view.state.sliceDoc(sel.from, sel.to);
  const start = view.coordsAtPos(sel.from);
  const end = view.coordsAtPos(sel.to);
  const rect = start && end ? { left: start.left, top: start.top, bottom: Math.max(start.bottom, end.bottom) } : null;
  const noteId = currentId;
  translator.open({
    text,
    rect,
    toNote: {
      title: t('translate.toNoteEditor'),
      run(translation) {
        if (currentId !== noteId) return;
        const v = editor.view;
        const line = v.state.doc.lineAt(Math.min(sel.to, v.state.doc.length));
        const insert = `\n\n${translation}`;
        v.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length }, scrollIntoView: true });
        v.focus();
      },
    },
  });
}

function showCursorStatus(state) {
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  $('#sb-coords').textContent = copy().coords(line.number, sel.head - line.from + 1);
  const selected = state.selection.ranges.reduce((n, r) => n + r.to - r.from, 0);
  const selEl = $('#sb-sel');
  selEl.hidden = !selected;
  selEl.textContent = t('status.selected', count(selected, 'char'));
  const lang = codeLanguageAt(state, sel.head);
  const langEl = $('#sb-lang');
  langEl.hidden = lang == null;
  langEl.textContent = `⌗ ${lang || t('status.code')}`;
  outline?.setCursorLine(line.number);
}

function updateProgress() {
  const scroller = editor.view.scrollDOM;
  const room = scroller.scrollHeight - scroller.clientHeight;
  $('#progress').style.transform = `scaleX(${room > 0 ? Math.min(1, scroller.scrollTop / room) : 0})`;
}

function ruggedness(words) {
  return 0.55 + 0.95 * Math.min(1, Math.log10(1 + words) / 3.3);
}

function updateTerrain(mode = 'fade', origin) {
  const note = notes.get(currentId);
  if (!note) return;
  const { info } = note;
  const key = `${note.id}|${Math.round(Math.log10(1 + info.words) * 6)}|${info.headings.map((hd) => `${hd.level}:${hd.text}:${hd.words}`).join('¦')}`;
  if (key === terrainKey && mode === 'fade') return;
  terrainKey = key;
  terrain.setSpec({ id: note.id, seed: hashString(note.id), words: info.words, headings: info.headings, ruggedness: ruggedness(info.words) }, mode, origin);
}

function getLayout() {
  const w = innerWidth;
  const h = innerHeight;
  const top = $('.titlebar').getBoundingClientRect().bottom;
  const bottom = $('.statusbar').getBoundingClientRect().top;
  const frame = { left: 10, top: top + 10, right: w - 10, bottom: bottom - 10 };
  const sheet = $('#sheet').getBoundingClientRect();
  const index = $('#index');
  const leftEdge = index.offsetParent ? index.getBoundingClientRect().right : frame.left;
  const gap = 26;
  const zones = [
    { x0: sheet.right + gap, x1: frame.right - gap },
    { x0: leftEdge + gap, x1: sheet.left - gap },
  ].filter((z) => z.x1 - z.x0 >= 70);
  return { w, h, frame, zones };
}

function jumpToLine(lineNumber) {
  const { view } = editor;
  const line = view.state.doc.line(Math.max(1, Math.min(lineNumber, view.state.doc.lines)));
  view.dispatch({ selection: { anchor: line.to }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 60 }) });
  view.focus();
}

// ---------- the list of notes ----------

function makeIndexItem(note) {
  const thumb = h('canvas', { class: 'idx-thumb', width: '72', height: '72', 'aria-hidden': 'true' });
  const del = h('button', { type: 'button', class: 'idx-del' }, '✕');
  const li = h(
    'li',
    { class: 'idx-item', tabindex: '0', role: 'button', 'data-id': note.id },
    thumb,
    h('span', { class: 'idx-text' }, h('span', { class: 'idx-title' }), h('span', { class: 'idx-meta' })),
    del,
  );
  const open = () => {
    const r = li.getBoundingClientRect();
    closeIndexPanel();
    openNote(note.id, { origin: { x: r.right, y: r.top + r.height / 2 } });
  };
  li.addEventListener('click', (e) => {
    if (!e.target.closest('.idx-del')) open();
  });
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    } else if (e.key === 'Delete') {
      deleteNote(note.id);
    }
  });
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteNote(note.id);
  });
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { icon: '↗', text: t('notes.open'), run: open },
      { icon: '⇩', text: t('notes.saveCopy'), run: () => exportNote(note.id) },
      '-',
      { icon: '✕', text: copy().deleteItem, kbd: 'Del', className: 'danger', run: () => deleteNote(note.id) },
    ]);
  });
  if (isAtlas()) drawIslandThumb(thumb, note.id, readAtlasPalette());
  return li;
}

function updateIndexItem(note, li = indexItems.get(note.id)) {
  if (!li) return;
  const title = li.querySelector('.idx-title');
  title.textContent = titleOf(note);
  title.classList.toggle('untitled', !note.info.title);
  li.querySelector('.idx-meta').textContent = `${when(note.updated)} · ${count(note.info.words, 'wordShort')}`;
  const del = li.querySelector('.idx-del');
  del.title = copy().deleteItem;
  del.setAttribute('aria-label', t('notes.deleteNote'));
  li.classList.toggle('active', note.id === currentId);
  li.setAttribute('aria-current', note.id === currentId ? 'true' : 'false');
}

function renderIndex() {
  const q = $('#index-filter').value.trim().toLowerCase();
  const sorted = [...notes.values()].sort((a, b) => b.updated - a.updated);
  const shown = sorted.filter((n) => !q || titleOf(n).toLowerCase().includes(q) || n.content.toLowerCase().includes(q));
  const items = shown.map((note) => {
    let li = indexItems.get(note.id);
    if (!li) {
      li = makeIndexItem(note);
      indexItems.set(note.id, li);
    }
    updateIndexItem(note, li);
    return li;
  });
  const list = $('#index-list');
  list.replaceChildren(...items);
  if (!items.length) list.append(h('li', { class: 'idx-empty' }, q ? copy().nothingFound : copy().empty));
  $('#index-count').textContent = String(notes.size);
}

// ---------- context menu & comments ----------

/** A link in a note: atlas:… opens the place in a library document, anything else the browser. */
function openLink(url) {
  if (url.startsWith('atlas:')) {
    if (library) library.openLink(url);
    return;
  }
  api.openExternal(url);
}

function openEditorMenu(event, view) {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  const before = view.state.selection.main;
  if (pos != null && (before.empty || pos < before.from || pos > before.to)) view.dispatch({ selection: { anchor: pos } });
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.empty ? sel.head : Math.max(sel.from, sel.to - 1));
  const inCode = codeLanguageAt(state, line.from) !== null;
  const url = urlAt(state, sel.head);

  const items = [];
  if (url) items.push({ icon: '↗', text: t('menu.openLink'), kbd: t('menu.ctrlClick'), run: () => openLink(url) }, '-');
  items.push(
    {
      icon: '❝',
      text: t('menu.addComment'),
      kbd: 'Ctrl+Shift+M',
      disabled: inCode,
      title: inCode ? t('comment.inCode') : undefined,
      run: () => requestComment(view, line.number),
    },
    { icon: '🌐', text: t('menu.translate'), kbd: 'Ctrl+Shift+X', disabled: sel.empty, run: () => translateSelection(view) },
    '-',
    { icon: '✂', text: t('menu.cut'), kbd: 'Ctrl+X', disabled: sel.empty, run: () => cutSelection(view) },
    { icon: '⧉', text: t('menu.copy'), kbd: 'Ctrl+C', disabled: sel.empty, run: () => copySelection(view) },
    { icon: '⎘', text: t('menu.paste'), kbd: 'Ctrl+V', run: () => pasteFromClipboard(view) },
    '-',
    { icon: '⌗', text: t(sel.empty ? 'menu.codeBlock' : 'menu.wrapCode'), kbd: 'Ctrl+E', run: () => insertCodeBlock(view) },
    { icon: '▣', text: t('menu.selectAll'), kbd: 'Ctrl+A', run: () => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }) },
    { icon: '⇩', text: t('notes.saveCopy'), run: () => exportNote(currentId) },
    { note: t('menu.spelling') },
  );
  showMenu(event.clientX, event.clientY, items, { onClose: () => view.focus() });
}

async function requestComment(view, lineNumber) {
  const { state } = view;
  const sel = state.selection.main;
  const n = lineNumber ?? state.doc.lineAt(sel.empty ? sel.head : Math.max(sel.from, sel.to - 1)).number;
  if (codeLanguageAt(state, state.doc.line(n).from) !== null) {
    toast(t('comment.inCode'));
    return;
  }
  const lines = state.doc.toJSON();
  const target = commentTarget(lines, n);
  const body = await openCommentDialog({
    kicker: copy().commentKicker,
    quote: lines[target - 1].trim() || t('comment.emptyLine'),
    history: commentsUnder(lines, target),
  });
  view.focus();
  if (body) insertComment(view, n, body);
}

async function copySelection(view) {
  const sel = view.state.selection.main;
  try {
    await api.copy(view.state.sliceDoc(sel.from, sel.to));
    return true;
  } catch {
    toast(t('clipboard.blocked', 'Ctrl+C'));
    return false;
  }
}

async function cutSelection(view) {
  if (await copySelection(view)) view.dispatch(view.state.replaceSelection(''), { userEvent: 'delete.cut' });
}

async function pasteFromClipboard(view) {
  try {
    pasteText(view, await api.readClipboard(), onSmartPaste);
  } catch {
    toast(t('clipboard.blocked', 'Ctrl+V'));
  }
}

function onSmartPaste(lang, undoWrap) {
  toast(t('paste.wrapped', lang), { action: { text: t('paste.undo'), run: undoWrap } });
}

function exportNote(id) {
  const note = notes.get(id);
  if (!note) return;
  const content = id === currentId ? editor.view.state.doc.toString() : note.content;
  api.download(fileNameFor(titleOf(note), new Set()), content);
}

const IMAGE_LIMIT = 15 * 1024 * 1024;

/** A pasted or dropped picture: stored by the app, then shown in the note on a line of its own. */
async function addImage(file, pos) {
  if (!api.saveAsset) {
    toast(t('image.unsupported'));
    return;
  }
  if (file.size > IMAGE_LIMIT) {
    toast(t('image.tooBig'));
    return;
  }
  let name;
  try {
    name = await api.saveAsset(file);
  } catch (err) {
    toast(t('image.failed', err.message));
    return;
  }
  const { view } = editor;
  const line = view.state.doc.lineAt(pos ?? view.state.selection.main.head);
  // a clipboard screenshot arrives as "image.png"; a dropped file keeps its own name
  const named = file.name && !/^image\.\w+$/i.test(file.name);
  const alt = (named ? file.name.replace(/\.[^.]+$/, '') : t('image.screenshot', formatStamp(new Date()))).replace(/[[\]\n]/g, ' ');
  const blank = !line.text.trim();
  const at = blank ? line.from : line.to;
  const text = `${blank ? '' : '\n'}![${alt}](assets/${name})\n`;
  view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, scrollIntoView: true, userEvent: 'input.image' });
  view.focus();
}

/** What a backup holds: every note as a .md file, and the pictures they show under assets/. */
async function backupFiles() {
  await flushSave();
  const used = new Set();
  const sorted = [...notes.values()].sort((a, b) => a.created - b.created);
  const texts = sorted.map((note) => (note.id === currentId ? editor.view.state.doc.toString() : note.content));
  const files = sorted.map((note, i) => ({ name: fileNameFor(titleOf(note), used), text: texts[i], date: note.updated }));
  for (const name of new Set(texts.flatMap(imageRefs))) {
    const bytes = api.readAsset ? await api.readAsset(name).catch(() => null) : null;
    if (bytes) files.push({ name: `assets/${name}`, bytes });
  }
  return files;
}

/** Every note as a .md file in one .zip: the backup of the browser build, and handy anywhere. */
async function exportAll() {
  const files = await backupFiles();
  const stamp = new Date().toISOString().slice(0, 10);
  api.download(t('backup.zipName', stamp), makeZip(files), 'application/zip');
  api.setState({ lastBackup: Date.now() }).catch(() => {});
  const texts = files.filter((file) => !file.bytes).length;
  toast(t('backup.downloaded', count(texts, 'note')));
}

/** Brings .md / .txt files in as new notes (from a backup, another app or another computer). */
function importFiles() {
  const input = h('input', { type: 'file', multiple: true, accept: '.md,.markdown,.txt,text/markdown,text/plain' });
  input.addEventListener('change', async () => {
    let last = null;
    for (const file of input.files) {
      const text = (await file.text()).replace(/\r\n?/g, '\n');
      const note = await api.create(text);
      notes.set(note.id, { ...note, info: analyze(note.content) });
      last = note.id;
    }
    if (!last) return;
    renderIndex();
    await openNote(last);
    toast(t('backup.imported', count(input.files.length, 'note')));
  });
  input.click();
}

// ---------- the language and the look: skin, theme, accent ----------

/**
 * Puts the interface into prefs.lang: the page's fixed words (data-i18n="key" for the text,
 * data-i18n-title / -label / -placeholder for attributes), the editor's, then all the look redraws.
 */
function applyLanguage({ persist = true } = {}) {
  setLang(prefs.lang);
  document.documentElement.lang = prefs.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  document.querySelectorAll('[data-i18n-label]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nLabel)));
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
  if (persist) api.setState({ lang: prefs.lang }).catch(() => {});
  applyLook({ persist: false });
  if (!editor) return;
  editor.localize();
  renderPace();
}

function setLanguage(lang) {
  if (!isLang(lang) || lang === prefs.lang) return;
  prefs.lang = lang;
  applyLanguage();
}

/** Puts the current look on the page: root attributes, the look's words, the map on or off. */
function applyLook({ persist = true } = {}) {
  const root = document.documentElement;
  const skinChanged = root.dataset.skin !== prefs.skin;
  const theme = effectiveTheme();
  root.dataset.skin = prefs.skin;
  root.dataset.theme = theme;
  // a palette (sepia, dusk, night, contrast) is laid over the tone; the atlas look keeps its own colours
  if (PALETTES[prefs.theme]) root.dataset.palette = prefs.theme;
  else delete root.dataset.palette;
  root.dataset.accent = prefs.accent;
  const c = copy();
  document.querySelectorAll('[data-copy]').forEach((el) => {
    el.textContent = c[el.dataset.copy];
  });
  document.querySelectorAll('[data-copy-placeholder]').forEach((el) => {
    el.placeholder = c[el.dataset.copyPlaceholder];
  });
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify({ skin: prefs.skin, theme: prefs.theme, accent: prefs.accent, lang: prefs.lang }));
  } catch {
    // only a convenience
  }
  if (persist) api.setState({ skin: prefs.skin, theme: prefs.theme, accent: prefs.accent }).catch(() => {});
  applyBars();
  if (!editor) return;
  // the reading theme "like the app" follows, and the menu shows the new choice
  library?.restyle();
  sideMenu?.refresh();

  outline.setCopy(c);
  setSaveState(lastSave.state, lastSave.at, { quiet: true });
  refreshChrome();
  showCursorStatus(editor.view.state);
  renderIndex();
  if (isAtlas()) {
    const pal = readAtlasPalette();
    for (const [id, li] of indexItems) drawIslandThumb(li.querySelector('canvas'), id, pal);
  } else if (atlas.isOpen) {
    atlas.hide();
  }
  terrain.setEnabled(isAtlas());
  // let the new layout settle before the map measures its margins
  requestAnimationFrame(() => terrain.render(skinChanged ? 'reveal' : 'fade'));
  if (atlas.isOpen) atlas.render();
}

/** The phone's status and navigation bars take the page's colour. */
function applyBars() {
  android?.setBars(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), effectiveTheme() === 'light');
}

function setLook(patch) {
  Object.assign(prefs, normalizeLook({ ...prefs, ...patch }));
  applyLook();
}

/** How books are shown (skins.js: readMode, readTurn, readLook): kept a moment after the last change. */
function setReading(patch) {
  Object.assign(prefs, normalizeReading({ ...prefs, ...patch }));
  clearTimeout(readingTimer);
  readingTimer = setTimeout(() => api.setState(normalizeReading(prefs)).catch(() => {}), 300);
}

/** The full "Theme settings" screen for the reading theme (appearance.js). */
function showAppearance({ pdf = false } = {}) {
  openAppearance({
    pdf,
    getLook: () => normalizeReading(prefs).readLook,
    setLook(readLook) {
      setReading({ readLook });
      library?.restyle();
    },
  });
}

function toggleTheme() {
  setLook({ theme: effectiveTheme() === 'dark' ? 'light' : 'dark' });
}

function applySidebar(show, { persist = true } = {}) {
  prefs.sidebar = show;
  $('#app').classList.toggle('no-index', !show);
  if (!persist) return;
  api.setState({ sidebar: show }).catch(() => {});
  requestAnimationFrame(() => terrain?.render('fade'));
}

/** The list button and Ctrl+B: a column to hide or show on wide windows, a sliding panel on narrow ones. */
function toggleIndex() {
  if (!narrow.matches) {
    applySidebar(!prefs.sidebar);
    return;
  }
  const open = $('#app').classList.toggle('index-open');
  if (open) $('#index-filter').focus({ preventScroll: true });
  else editor.view.focus();
}

function closeIndexPanel() {
  $('#app').classList.remove('index-open');
}

function applyFontScale(scale, { persist = true } = {}) {
  prefs.fontScale = Math.round(Math.max(0.75, Math.min(1.6, scale)) * 100) / 100;
  document.documentElement.style.setProperty('--fs', String(prefs.fontScale));
  editor?.view.requestMeasure();
  if (!persist) return;
  api.setState({ fontScale: prefs.fontScale }).catch(() => {});
  toast(t('view.fontSize', Math.round(prefs.fontScale * 100)), { timeout: 1400 });
}

function toggleFocus(on = !focusMode) {
  focusMode = on;
  $('#app').classList.toggle('focus', on);
  requestAnimationFrame(() => terrain.render('fade'));
  if (on) toast(t('view.focus'), { timeout: 2200 });
  editor.view.focus();
}

/** Where the notes are, for the settings section (read again in a new language). */
function storageInfo() {
  return { text: t(android ? 'settings.onPhone' : inBrowser ? 'settings.inBrowser' : 'settings.onDisk') };
}

/** Ctrl+, and the palette's "Settings": the menu, open on its settings. */
function showSettings() {
  sideMenu?.open('settings');
}

const percentOf = (progress) => `${Math.round(Math.max(0, Math.min(1, progress || 0)) * 100)}%`;

/**
 * What the side menu shows, section by section (sidemenu.js). Each is drawn when shown, so it tells
 * what is true now. `close(then)` slides the menu away and then does the thing.
 */
function menuSections() {
  const c = () => copy();
  return {
    notes: (close) => [
      sideGroup(
        t('side.write'),
        sideItem({ icon: '⌂', text: t('home.title'), run: () => close(() => showHome()) }),
        sideItem({ icon: '＋', text: c().newNote, kbd: 'Ctrl+N', run: () => close(() => createNote()) }),
        sideItem({ icon: '▤', text: t('side.list'), kbd: 'Ctrl+B', run: () => close(toggleIndex) }),
        sideItem({ icon: '⌕', text: t('side.find'), kbd: 'Ctrl+K', run: () => close(() => openPalette()) }),
        isAtlas() ? sideItem({ icon: '▦', text: t('side.atlas'), kbd: 'Ctrl+M', run: () => close(toggleAtlas) }) : null,
        sideToggle({ icon: '◎', text: t('side.focus'), on: focusMode, toggle: () => close(() => toggleFocus()) }),
        sideItem({ icon: '◉', text: t('side.dictate'), kbd: 'Ctrl+Shift+D', run: () => close(toggleDictation) }),
        sideItem({ icon: '🌐', text: t('side.translate'), kbd: 'Ctrl+Shift+X', run: () => close(() => translateSelection()) }),
      ),
      sideGroup(
        t('side.files'),
        sideItem({ icon: '⇩', text: t('side.saveCopy'), run: () => close(() => exportNote(currentId)) }),
        sideItem({ icon: '⇊', text: t('side.exportAll'), run: () => close(exportAll) }),
        sideItem({ icon: '⇡', text: t('side.import'), run: () => close(importFiles) }),
        api.openNotesFolder ? sideItem({ icon: '▭', text: t('side.notesFolder'), run: () => close(() => api.openNotesFolder()) }) : null,
        api.openBackupsFolder ? sideItem({ icon: '⟲', text: t('side.backupsFolder'), run: () => close(() => api.openBackupsFolder()) }) : null,
      ),
    ],
    library: (close) => {
      if (!library) return [h('p', { class: 'side-empty' }, t('side.noLibrary'))];
      // the last book comes from storage: the card fills in a moment after the menu opens
      const resume = h('div', { class: 'side-resume', hidden: true });
      library.shelfSummary().then(({ count: total, last }) => {
        if (!resume.isConnected) return;
        resume.hidden = false;
        if (!last) {
          resume.replaceChildren(h('p', { class: 'side-empty' }, total ? t('side.openLibrary') : t('side.nothingYet')));
          if (total) resume.hidden = true;
          return;
        }
        resume.replaceChildren(
          h(
            'button',
            { type: 'button', class: 'side-book', onclick: () => close(() => (flushSave(), library.readDoc(last.id))) },
            h('span', { class: 'side-book-cover', 'aria-hidden': 'true' }, last.format.toUpperCase()),
            h(
              'span',
              { class: 'side-text' },
              h('span', { class: 'side-hint' }, t('side.continue')),
              h('span', { class: 'side-label' }, last.name),
              last.author ? h('span', { class: 'side-hint' }, last.author) : null,
              h('span', { class: 'side-progress', 'aria-hidden': 'true' }, h('i', { style: `width: ${percentOf(last.progress)}` })),
            ),
            h('span', { class: 'side-kbd' }, percentOf(last.progress)),
          ),
        );
      });
      return [
        resume,
        sideGroup(
          null,
          sideItem({ icon: '▥', text: t('side.openLibrary'), kbd: 'Ctrl+O', run: () => close(() => openLibrary()) }),
          sideItem({ icon: '⇡', text: t('side.addDocument'), hint: t('side.addDocumentHint'), run: () => close(() => openLibrary({ pick: true })) }),
        ),
        sideGroup(null, sideItem({ icon: 'Aa', text: t('side.readLook'), hint: t('side.readLookHint'), chevron: true, run: () => close(() => showAppearance()) })),
      ];
    },
    settings: (close) => [
      sideGroup(
        null,
        sideItem({ icon: '◐', text: t('side.darkLight'), kbd: 'Ctrl+Shift+L', run: toggleTheme }),
        sideItem({ icon: 'Aa', text: t('side.readLook'), hint: t('side.readLookHint'), chevron: true, run: () => close(() => showAppearance()) }),
      ),
      settingsSection({
        getData: storageInfo,
        getPrefs: () => ({ ...prefs }),
        onChange(patch) {
          if ('fontScale' in patch) applyFontScale(patch.fontScale);
          else if ('lang' in patch) setLanguage(patch.lang);
          else setLook(patch);
        },
      }),
    ],
    account: () => [
      profileSection(),
      sync ? sync.section() : h('p', { class: 'side-empty' }, t('side.noSync')),
      h('p', { class: 'side-version' }, t('side.version', typeof __VERSION__ === 'string' ? __VERSION__ : '')),
    ],
  };
}

// ---------- the main page and the person's profile ----------

/** The main page over everything: the book read last, the notes, the library. */
async function showHome() {
  closeIndexPanel();
  sideMenu?.close?.();
  const list = [...notes.values()].sort((a, b) => b.updated - a.updated).map((n) => ({ id: n.id, title: titleOf(n), updated: n.updated }));
  const shelf = library ? await library.shelfSummary().catch(() => null) : null;
  const leave = (then) => () => {
    hideHome();
    then();
  };
  drawHome(homeEl, {
    profile,
    notes: list,
    shelf,
    onMenu: () => sideMenu?.open('account'),
    onNote: (id) => {
      hideHome();
      if (id && id !== currentId) openNote(id);
      else editor.view.focus();
    },
    onNewNote: leave(() => createNote()),
    onLibrary: leave(() => (library ? openLibrary() : toast(t('home.noLibrary')))),
    onBook: (id) => {
      hideHome();
      flushSave();
      library?.readDoc(id);
    },
    onAddBook: leave(() => (library ? openLibrary({ pick: true }) : toast(t('home.noLibrary')))),
  });
  homeEl.hidden = false;
  document.body.classList.add('at-home');
  homeEl.querySelector('.home-book, .home-tile')?.focus({ preventScroll: true });
}

function hideHome() {
  if (homeEl.hidden) return;
  homeEl.hidden = true;
  document.body.classList.remove('at-home');
}

/** The menu button in the header is the person's avatar. */
function showAvatar() {
  const button = $('#btn-menu');
  button.replaceChildren(avatarNode(profile, 28));
  button.classList.add('tb-avatar');
  if (!homeEl.hidden) homeEl.querySelector('.home-avatar')?.replaceChildren(avatarNode(profile, 36));
}

function saveProfile(patch) {
  Object.assign(profile, patch);
  api.setState({ ...('avatar' in patch ? { avatar: patch.avatar } : {}), ...('name' in patch ? { profileName: patch.name } : {}) }).catch((err) => toast(err.message));
  showAvatar();
}

/** Account: the picture and the name, above the sync section. */
function profileSection() {
  const picture = h('span', { class: 'profile-pic' }, avatarNode(profile, 72));
  const choose = () => {
    const input = h('input', { type: 'file', accept: 'image/*' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        saveProfile({ avatar: await shrinkPicture(file) });
        picture.replaceChildren(avatarNode(profile, 72));
        remove.hidden = false;
      } catch {
        toast(t('profile.badPicture'));
      }
    });
    input.click();
  };
  const remove = h(
    'button',
    {
      type: 'button',
      class: 'tb-btn',
      hidden: !profile.avatar,
      onclick: () => {
        saveProfile({ avatar: null });
        picture.replaceChildren(avatarNode(profile, 72));
        remove.hidden = true;
      },
    },
    t('profile.removePicture'),
  );
  const name = h('input', { class: 'field profile-name', type: 'text', maxlength: '60', placeholder: t('profile.namePlaceholder'), 'aria-label': t('profile.name') });
  name.value = profile.name;
  let nameTimer = 0;
  name.addEventListener('input', () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => {
      saveProfile({ name: name.value.trim().slice(0, 60) });
      picture.replaceChildren(avatarNode(profile, 72));
    }, 400);
  });
  return h(
    'div',
    { class: 'profile' },
    h('button', { type: 'button', class: 'profile-pic-btn', title: t('profile.choosePicture'), 'aria-label': t('profile.choosePicture'), onclick: choose }, picture),
    h(
      'div',
      { class: 'profile-fields' },
      name,
      h('div', { class: 'profile-actions' }, h('button', { type: 'button', class: 'tb-btn', onclick: choose }, t('profile.choosePicture')), remove),
    ),
  );
}

// ---------- commands & keys ----------

function commandList() {
  const c = copy();
  // keywords hold both languages, so a command is found whatever the interface speaks
  const list = [
    { icon: '＋', title: c.newNote, kbd: 'Ctrl+N', keywords: 'new создать', run: () => createNote() },
    { icon: '◐', title: t(effectiveTheme() === 'dark' ? 'commands.light' : 'commands.dark'), kbd: 'Ctrl+Shift+L', keywords: 'theme тема', run: toggleTheme },
    {
      icon: '◇',
      title: t(isAtlas() ? 'commands.toMinimal' : 'commands.toAtlas'),
      keywords: 'skin look оформление дизайн atlas minimal атлас минимал',
      run: () => setLook({ skin: isAtlas() ? 'minimal' : 'atlas' }),
    },
    { icon: '⚙', title: t('commands.settings'), kbd: 'Ctrl+,', keywords: 'settings настройки accent акцент цвет font шрифт size размер', run: showSettings },
    {
      icon: '⇄',
      title: t('commands.otherLang'),
      keywords: 'language язык english английский русский russian interface интерфейс',
      run: () => setLanguage(prefs.lang === 'ru' ? 'en' : 'ru'),
    },
    { icon: '▤', title: t('commands.sidebar'), kbd: 'Ctrl+B', keywords: 'sidebar list панель список', run: toggleIndex },
    { icon: '◎', title: t(focusMode ? 'commands.unfocus' : 'commands.focus'), kbd: 'Ctrl+.', keywords: 'focus фокус', run: () => toggleFocus() },
    { icon: '❝', title: t('commands.comment'), kbd: 'Ctrl+Shift+M', keywords: 'comment комментарий', run: () => requestComment(editor.view) },
    { icon: '⌗', title: t('commands.codeBlock'), kbd: 'Ctrl+E', keywords: 'code код', run: () => insertCodeBlock(editor.view) },
    { icon: '⇩', title: t('commands.saveCopy'), keywords: 'export save экспорт скачать', run: () => exportNote(currentId) },
    { icon: '⇊', title: t('commands.exportAll'), keywords: 'backup download резервная копия архив экспорт zip', run: exportAll },
    { icon: '⇡', title: t('commands.import'), keywords: 'import upload files импорт загрузить файлы', run: importFiles },
    { icon: '◉', title: t('commands.dictate'), kbd: 'Ctrl+Shift+D', keywords: 'dictate voice speech microphone диктовка голос речь микрофон', run: toggleDictation },
    { icon: '🌐', title: t('commands.translate'), kbd: 'Ctrl+Shift+X', keywords: 'translate translation english russian перевод перевести английский русский', run: () => translateSelection() },
  ];
  if (isAtlas()) list.splice(1, 0, { icon: '▦', title: t('commands.atlas'), kbd: 'Ctrl+M', keywords: 'atlas map archipelago карта архипелаг', run: toggleAtlas });
  if (library) {
    list.splice(
      1,
      0,
      { icon: '▥', title: t('commands.library'), kbd: 'Ctrl+O', keywords: 'library books read pdf библиотека книги читать документы', run: () => openLibrary() },
      {
        icon: '⇡',
        title: t('commands.addDocument'),
        keywords: 'add book document pdf epub fb2 docx word добавить книгу документ',
        run: () => openLibrary({ pick: true }),
      },
    );
  }
  if (api.openNotesFolder) list.push({ icon: '▭', title: t('commands.notesFolder'), keywords: 'folder files папка файлы', run: () => api.openNotesFolder() });
  if (api.openBackupsFolder) {
    list.push({
      icon: '⟲',
      title: t('commands.backupsFolder'),
      keywords: 'backup restore update бэкап резервная копия восстановить обновление',
      run: () => api.openBackupsFolder(),
    });
  }
  return list;
}

function openPalette(initial = '') {
  commandPalette({
    initial,
    notes: [...notes.values()]
      .sort((a, b) => b.updated - a.updated)
      .map((n) => ({ id: n.id, title: titleOf(n), meta: `${when(n.updated)} · ${count(n.info.words, 'wordShort')}`, content: n.content })),
    commands: commandList(),
    onPick: (id) => openNote(id),
    onCreate: (title) => createNote(`# ${title}\n\n`),
  });
}

function toggleAtlas() {
  if (!isAtlas()) return;
  if (atlas.isOpen) {
    atlas.hide();
    return;
  }
  refreshAnalysis();
  flushSave();
  atlas.show();
}

function onGlobalKey(e) {
  if (e.key === 'Escape' && translator.isOpen()) {
    e.preventDefault();
    e.stopPropagation();
    translator.close();
    return;
  }
  if (library?.isOpen()) {
    library.onKey(e);
    return;
  }
  if (e.key === 'Escape' && dictation?.listening && !isOverlayOpen()) {
    e.preventDefault();
    dictation.stop();
    return;
  }
  if (e.key === 'Escape' && $('#app').classList.contains('index-open') && !isOverlayOpen()) {
    closeIndexPanel();
    editor.view.focus();
    return;
  }
  if (e.key === 'Escape' && focusMode && !isOverlayOpen() && !atlas.isOpen) {
    toggleFocus(false);
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey || isOverlayOpen() || suspended) return;
  // e.code, not e.key, so shortcuts work on the Russian layout too
  const { code, shiftKey } = e;
  let handled = true;
  if (code === 'KeyN' && !shiftKey) createNote();
  else if (code === 'KeyP' && shiftKey) openPalette('>');
  else if ((code === 'KeyP' || code === 'KeyK') && !shiftKey) openPalette();
  else if (code === 'KeyM' && shiftKey) requestComment(editor.view);
  else if (code === 'KeyM' && isAtlas()) toggleAtlas();
  else if (code === 'KeyB' && !shiftKey) toggleIndex();
  else if (code === 'KeyD' && shiftKey) toggleDictation();
  else if (code === 'KeyX' && shiftKey) translateSelection();
  else if (code === 'KeyO' && !shiftKey && library) {
    flushSave();
    openLibrary();
  }
  else if (code === 'KeyL' && shiftKey) toggleTheme();
  else if (code === 'Comma') showSettings();
  else if (code === 'Period') toggleFocus();
  else if (code === 'KeyS' && !shiftKey) {
    if (dirty) flushSave();
    else setSaveState('saved', notes.get(currentId)?.updated);
  } else if (code === 'Equal' || code === 'NumpadAdd') applyFontScale(prefs.fontScale + 0.08);
  else if (code === 'Minus' || code === 'NumpadSubtract') applyFontScale(prefs.fontScale - 0.08);
  else if (code === 'Digit0' || code === 'Numpad0') applyFontScale(1);
  else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function bindChrome() {
  $('#btn-new').addEventListener('click', () => createNote());
  $('#btn-new-2').addEventListener('click', () => {
    closeIndexPanel();
    createNote();
  });
  $('#btn-index').addEventListener('click', toggleIndex);
  // the sliding panel closes on a click anywhere else, and when the window grows wide again
  document.addEventListener('pointerdown', (e) => {
    if ($('#app').classList.contains('index-open') && !e.target.closest('#index, #btn-index')) closeIndexPanel();
  });
  narrow.addEventListener('change', closeIndexPanel);
  $('#btn-atlas').addEventListener('click', toggleAtlas);
  // the button must not take the focus (and the cursor) away from the text
  $('#btn-dictate').addEventListener('pointerdown', (e) => e.preventDefault());
  $('#btn-dictate').addEventListener('click', toggleDictation);
  $('#btn-translate').addEventListener('pointerdown', (e) => e.preventDefault());
  $('#btn-translate').addEventListener('click', () => translateSelection());
  $('#btn-find').addEventListener('click', () => openPalette());
  $('#btn-menu').addEventListener('click', () => {
    closeIndexPanel();
    sideMenu.toggle();
  });
  const filter = $('#index-filter');
  filter.addEventListener('input', renderIndex);
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#index-list .idx-item')?.click();
    if (e.key === 'Escape') {
      filter.value = '';
      renderIndex();
      editor.view.focus();
    }
  });
  systemDark.addEventListener('change', () => {
    if (prefs.theme === 'system') applyLook({ persist: false });
  });
  window.addEventListener('keydown', onGlobalKey, true);
  window.addEventListener('pagehide', () => {
    flushOnExit();
    library?.flush();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushSave();
      rememberPosition();
      library?.flush();
    } else {
      ping(); // back from a hidden or sleeping state: tell the server at once
    }
  });
  window.addEventListener('blur', () => flushSave());
}

// A small handle for checking the app from the outside (browser console, automated runs).
window.__atlas = {
  ready,
  summary: () => {
    const note = notes.get(currentId);
    return {
      notes: notes.size,
      currentId,
      title: titleOf(note),
      words: note?.info.words,
      headings: note?.info.headings.map((hd) => hd.text),
      look: { skin: prefs.skin, theme: prefs.theme, accent: prefs.accent },
      lang: prefs.lang,
      save: $('#sb-save').dataset.state,
    };
  },
  setLanguage,
  text: () => editor.view.state.doc.toString(),
  type(text) {
    const { view } = editor;
    view.dispatch({ changes: { from: view.state.doc.length, insert: text }, selection: { anchor: view.state.doc.length + text.length }, userEvent: 'input.type' });
  },
  newNote: (content) => createNote(content),
  comment: (line, body) => insertComment(editor.view, line, body),
  openCommentDialog: (line) => requestComment(editor.view, line),
  menuAtLine(lineNumber) {
    const { view } = editor;
    const pos = view.state.doc.line(lineNumber).from + 2;
    view.dispatch({ selection: { anchor: pos } });
    const c = view.coordsAtPos(pos);
    openEditorMenu({ clientX: c.left + 12, clientY: c.bottom + 6 }, view);
  },
  paste: (text) => pasteText(editor.view, text, onSmartPaste),
  addImage: (blob) => addImage(blob, null),
  backupFiles: async () => (await backupFiles()).map((file) => ({ name: file.name, size: file.bytes?.length ?? file.text.length })),
  palette: (initial) => openPalette(initial),
  settings: showSettings,
  setLook,
  toggleAtlas,
  toggleFocus,
  flush: () => {
    library?.flush();
    return flushSave();
  },
  library: () => library,
  /** The Android back button: closes the topmost thing that is open; false when nothing was. */
  back() {
    if (dictation?.listening) {
      dictation.stop();
      return true;
    }
    if (isOverlayOpen()) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    }
    if (library?.back()) return true;
    if ($('#app').classList.contains('index-open')) {
      closeIndexPanel();
      return true;
    }
    if (atlas?.isOpen) {
      atlas.hide();
      return true;
    }
    if (focusMode) {
      toggleFocus(false);
      return true;
    }
    if (homeEl.hidden) {
      showHome();
      return true;
    }
    return false;
  },
  /** Android: another app handed files over while ATLAS was running. */
  incoming: () => receiveIncoming(),
  /** Android: what the phone's speech recognition heard (see dictation.js). */
  dictation: (event) => dictation?.receive(event),
  /** Android: ML Kit's answer to a translation (see translate.js). */
  translate: (event) => translator.receive(event),
  toggleDictation: () => toggleDictation(),
};

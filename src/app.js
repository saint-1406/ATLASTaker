// ATLAS Notetaker, renderer entry point: wires the editor, the chrome around it (in one of two looks)
// and keeps every keystroke saved.

import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { android, api, rescue } from './bridge.js';
import { icon } from './icons.js';
import { fingerFirst } from './touch.js';
import { flip, motionEnabled, navigate, setMotion, shared, stagger } from './motion.js';
import { catsOn, catWords, isCatWords, restoreCats, setCats } from './cats.js';
import { createLibrary } from './library.js';
import { insertComment, insertCodeBlock, insertDictation, pasteText, codeLanguageAt, showDictationPreview, urlAt } from './editor.js';
import { createEditor } from './noteEditor.js';
import { createDictation } from './dictation.js';
import { createTranslator } from './translateCard.js';
import { analyze, imageRefs } from './markdown.js';
import { commentTarget, commentsUnder, formatStamp } from './comments.js';
import { DEFAULT_LOOK, LOOK_VERSION, normalizeLook, normalizeReading, PALETTES, toneOf } from './skins.js';
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
import { addReading, avatarNode, createTabBar, dayKey, drawHome, GOALS, shrinkPicture, streakOf, TABS } from './home.js';
import { createNotesScreen } from './notesScreen.js';
import { createTrash } from './trash.js';
import { createUpdater } from './update.js';
import { stepButtons } from './undo.js';
import { askPin, checkPin, coverEarly, createLock, hashPin, LOCK_AFTER } from './lock.js';
import { createStatsStrip, openWritingStats } from './writingStats.js';
import { createFormatBar, normalizeTools, openToolsDialog } from './formatBar.js';
import { openVersions } from './versions.js';
import { textStats } from './stats.js';
import { noteWriting } from './writing.js';
import { VERSION_EVERY } from './versionRules.js';
import { htmlPage, toHtml, toText } from './exporters.js';
import { insertAccordionBlock } from './accordionView.js';
import { askTag, collectTags, openTags } from './tags.js';

// a device with a PIN shows nothing of its notes until the PIN is in (lock.js)
coverEarly();

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
const trashedNotes = new Map(); // id → a note in the trash: whole, out of every list, until restored or deleted for good
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
let updater = null; // newer versions: checked, and on Android installed from inside the app (update.js)
let noteSteps = null; // ↶ ↷ in the title bar: the open note's text, one step back or forward (undo.js)
// writing (0.17): the statistics strip, the formatting bar, what focus mode dims (all synced settings)
// markup: 'hide' shows a note as it reads (livePreview.js), 'show' as it is typed
const writing = { statsBar: true, formatBar: 'always', formatTools: null, focusDim: 'paragraph', editorMode: 'visual' };
const writeLog = { writeDays: {}, growDays: {} }; // characters written and the text's growth per day (writing.js)
let pendingWritten = 0; // not yet in writeLog: it is saved every few seconds, not on every key
let pendingGrown = 0;
let writeLogTimer = 0;
let pinLock = null; // this device's PIN, hashed (lock.js); null: none
const lockScreen = createLock({ getLock: () => pinLock });
const statsStrip = createStatsStrip({ onOpen: () => showWritingStats() });
const formatBar = createFormatBar({
  getView: () => editor?.view ?? null,
  actions: { image: () => pickImage(), copy: () => copyFromBar(), note: (id) => noteTool(id), mode: () => writing.editorMode },
});
const versionKept = new Map(); // note id → when a version of it was last kept in this window
let lastStats = null; // the open note's textStats(), for the strip's pace updates in between
let trashView = null; // the trash: deleted notes, documents and marks, until restored or deleted for good (trash.js)
const profile = { avatar: null, name: '' }; // the picture and the name the person gave (Account)
const homeEl = h('section', { class: 'home', hidden: true }); // the main page (home.js)
const readingLog = { days: {}, goal: 20 }; // minutes read per day, and the day's goal (home.js)
let readingClock = 0;
const tabBar = createTabBar((tab) => pickTab(tab)); // the tabs at the foot of the main page and the library
let readingTimer = 0;
let noteFolders = []; // the notes' folders in order (noteFolders.js); each note names its own
const notesScreen = createNotesScreen({
  getNotes: () => [...notes.values()],
  getSaved: () => noteFolders,
  saveFolders: (list) => {
    noteFolders = list;
    return api.setState({ noteFolders: list }).catch((err) => toast(err.message));
  },
  moveNote: async (id, folder) => {
    const note = notes.get(id);
    if (!note) return;
    note.folder = folder;
    await api.setFolder?.(id, folder).catch((err) => toast(err.message));
  },
  deleteNote: (id, options) => deleteNote(id, options),
  restoreNote: (id) => restoreNote(id),
  onOpen: (id) => {
    // the card grows into the editor: it and the editor's sheet share a name for the transition
    const card = notesScreen.node.querySelector(`.notes-card[data-id="${CSS.escape(id)}"]`);
    const sheet = $('#sheet');
    const forget = shared(card ? [card] : [], () => 'm-hero');
    navigate('up', async () => {
      forget();
      hideNotes();
      if (id !== currentId) await openNote(id);
      else editor.view.focus();
      if (card && sheet) sheet.style.viewTransitionName = 'm-hero';
    }).finally(() => {
      if (sheet) sheet.style.viewTransitionName = '';
    });
  },
  onCreate: (folder) => {
    hideNotes();
    createNote('', { folder });
  },
  onBack: () => showHome(),
  onTrash: () => trashView?.open('notes'),
  // the easter egg (cats.js): the words sent from the search turn the cat look on, or off again
  onSearchEnter: (text) => {
    if (!isCatWords(text)) return false;
    catWords().then((on) => {
      applyBars();
      toast(t(on ? 'cats.on' : 'cats.off'), { timeout: 4500 });
    });
    return true;
  },
});
restoreCats();

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
  // nothing of the notes was drawn: the cover put up for a PIN must not hide what went wrong
  document.documentElement.classList.remove('locked');
  showBlocker({
    title: t('boot.title'),
    text: t('boot.text', err.message),
    action: { text: t('boot.reload'), run: () => location.reload() },
  });
});

async function boot() {
  await claimWindow();
  const saved = (await api.getState()) ?? {};
  readWriting(saved);
  lockScreen.start(); // with a PIN, the lock is up before any note is drawn
  Object.assign(prefs, normalizeLook({ ...prefs, ...pickDefined(saved, ['skin', 'theme', 'accent']) }));
  if (typeof saved.sidebar === 'boolean') prefs.sidebar = saved.sidebar;
  if (typeof saved.fontScale === 'number') prefs.fontScale = saved.fontScale;
  if (typeof saved.avatar === 'string') profile.avatar = saved.avatar;
  if (typeof saved.profileName === 'string') profile.name = saved.profileName;
  if (saved.readDays && typeof saved.readDays === 'object') readingLog.days = saved.readDays;
  if (Number.isInteger(saved.readGoal)) readingLog.goal = saved.readGoal;
  if (Array.isArray(saved.noteFolders)) noteFolders = saved.noteFolders;
  // 0.13 brought the cosy look: every install is moved to it once (the theme can be changed back in Settings)
  // (quiet: a move made for the person, not their choice — a look set on another device wins over it)
  if ((saved.lookVersion ?? 0) < LOOK_VERSION) {
    Object.assign(prefs, DEFAULT_LOOK);
    api.setState({ ...DEFAULT_LOOK, lookVersion: LOOK_VERSION, $quiet: true }).catch(() => {});
  }
  Object.assign(prefs, normalizeReading(saved));
  // the language is settled once and stored, so it no longer follows the browser's afterwards
  const lang = pickLang({ saved: saved.lang, existing: Boolean(saved.welcomed), preferred: browserLanguages() });
  if (saved.lang !== lang) api.setState({ lang, $quiet: true }).catch(() => {});
  if (lang !== prefs.lang) {
    prefs.lang = lang;
    applyLanguage({ persist: false });
  }
  applySidebar(prefs.sidebar, { persist: false });
  applyFontScale(prefs.fontScale, { persist: false });

  let list = await api.list();
  for (const note of list) if (note.trashed) trashedNotes.set(note.id, note);
  list = list.filter((note) => !note.trashed);
  const firstRun = !list.length && !saved.welcomed && !trashedNotes.size;
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
    touch: phone,
    onModeChange: (editorMode) => setWriting({ editorMode }),
  });
  editor.view.scrollDOM.addEventListener(
    'scroll',
    () => {
      schedulePositionSave();
      updateProgress();
    },
    { passive: true },
  );
  $('#editor').addEventListener('formatstatechange', () => formatBar.refresh());
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
      onSystemBars: (reading, shown) => android?.setReading?.(reading, shown),
      onQuote: quoteToNote,
      onOpenNote: (id) => {
        hideNotes();
        openNote(id);
      },
      onLink: (url) => api.openExternal(url),
      onOpenTrash: (tab) => trashView?.open(tab),
      onTrash: () => trashView?.refresh(),
      // the main page stays under the library: back there (its progress drawn again), or back to the note
      onClose: () => (notesScreen.isOpen() ? notesScreen.refresh() : homeEl.hidden ? editor.view.focus() : showHome()),
    });
  }
  trashView = createTrash({ getNotes: () => [...trashedNotes.values()], restoreNote, purgeNote, library });
  sideMenu = createSideMenu({ sections: menuSections(), onClose: () => editor.view.focus({ preventScroll: true }) });
  bindChrome();
  applyLook({ persist: false });
  applyWriting();

  const fonts = ['500 16px "Inter Variable"', '500 10px "JetBrains Mono Variable"', 'italic 600 16px "Cormorant Garamond"'];
  await Promise.all([...fonts.map((f) => document.fonts.load(f)), document.fonts.ready].map((p) => p.catch(() => {})));
  const restoredId = drafts.length ? await offerRestore(drafts) : null;
  await openNote(restoredId ?? (notes.has(saved.lastOpen) ? saved.lastOpen : newestId()));
  if (inBrowser && !firstRun && !drafts.length && Date.now() - (saved.lastBackup ?? 0) > BACKUP_EVERY) remindBackup(saved.lastBackup);
  if (api.ping) setInterval(ping, 20_000);
  setInterval(tickPace, 10_000);
  markReady();
  // the app opens on the main page, where the person picks where to go
  document.body.append(homeEl, notesScreen.node, tabBar.node);
  new MutationObserver(updateTabs).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  readingClock = setInterval(countReading, 30_000);
  showAvatar();
  // sync and updates come before the main page is drawn (which waits for the library): the account
  // tab has them as soon as the app is up
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
  updater = createUpdater({
    api,
    android,
    h,
    toast,
    // what is being typed, and the open book's place and marks, are kept (and synced) before the installer opens
    beforeInstall: async () => {
      library?.flush();
      await flushSave();
      if (sync?.signedIn()) await sync.runQuiet();
    },
  });
  updater?.start();
  await showHome();
  if (android) receiveIncoming();
}

/** A sync round brought notes, cards or settings from another device: show them. */
async function afterSync({ pulled, trashed, conflicts, docsChanged, first, trashChanged = false, settingsChanged = [] }) {
  if (docsChanged) await library?.reload();
  if (settingsChanged.length) await applySyncedSettings();
  if (!pulled.length && !trashed.length && !conflicts.length && !trashChanged) return;
  if (first) {
    // a device signing in for the first time: its untouched welcome note would sit next to the one the
    // other devices already have; it goes to the trash (and, being untouched, off the Drive next round)
    const welcomes = new Set(Object.values(WELCOME).flatMap((byKind) => Object.values(byKind)));
    for (const note of [...notes.values()]) {
      if (pulled.includes(note.id) || !welcomes.has(note.content) || (note.id === currentId && dirty)) continue;
      await api.trash(note.id).catch(() => {});
    }
  }
  const all = await api.list();
  trashedNotes.clear();
  for (const note of all) if (note.trashed) trashedNotes.set(note.id, note);
  const fresh = new Map(all.filter((n) => !n.trashed).map((n) => [n.id, n]));
  // typed into here while another device put it in the trash: the typing wins, the note comes back out
  if (currentId && dirty && trashedNotes.has(currentId)) {
    const back = trashedNotes.get(currentId);
    trashedNotes.delete(currentId);
    fresh.set(currentId, { ...back, trashed: 0 });
    await api.setTrashed(currentId, 0).catch(() => {});
  }
  for (const [id, note] of fresh) {
    const known = notes.get(id);
    if (known && known.content === note.content) {
      known.folder = note.folder ?? '';
      continue;
    }
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
    // the open note went (to the trash, or for good) on another device: another one opens, or a fresh one
    currentId = null;
    if (notes.size) await openNote(newestId());
    else await createNote();
  }
  for (const { id } of conflicts) toast(t('sync.conflict', titleOf(notes.get(id))), { timeout: 8000 });
  renderIndex();
  refreshChrome();
  notesScreen.refresh();
  trashView?.refresh();
}

/** Settings set on another device came in: the look, language, reading, profile and folders follow them now. */
async function applySyncedSettings() {
  const saved = (await api.getState().catch(() => null)) ?? {};
  readWriting(saved);
  applyWriting();
  Object.assign(prefs, normalizeLook({ ...prefs, ...pickDefined(saved, ['skin', 'theme', 'accent']) }));
  Object.assign(prefs, normalizeReading(saved));
  if (typeof saved.sidebar === 'boolean' && saved.sidebar !== prefs.sidebar) applySidebar(saved.sidebar, { persist: false });
  if (typeof saved.fontScale === 'number' && saved.fontScale !== prefs.fontScale) applyFontScale(saved.fontScale, { persist: false });
  if (typeof saved.avatar === 'string' || saved.avatar === null) profile.avatar = saved.avatar;
  if (typeof saved.profileName === 'string') profile.name = saved.profileName;
  if (saved.readDays && typeof saved.readDays === 'object') readingLog.days = saved.readDays;
  if (Number.isInteger(saved.readGoal)) readingLog.goal = saved.readGoal;
  if (Array.isArray(saved.noteFolders)) noteFolders = saved.noteFolders;
  if ((saved.lang === 'ru' || saved.lang === 'en') && saved.lang !== prefs.lang) {
    prefs.lang = saved.lang;
    applyLanguage({ persist: false });
    await library?.relocalize?.();
  } else applyLook({ persist: false });
  showAvatar();
  notesScreen.refresh();
  if (!homeEl.hidden && sideMenu?.isOpen?.() !== true) await showHome();
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
  if (pick) return library.pickFiles();
  return library.open();
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
    if (!notesScreen.isOpen()) editor.view.focus();
    return;
  }
  if (dictation?.listening) dictation.stop(); // the words would land in another note
  if (currentId && !(await leaveCurrent())) {
    toast(t('notes.stayed'));
    return;
  }

  currentId = id;
  note.blankAtOpen = !note.content.trim();
  editor.show(editorStates.get(id) ?? editor.makeState(note.content, savedSelection(note)));
  editor.localize(); // a kept state may still speak the language it was made in
  showNoteSteps(); // each note keeps its own history
  applyFocusDim(); // and its own editor state, where focus's dimming lives
  refreshStats();
  // on a phone a note with text opens for reading (no stray tap changes it); ✎ turns writing on
  setEditing(!(phone && !note.blankAtOpen));
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
  // under the notes screen the note only gets ready: a focus there would bring up a phone's keyboard
  if (!notesScreen.isOpen()) editor.view.focus();
}

// ---------- reading or writing ----------

let editing = true; // the open note takes typing; off, it is only read (✎ in the title bar)
let readHintAt = 0;

/** Writing on or off for the open note; on, the cursor is placed and (on a phone) the keyboard comes up. */
function setEditing(on, { focus = false } = {}) {
  editing = on;
  editor.setEditable(on);
  const button = $('#btn-edit');
  button.setAttribute('aria-pressed', String(on));
  button.title = t(on ? 'notes.read' : 'notes.edit');
  button.setAttribute('aria-label', button.title);
  document.documentElement.classList.toggle('note-reading', !on);
  showFormatBar();
  if (on && focus) editor.view.focus();
  if (!on) editor.view.contentDOM.blur();
}

/** A command that writes into the note (a comment, dictation, a code block…) turns writing on first. */
function ensureEditing() {
  if (!editing) setEditing(true);
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

async function createNote(content = '', { folder = '' } = {}) {
  if (suspended || lost) return;
  if (currentId && !content && !editor.view.state.doc.length) {
    // already standing on a blank page: it moves to the folder asked for
    const blank = notes.get(currentId);
    if (blank && (blank.folder ?? '') !== folder) {
      blank.folder = folder;
      api.setFolder?.(currentId, folder).catch(() => {});
    }
    editor.view.focus();
    return;
  }
  const note = await api.create(content);
  if (folder) {
    note.folder = folder;
    await api.setFolder?.(note.id, folder).catch((err) => toast(err.message));
  }
  notes.set(note.id, { ...note, info: analyze(note.content) });
  await openNote(note.id);
  if (content) editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
}

/**
 * Into the trash: the note leaves every list but stays whole (its text, folder and dates), on every
 * device that syncs, until it is restored or deleted for good from the trash. No question asked: one
 * tap on "Undo" brings it back, and the trash keeps it after that. `quiet`: no toast (a step taken
 * again with ↷ on the notes screen).
 */
async function deleteNote(id, { quiet = false } = {}) {
  const note = notes.get(id);
  if (!note) return false;
  const wasOpen = id === currentId;
  // what was typed last goes into the trash with it
  if (wasOpen && !(await flushSave())) {
    toast(t('notes.deleteFailed', t('notes.notSaved')));
    return false;
  }
  const when = Date.now();
  try {
    await api.setTrashed(id, when);
  } catch (err) {
    toast(t('notes.deleteFailed', err.message));
    return false;
  }
  if (wasOpen) {
    rememberPosition();
    dirty = false;
    currentId = null;
  }
  trashedNotes.set(id, { ...note, content: wasOpen ? editor.view.state.doc.toString() : note.content, trashed: when });
  forget(id);
  if (!notes.size) await createNote();
  else if (wasOpen && !notesScreen.isOpen()) await openNote(newestId());
  renderIndex();
  notesScreen.refresh();
  trashView?.refresh();
  if (!quiet) toast(t('trash.noteMoved', titleOf(note)), { action: { text: t('trash.undo'), run: () => restoreNote(id) }, timeout: 7000 });
  return true;
}

/** Out of the trash, back where it was (its folder too). */
async function restoreNote(id) {
  const note = trashedNotes.get(id);
  if (!note) return false;
  try {
    await api.setTrashed(id, 0);
  } catch (err) {
    toast(err.message);
    return false;
  }
  trashedNotes.delete(id);
  notes.set(id, { ...note, trashed: 0, info: analyze(note.content) });
  renderIndex();
  notesScreen.refresh();
  trashView?.refresh();
  return true;
}

/** Deleted for good: only from the trash. The file still waits out of sight (notes\.trash) on Windows. */
async function purgeNote(id) {
  if (!trashedNotes.has(id)) return false;
  try {
    await api.trash(id);
  } catch (err) {
    toast(err.message);
    return false;
  }
  trashedNotes.delete(id);
  rescue.drop(id);
  trashView?.refresh();
  return true;
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
  ensureEditing();
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

/** ↶ ↷ in the title bar can be pressed when the open note has something to undo or redo. */
function showNoteSteps() {
  noteSteps?.update(editor.steps());
}

// ---------- writing (0.17): statistics, the formatting bar, focus dimming, versions, the PIN ----------

/** The writing settings, the writing log and this device's PIN, from the app's state. */
function readWriting(saved) {
  if (typeof saved.statsBar === 'boolean') writing.statsBar = saved.statsBar;
  if (['touch', 'always', 'off'].includes(saved.formatBar)) writing.formatBar = saved.formatBar;
  if (Array.isArray(saved.formatTools)) writing.formatTools = saved.formatTools;
  if (['paragraph', 'sentence', 'off'].includes(saved.focusDim)) writing.focusDim = saved.focusDim;
  if (saved.editorMode === 'visual' || saved.editorMode === 'source') writing.editorMode = saved.editorMode;
  if (saved.writeDays && typeof saved.writeDays === 'object') writeLog.writeDays = saved.writeDays;
  if (saved.growDays && typeof saved.growDays === 'object') writeLog.growDays = saved.growDays;
  pinLock = saved.pinLock && typeof saved.pinLock === 'object' ? saved.pinLock : null;
}

function applyWriting() {
  statsStrip.node.hidden = !writing.statsBar;
  formatBar.setTools(writing.formatTools);
  showFormatBar();
  applyFocusDim();
  if (editor) refreshStats();
}

function setWriting(patch) {
  Object.assign(writing, patch);
  api.setState(patch).catch((err) => toast(err.message));
  applyWriting();
  sideMenu?.refresh();
}

/** The formatting bar shows while a note is written: on a phone, or everywhere if so chosen. */
function showFormatBar() {
  const wanted = writing.formatBar === 'always' || (writing.formatBar === 'touch' && phone);
  // reading a note, the bar stays with what does not write in it (copy, tags, versions, export…)
  const show = wanted && Boolean(currentId);
  formatBar.node.hidden = !show;
  formatBar.setEditing(editing);
  $('#app').classList.toggle('formatting', show);
}

/** The note's own tools on the bar (they are also in the ⋯ menu). */
function noteTool(id) {
  if (!notes.get(currentId)) return;
  const run = {
    paste: () => editor && pasteFromClipboard(editor.view),
    selectAll: selectAllNote,
    copyAll,
    tag: tagSelection,
    tags: showTags,
    versions: showVersions,
    stats: showWritingStats,
    mode: () => setWriting({ editorMode: writing.editorMode === 'source' ? 'visual' : 'source' }),
    md: () => exportNote(currentId),
    txt: () => exportAs('txt'),
    html: () => exportAs('html'),
    pdf: () => exportAs('pdf'),
    clear: clearPage,
  }[id];
  run?.();
  formatBar.refresh();
}

/**
 * In focus mode, everything but the paragraph or sentence being written fades (focusDim.js); and the
 * marks are hidden or shown (livePreview.js). Each note's state carries both, so this follows show().
 */
function applyFocusDim() {
  const lit = focusMode && writing.focusDim !== 'off';
  editor?.setFocusDim(lit ? writing.focusDim : null, prefs.lang);
  editor?.setMode(writing.editorMode);
  $('#app').classList.toggle('focus-lit', lit);
}

// ---------- the note's own menu (⋯ in the title bar): copy, clear, tags, export ----------

function openNoteMenu(anchor) {
  const note = notes.get(currentId);
  if (!note) return;
  const r = anchor.getBoundingClientRect();
  showMenu(r.right, r.bottom + 4, [
    { header: titleOf(note) },
    { icon: '＋', text: t('rich.insertBlock'), run: () => { ensureEditing(); formatBar.openInsert(anchor); } },
    { icon: '¶', text: t('rich.visual'), run: () => setWriting({ editorMode: 'visual' }) },
    { icon: '</>', text: t('rich.source'), run: () => setWriting({ editorMode: 'source' }) },
    { icon: icon('copy'), text: t('noteMenu.copyAll'), run: copyAll },
    { icon: '#', text: t('noteMenu.tag'), run: tagSelection },
    { icon: '⌗', text: t('tags.title'), run: showTags },
    { icon: '◴', text: t('versions.title'), run: showVersions },
    { icon: '∑', text: t('stats.title'), run: showWritingStats },
    '-',
    { header: t('noteMenu.export') },
    { icon: 'MD', text: t('noteMenu.md'), run: () => exportNote(currentId) },
    { icon: 'TXT', text: t('noteMenu.txt'), run: () => exportAs('txt') },
    { icon: 'HTML', text: t('noteMenu.html'), run: () => exportAs('html') },
    { icon: 'PDF', text: t('noteMenu.pdf'), run: () => exportAs('pdf') },
    '-',
    { icon: '⌫', text: t('noteMenu.clear'), className: 'danger', run: clearPage },
  ]);
}

async function copyAll() {
  try {
    await api.copy(editor.getPlainText());
    toast(t('noteMenu.copied'));
  } catch (err) {
    toast(err.message);
  }
}

/** The whole page emptied: one step (↶ brings it back), and the text is kept as a version first. */
async function clearPage() {
  const id = currentId;
  const text = editor.view.state.doc.toString();
  if (!text) return;
  await keepVersion(id, text, { force: true });
  setEditing(true);
  editor.view.dispatch({ changes: { from: 0, to: text.length, insert: '' }, userEvent: 'delete.clear' });
  toast(t('noteMenu.cleared'), { timeout: 7000, action: { text: t('trash.undo'), run: () => editor.undo() } });
}

/** Every note with its text now (the open one as it is in the editor) and its title, for the tags. */
function notesNow() {
  return [...notes.values()].map((note) => ({ id: note.id, title: titleOf(note), content: note.id === currentId ? editor.view.state.doc.toString() : note.content }));
}

/** The selected passage gets a tag right after it (or the word itself becomes the tag). */
async function tagSelection() {
  const { state } = editor.view;
  const range = state.selection.main;
  const picked = state.sliceDoc(range.from, range.to).trim();
  const word = /^[\p{L}\p{N}_-]{1,60}$/u.test(picked) ? picked : '';
  const tag = await askTag({ tags: collectTags(notesNow()), initial: word });
  if (!tag) return;
  setEditing(true);
  const { view } = editor;
  const sel = view.state.selection.main;
  // a single word chosen as its own tag: it becomes #word; otherwise the tag goes after the passage
  if (word && tag === word && view.state.sliceDoc(sel.from, sel.to).trim() === word) {
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: `#${word}` }, selection: { anchor: sel.from + word.length + 1 }, userEvent: 'input.tag' });
  } else {
    const at = sel.to;
    const before = view.state.sliceDoc(at - 1, at);
    const insert = `${at > 0 && before && !/\s/.test(before) ? ' ' : ''}#${tag}`;
    view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: 'input.tag' });
  }
  toast(t('tags.added', tag));
}

function showTags() {
  openTags({
    tags: collectTags(notesNow()),
    onOpen: async (id, line) => {
      hideNotes();
      if (id !== currentId) await openNote(id);
      const { view } = editor;
      const at = view.state.doc.line(Math.min(line + 1, view.state.doc.lines));
      view.dispatch({ selection: { anchor: at.from, head: at.to }, scrollIntoView: true });
    },
  });
}

/** A picture from the phone or the computer, put in where the cursor is (as a pasted one is). */
function pickImage() {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) addImage(file, null);
  });
  document.body.append(input);
  input.click();
}

/** The note's pictures as data: URLs, so an exported page carries them: "assets/<name>" → URL. */
async function imagesOf(md) {
  const images = new Map();
  const names = new Set([...md.matchAll(/\]\((assets\/([^)\s]+))\)/g)].map((m) => m[2]));
  for (const name of names) {
    try {
      let data = await api.readAsset?.(name);
      if (!data) continue;
      if (data instanceof Blob) data = new Uint8Array(await data.arrayBuffer());
      else if (data instanceof ArrayBuffer) data = new Uint8Array(data);
      const ext = name.split('.').pop().toLowerCase();
      const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] ?? 'image/png';
      let binary = '';
      for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
      images.set(`assets/${name}`, `data:${type};base64,${btoa(binary)}`);
    } catch (err) {
      console.error(err);
    }
  }
  return images;
}

/** The open note as plain text, a web page, or (through printing) a PDF. */
async function exportAs(kind) {
  const note = notes.get(currentId);
  if (!note) return;
  const md = editor.view.state.doc.toString();
  const base = fileNameFor(titleOf(note), new Set()).replace(/\.md$/, '');
  if (kind === 'txt') {
    api.download(`${base}.txt`, toText(md), 'text/plain;charset=utf-8');
    return;
  }
  const page = htmlPage(titleOf(note), toHtml(md, { images: await imagesOf(md), expandDetails: kind !== 'html' }), prefs.lang);
  if (kind === 'html') {
    api.download(`${base}.html`, page, 'text/html;charset=utf-8');
    return;
  }
  printPage(page, base);
}

/**
 * Prints a page; the printer "Save as PDF" makes the PDF. On Android the app's own print service
 * does it (MainActivity.printHtml); elsewhere the page goes into a hidden frame that is printed.
 */
function printPage(page, name) {
  if (typeof android?.printHtml === 'function') {
    android.printHtml(page, name);
    return;
  }
  toast(t('noteMenu.printing'), { timeout: 6000 });
  const frame = h('iframe', { class: 'print-frame', title: name, 'aria-hidden': 'true' });
  frame.srcdoc = page;
  frame.addEventListener('load', () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  });
  document.body.append(frame);
}

/** The strip over the note: counted again after a change, its typing speed every few seconds. */
function refreshStats({ text = true } = {}) {
  if (statsStrip.node.hidden || !editor) return;
  if (text || !lastStats) lastStats = textStats(editor.view.rich ? editor.getPlainText() : editor.view.state.doc.toString(), prefs.lang);
  statsStrip.update(lastStats, pace.slice(-6).reduce((a, b) => a + b, 0));
}

/** What the person wrote in a change goes into today's numbers (saved every few seconds). */
function noteWritten(update) {
  let written = 0;
  let grown = 0;
  for (const tr of update.transactions) {
    const event = tr.annotation(Transaction.userEvent);
    if (!event || !tr.docChanged) continue; // sync and the like: not the person's writing
    // undoing, and a version put back, change the text's size but are not writing
    const writes = !/^(undo|redo|input\.restore)/.test(event);
    tr.changes.iterChanges((fromA, toA, fromB, toB) => {
      grown += toB - fromB - (toA - fromA);
      if (writes) written += toB - fromB;
    });
  }
  if (!written && !grown) return;
  pendingWritten += written;
  pendingGrown += grown;
  if (!writeLogTimer) writeLogTimer = setTimeout(flushWriting, 15_000);
}

function flushWriting() {
  clearTimeout(writeLogTimer);
  writeLogTimer = 0;
  if (!pendingWritten && !pendingGrown) return;
  Object.assign(writeLog, noteWriting(writeLog, pendingWritten, pendingGrown));
  pendingWritten = 0;
  pendingGrown = 0;
  // quiet: the log is merged day by day between devices (sync/merge.js), not won by the newest
  api.setState({ writeDays: writeLog.writeDays, growDays: writeLog.growDays, $quiet: true }).catch(() => {});
}

function showWritingStats() {
  const note = notes.get(currentId);
  if (!note) return;
  flushWriting();
  openWritingStats({ title: titleOf(note), stats: textStats(editor.view.rich ? editor.getPlainText() : editor.view.state.doc.toString(), prefs.lang), log: writeLog });
}

/**
 * Keeps a version of a note: the first time it is saved in this window (its text before today's
 * changes), then at most every VERSION_EVERY while it is written, and before another is put back.
 */
function keepVersion(id, content, { force = false } = {}) {
  const last = versionKept.get(id);
  if (!force && last !== undefined && Date.now() - last < VERSION_EVERY) return Promise.resolve();
  versionKept.set(id, Date.now());
  return api.addVersion?.(id, content).catch((err) => console.error(err)) ?? Promise.resolve();
}

function showVersions() {
  const id = currentId;
  const note = notes.get(id);
  if (!note) return;
  flushSave();
  openVersions({
    title: titleOf(note),
    current: () => (id === currentId ? editor.view.state.doc.toString() : note.content),
    list: () => api.versions(id),
    read: (at) => api.readVersion(id, at),
    onRestore: (text, at) => restoreVersion(id, text, at),
  });
}

/** Puts a version back as one change, so ↶ undoes it; the text as it was is kept as a version first. */
async function restoreVersion(id, text, at) {
  if (id !== currentId) return;
  await keepVersion(id, editor.view.state.doc.toString(), { force: true });
  setEditing(true);
  editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: text }, userEvent: 'input.restore', scrollIntoView: true });
  toast(t('versions.restored', `${formatDay(at)}, ${formatTime(at)}`), { timeout: 6000 });
}

/** The current PIN asked once more before it is changed or taken off. */
async function confirmCurrentPin() {
  const pin = await askPin({ title: t('lock.current') });
  if (pin === null) return false;
  if (await checkPin(pin, pinLock)) return true;
  toast(t('lock.wrong'));
  return false;
}

/** A new PIN, typed twice. */
async function newPin(done) {
  const first = await askPin({ title: t('lock.set'), text: t('lock.setText') });
  if (first === null) return;
  const again = await askPin({ title: t('lock.repeat') });
  if (again === null) return;
  if (again !== first) {
    toast(t('lock.mismatch'));
    return;
  }
  // a new PIN locks again after a minute away: picking a file or signing in to Google leaves the app
  // for a moment, and "at once" would ask for the PIN after each of those (it can be chosen in Settings)
  pinLock = await hashPin(first, pinLock?.after ?? 60);
  await api.setState({ pinLock }).catch((err) => toast(err.message));
  lockScreen.changed();
  toast(t(done));
  sideMenu?.refresh();
}

async function changePin() {
  if (await confirmCurrentPin()) await newPin('lock.changed');
}

async function removePin() {
  if (!(await confirmCurrentPin())) return;
  pinLock = null;
  await api.setState({ pinLock: null }).catch((err) => toast(err.message));
  lockScreen.changed();
  toast(t('lock.removed'));
  sideMenu?.refresh();
}

/** A row of choices in the side menu: a label and a segmented control. */
function sideChoice(label, values, current, choose, name) {
  return h(
    'div',
    { class: 'side-choice' },
    h('span', { class: 'side-label' }, label),
    h(
      'div',
      { class: 'seg', role: 'radiogroup', 'aria-label': label },
      values.map((value) => h('button', { type: 'button', class: 'seg-btn', role: 'radio', 'aria-checked': String(value === current), onclick: () => choose(value) }, name(value))),
    ),
  );
}

/** Settings → Writing: the strip, the bar and its buttons, what focus lights. */
function writingSettings(close) {
  return sideGroup(
    t('stats.writing'),
    sideChoice(t('rich.mode'), ['visual', 'source'], writing.editorMode, (editorMode) => setWriting({ editorMode }), (mode) => t(`rich.${mode}`)),
    sideToggle({ icon: '∑', text: t('stats.bar'), hint: t('stats.barHint'), on: writing.statsBar, toggle: () => setWriting({ statsBar: !writing.statsBar }) }),
    sideChoice(t('format.show'), ['touch', 'always', 'off'], writing.formatBar, (formatBar) => setWriting({ formatBar }), (v) => t(`format.${v}`)),
    sideItem({
      icon: 'B',
      text: t('format.customize'),
      chevron: true,
      run: () => close(() => openToolsDialog({ current: writing.formatTools, onSave: (formatTools) => setWriting({ formatTools }) })),
    }),
    sideChoice(t('focusDim.title'), ['paragraph', 'sentence', 'off'], writing.focusDim, (focusDim) => setWriting({ focusDim }), (v) => t(`focusDim.${v}`)),
  );
}

/** Settings → Protection: the PIN of this device. */
function pinSettings(close) {
  if (!lockScreen.canLock) return sideGroup(t('lock.kicker'), h('p', { class: 'side-empty' }, t('lock.unavailable')));
  if (!pinLock) {
    return sideGroup(t('lock.kicker'), sideItem({ icon: '🔒', text: t('lock.set'), hint: t('lock.off'), chevron: true, run: () => close(() => newPin('lock.saved')) }), h('p', { class: 'side-note' }, t('lock.note')));
  }
  return sideGroup(
    t('lock.kicker'),
    sideItem({ icon: '🔒', text: t('lock.now'), hint: `${t('lock.pin')}: ${t('lock.on')}`, run: () => close(() => lockScreen.lock()) }),
    sideChoice(
      t('lock.after'),
      LOCK_AFTER,
      pinLock.after,
      (after) => {
        pinLock = { ...pinLock, after };
        api.setState({ pinLock }).catch((err) => toast(err.message));
        sideMenu?.refresh();
      },
      (v) => t(`lock.afterOptions.${v}`),
    ),
    sideItem({ icon: '✎', text: t('lock.change'), chevron: true, run: () => close(changePin) }),
    sideItem({ icon: '✕', text: t('lock.remove'), danger: true, run: () => close(removePin) }),
    h('p', { class: 'side-note' }, t('lock.note')),
  );
}

function onDocChange(update) {
  showNoteSteps();
  if (suspended) return;
  if (lost) {
    // no server to save to: the text goes straight into the rescue copy
    if (currentId) rescue.put(currentId, update.state.doc.toString());
    return;
  }
  notePace(update);
  noteWritten(update);
  markTyping();
  dirty = true;
  setSaveState('pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DELAY);
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(refreshAnalysis, 160);
}

/** While the person types, the microphone steps out of the way (styles.css: body.typing). */
let typingTimer = 0;
function markTyping() {
  document.body.classList.add('typing');
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => document.body.classList.remove('typing'), 1800);
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
  // the first change in this window: the text as it was before it is kept as a version
  const before = notes.get(id)?.content;
  if (!versionKept.has(id) && before?.trim() && before !== content) keepVersion(id, before, { force: true });
  try {
    const { updated } = await api.write(id, content);
    rescue.drop(id, content);
    const note = notes.get(id);
    if (note) {
      note.content = content;
      note.updated = updated;
    }
    keepVersion(id, content);
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
  refreshStats({ text: false });
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
  refreshStats();
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
  const peaks = info.headings.length ? t('status.peaks', count(info.headings.length, 'peak')) : editor.view.rich ? t('rich.enterHint') : copy().noHeadings;
  $('#sb-peaks').textContent = comments ? `${peaks} · 💬 ${comments}` : peaks;
  outline.setHeadings(info.headings);
  outline.setCursorLine(editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number);
}

function onSelectionChange(update) {
  formatBar.refresh?.();
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
  const text = view.rich ? view.rich.getSelectedText() : view.state.sliceDoc(sel.from, sel.to);
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
  const rich = editor?.view.rich;
  if (rich) {
    let paragraph = 0;
    rich.view.state.doc.descendants((node, pos) => { if (node.isTextblock && pos < rich.view.state.selection.head) paragraph++; });
    $('#sb-coords').textContent = t('richPosition', paragraph || 1, rich.view.state.selection.$from.parentOffset + 1);
  } else $('#sb-coords').textContent = copy().coords(line.number, sel.head - line.from + 1);
  const selected = rich ? rich.getSelectedText().length : state.selection.ranges.reduce((n, r) => n + r.to - r.from, 0);
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
  if (!editing) {
    items.push(
      { icon: icon('copy'), text: t('menu.copy'), kbd: 'Ctrl+C', disabled: sel.empty, run: () => copySelection(view) },
      { icon: '🌐', text: t('menu.translate'), kbd: 'Ctrl+Shift+X', disabled: sel.empty, run: () => translateSelection(view) },
      { icon: '▣', text: t('menu.selectAll'), kbd: 'Ctrl+A', run: () => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }) },
      { icon: '⇩', text: t('notes.saveCopy'), run: () => exportNote(currentId) },
      '-',
      { icon: '✎', text: t('notes.edit'), run: () => setEditing(true, { focus: true }) },
    );
    showMenu(event.clientX, event.clientY, items);
    return;
  }
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
    { icon: icon('copy'), text: t('menu.copy'), kbd: 'Ctrl+C', disabled: sel.empty, run: () => copySelection(view) },
    { icon: '⎘', text: t('menu.paste'), kbd: 'Ctrl+V', run: () => pasteFromClipboard(view) },
    '-',
    { icon: '⌗', text: t(sel.empty ? 'menu.codeBlock' : 'menu.wrapCode'), kbd: 'Ctrl+E', run: () => insertCodeBlock(view) },
    { icon: '▸', text: t('accordion.insert'), disabled: inCode, run: () => insertAccordionBlock(view) },
    { icon: '▣', text: t('menu.selectAll'), kbd: 'Ctrl+A', run: () => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }) },
    { icon: '⇩', text: t('notes.saveCopy'), run: () => exportNote(currentId) },
    { note: t('menu.spelling') },
  );
  showMenu(event.clientX, event.clientY, items, { onClose: () => view.focus() });
}

async function requestComment(view, lineNumber) {
  ensureEditing();
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
    history: commentsUnder(lines, target).map((comment) => ({ ...comment, text: toText(comment.text) })),
  });
  view.focus();
  if (body) insertComment(view, n, body);
}

async function copySelection(view) {
  const sel = view.state.selection.main;
  try {
    await api.copy(view.rich ? view.rich.getSelectedText() : view.state.sliceDoc(sel.from, sel.to));
    return true;
  } catch {
    toast(t('clipboard.blocked', 'Ctrl+C'));
    return false;
  }
}

/** The format bar's copy: the selection to the clipboard, left selected (the bar never takes the focus). */
async function copyFromBar() {
  const view = editor?.view;
  if (!view) return;
  const text = view.rich ? view.rich.getSelectedText() : view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
  if (!text) {
    // a note open for reading: what the page shows as selected, if the editor did not follow it
    const shown = pageSelectionInNote();
    if (!shown) {
      toast(t('editor.nothingSelected'), { timeout: 2000 });
      return;
    }
    try {
      await api.copy(shown);
      toast(t('editor.copied'), { timeout: 1500 });
    } catch {
      toast(t('clipboard.blocked', 'Ctrl+C'));
    }
    return;
  }
  if (await copySelection(view)) toast(t('editor.copied'), { timeout: 1500 });
}

/** The words selected on the page, when they are in the open note; '' otherwise. */
function pageSelectionInNote() {
  const sel = getSelection();
  const host = $('#editor');
  if (!sel?.rangeCount || !host || host.closest('[hidden]')) return '';
  // the selection may begin or end outside the note (a select-all of the page): it counts when it covers some of it
  if (!host.contains(sel.anchorNode) && !sel.getRangeAt(0).intersectsNode(host)) return '';
  return sel.toString().trim() ? sel.toString() : '';
}

// Words selected in a note get the app's own actions: copy, cut, paste, select all, translate. The phone's
// own menu by a selection stays away (quietSelection), so these are the ones there are.
// With a finger, once the selection rests, the words come forward on a card, the rest of the screen blurs
// and the actions stand in a list under the card (selFocus). With a mouse they are a bar at the foot.
const noteSel = h('div', { class: 'note-selbar', role: 'toolbar', hidden: true });
const noteSelButton = (id, glyph, key, run) => {
  const button = h('button', { type: 'button', class: 'note-sel-btn', 'data-sel': id, 'data-key': key }, icon(glyph), h('span'));
  button.addEventListener('pointerdown', (event) => event.preventDefault()); // the selection stays
  button.addEventListener('click', () => {
    // the card goes once an action is chosen; it comes back for another selection, not for this one
    if (!selFocus.hidden && id !== 'all') hideSelFocus(true);
    run();
  });
  return button;
};
const noteSelButtons = [
  noteSelButton('copy', 'copy', 'menu.copy', () => copyFromBar()),
  noteSelButton('cut', 'cut', 'menu.cut', () => editor && cutSelection(editor.view)),
  noteSelButton('paste', 'paste', 'menu.paste', () => editor && pasteFromClipboard(editor.view)),
  noteSelButton('all', 'selectAll', 'menu.selectAll', () => selectAllNote()),
  noteSelButton('translate', 'translate', 'menu.translate', () => translateSelection()),
];
noteSel.append(...noteSelButtons);

const selFocusCard = h('div', { class: 'sel-focus-card' });
const selFocusStack = h('div', { class: 'sel-focus-stack' }, selFocusCard);
const selFocus = h('div', { class: 'sel-focus', hidden: true }, h('div', { class: 'sel-focus-shade' }), selFocusStack);
let selFingers = 0; // fingers on the screen: the card waits until they are off
let selRestTimer = 0;
let selMoving = false; // a selection handle is being dragged or the page scrolled (Android says so)
let selMovingTimer = 0;
let selCancelled = false; // the phone took over a touch (a long press): a finger may still be on the glass
// how long the selection must stay still before its card comes: a slow drag pauses, and should not get it
const SEL_REST = 700;
const SEL_REST_UNSURE = 1300;
let selDismissed = ''; // the selection whose card was put away (an action, a touch elsewhere)

/** Which selection this is, so a card put away for it does not come straight back. */
function selKey() {
  const sel = getSelection();
  return sel?.rangeCount ? `${sel.anchorOffset}:${sel.focusOffset}:${sel.toString()}` : '';
}

function hideSelFocus(dismiss = false) {
  if (dismiss) selDismissed = selKey();
  selFocus.hidden = true;
  document.documentElement.classList.remove('sel-focused');
}

function drawNoteSel() {
  const show = Boolean(pageSelectionInNote());
  document.documentElement.classList.toggle('note-selecting', show);
  clearTimeout(selRestTimer);
  if (!show) {
    noteSel.hidden = true;
    hideSelFocus();
    selDismissed = '';
    return;
  }
  for (const button of noteSelButtons) {
    const id = button.dataset.sel;
    button.lastChild.textContent = t(button.dataset.key);
    button.setAttribute('aria-label', t(button.dataset.key));
    button.hidden = (!editing && (id === 'cut' || id === 'paste')) || (id === 'translate' && !phone);
  }
  if (!fingerFirst()) {
    hideSelFocus();
    if (noteSel.parentNode !== document.body) document.body.append(noteSel);
    noteSel.hidden = false;
    return;
  }
  // a finger: the card, once the selection has stopped moving (a handle being dragged moves it)
  if (!selFocus.hidden && selKey() !== selFocus.dataset.key) hideSelFocus();
  if (selMoving) return; // it comes when the handle is let go
  selRestTimer = setTimeout(showSelFocus, selCancelled ? SEL_REST_UNSURE : SEL_REST);
}

function showSelFocus() {
  if (selFingers || selMoving || !fingerFirst()) return;
  const text = pageSelectionInNote();
  const key = selKey();
  if (!text || key === selDismissed) return;
  if (!selFocus.hidden && selFocus.dataset.key === key) return; // already up: it keeps where it was scrolled to
  const host = $('#editor');
  const range = getSelection().getRangeAt(0).cloneRange();
  if (!host.contains(range.startContainer)) range.setStart(host, 0);
  if (!host.contains(range.endContainer)) range.setEnd(host, host.childNodes.length);
  const words = range.cloneContents();
  for (const node of words.querySelectorAll('[id], [contenteditable], [tabindex]')) {
    node.removeAttribute('id');
    node.removeAttribute('contenteditable');
    node.removeAttribute('tabindex');
  }
  // the words as the note shows them: its typeface, size and colour
  const root = $('#editor .atlas-rich-content') ?? $('#editor .cm-content') ?? host;
  const look = getComputedStyle(root);
  Object.assign(selFocusCard.style, { fontFamily: look.fontFamily, fontSize: look.fontSize, lineHeight: look.lineHeight, color: look.color });
  selFocusCard.replaceChildren(words);
  if (noteSel.parentNode !== selFocusStack) selFocusStack.append(noteSel);
  noteSel.hidden = false;
  selFocus.dataset.key = key;
  selFocus.hidden = false;
  document.documentElement.classList.add('sel-focused');
  placeSelFocus(range.getBoundingClientRect());
}

/** The card where the words were (as near as fits), its actions under it, all above the keyboard. */
function placeSelFocus(rect) {
  const css = getComputedStyle(document.documentElement);
  const px = (name) => parseFloat(css.getPropertyValue(name)) || 0;
  const top = 36;
  const bottom = (visualViewport?.height ?? innerHeight) - Math.max(px('--kb'), px('--sys-bottom')) - 12;
  selFocusCard.style.maxHeight = '';
  selFocusCard.scrollTop = 0;
  const menu = noteSel.offsetHeight + 10;
  selFocusCard.style.maxHeight = `${Math.max(72, Math.min(bottom - top - menu, innerHeight * 0.5))}px`;
  const height = selFocusStack.offsetHeight;
  const want = (rect?.top ?? top) - 14;
  selFocusStack.style.top = `${Math.round(Math.max(top, Math.min(want, bottom - height)))}px`;
}

// fingers on the screen: the card goes while one is down (a handle is being moved, the page scrolled)
// and comes back when they are off and the selection has rested
const countFingers = (event) => {
  selFingers = event.touches.length;
  if (selFocusStack.contains(event.target)) return; // scrolling the card or pressing its actions
  selCancelled = event.type === 'touchcancel';
  if (event.type === 'touchstart') hideSelFocus();
  if (!selFingers && pageSelectionInNote()) drawNoteSel();
};
for (const type of ['touchstart', 'touchend', 'touchcancel']) document.addEventListener(type, countFingers, { capture: true, passive: true });
// Android (MainActivity, SilentActionMode.hide): a handle is being dragged, or was let go. While it is
// dragged the phone says so again every few seconds; a word missed (a drag never said to end) runs out.
document.addEventListener('atlas-selection-moving', (event) => {
  clearTimeout(selMovingTimer);
  selMoving = Boolean(event.detail);
  if (selMoving) {
    clearTimeout(selRestTimer);
    hideSelFocus();
    selMovingTimer = setTimeout(() => {
      selMoving = false;
      if (pageSelectionInNote()) drawNoteSel();
    }, 3500);
    return;
  }
  selCancelled = false; // let go: no finger holds the selection any more
  if (!pageSelectionInNote()) return;
  drawNoteSel();
  clearTimeout(selRestTimer);
  selRestTimer = setTimeout(showSelFocus, 250); // surely let go: no need to wait long
});
visualViewport?.addEventListener('resize', () => {
  if (selFocus.hidden) return;
  hideSelFocus();
  if (pageSelectionInNote()) drawNoteSel();
});
document.addEventListener('selectionchange', drawNoteSel);

/** All of the note selected: by the editor while writing, on the page while reading (the editor is shut then). */
function selectAllNote() {
  const view = editor?.view;
  if (!view) return;
  if (editing) {
    view.focus();
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    return;
  }
  const root = $('#editor .atlas-rich-content') ?? $('#editor .cm-content');
  if (root) getSelection().selectAllChildren(root);
}

// The phone's own menu by a selection (Copy, Share, Google's suggestions) would sit over the app's bars;
// it stays away everywhere but in plain fields (search, forms), where Paste is wanted.
function quietSelection() {
  const field = document.activeElement?.closest?.('input, textarea, select');
  api.quietSelection?.(!field);
}
document.addEventListener('focusin', quietSelection);
document.addEventListener('focusout', () => setTimeout(quietSelection, 0));
quietSelection();

async function cutSelection(view) {
  if (await copySelection(view)) {
    if (view.rich) view.rich.deleteSelection();
    else view.dispatch(view.state.replaceSelection(''), { userEvent: 'delete.cut' });
  }
}

async function pasteFromClipboard(view) {
  ensureEditing();
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
  if (view.rich) { view.rich.command('image', { src: `assets/${name}`, alt, title: '' }); view.focus(); return; }
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
  const notesBack = document.getElementById('btn-notes-back');
  if (notesBack) {
    notesBack.title = t('notesScreen.toList');
    notesBack.setAttribute('aria-label', t('notesScreen.toList'));
  }
  notesScreen.refresh();
  if (persist) api.setState({ lang: prefs.lang }).catch(() => {});
  applyLook({ persist: false });
  if (!editor) return;
  editor.localize();
  formatBar.localize();
  renderPace();
  // everything drawn in the old language is drawn again
  renderIndex();
  sideMenu?.refresh();
  library?.relocalize();
  if (!homeEl.hidden) showHome();
  else updateTabs();
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
  // a theme chosen by hand ends the cat look (cats.js)
  if (catsOn()) setCats(false);
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
  setLook({ theme: effectiveTheme() === 'dark' ? (prefs.skin === 'cozy' ? 'cream' : 'light') : 'dark' });
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
  applyFocusDim();
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
        sideItem({ icon: '▤', text: t('side.list'), kbd: 'Ctrl+Shift+B', run: () => close(toggleIndex) }),
        sideItem({ icon: '⌕', text: t('side.find'), kbd: 'Ctrl+K', run: () => close(() => openPalette()) }),
        isAtlas() ? sideItem({ icon: '▦', text: t('side.atlas'), kbd: 'Ctrl+M', run: () => close(toggleAtlas) }) : null,
        sideToggle({ icon: '◎', text: t('side.focus'), on: focusMode, toggle: () => close(() => toggleFocus()) }),
        sideItem({ icon: '◉', text: t('side.dictate'), kbd: 'Ctrl+Shift+D', run: () => close(toggleDictation) }),
        sideItem({ icon: '🌐', text: t('side.translate'), kbd: 'Ctrl+Shift+X', run: () => close(() => translateSelection()) }),
        sideItem({ icon: '◴', text: t('versions.title'), chevron: true, run: () => close(showVersions) }),
        sideItem({ icon: '∑', text: t('stats.title'), chevron: true, run: () => close(showWritingStats) }),
      ),
      sideGroup(
        t('side.files'),
        sideItem({ icon: '⇩', text: t('side.saveCopy'), run: () => close(() => exportNote(currentId)) }),
        sideItem({ icon: '⇊', text: t('side.exportAll'), run: () => close(exportAll) }),
        sideItem({ icon: '⇡', text: t('side.import'), run: () => close(importFiles) }),
        sideItem({ icon: '🗑', text: t('trash.title'), run: () => close(() => trashView?.open('notes')) }),
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
          sideItem({ icon: '🗑', text: t('trash.title'), run: () => close(() => trashView?.open('docs')) }),
        ),
        sideGroup(null, sideItem({ icon: 'Aa', text: t('side.readLook'), hint: t('side.readLookHint'), chevron: true, run: () => close(() => showAppearance()) })),
      ];
    },
    settings: (close) => [
      sideGroup(
        null,
        sideItem({ icon: '◐', text: t('side.darkLight'), kbd: 'Ctrl+Shift+L', run: toggleTheme }),
        sideItem({ icon: 'Aa', text: t('side.readLook'), hint: t('side.readLookHint'), chevron: true, run: () => close(() => showAppearance()) }),
        // the app's motion (motion.js): on unless turned off here, or the system asks for less
        sideToggle({ icon: '≈', text: t('side.motion'), hint: t('side.motionHint'), on: motionEnabled(), toggle: () => { setMotion(!motionEnabled()); sideMenu?.refresh(); } }),
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
      writingSettings(close),
      pinSettings(close),
    ],
    account: (close) => [
      profileSection(),
      // the whole trash (notes, books and marks), opened on whichever part has something in it
      sideGroup(null, sideItem({ icon: '🗑', text: t('trash.title'), chevron: true, run: () => close(() => trashView?.open()) })),
      sync ? sync.section() : h('p', { class: 'side-empty' }, t('side.noSync')),
      updater ? updater.section() : null,
      h('p', { class: 'side-version' }, t('side.version', typeof __VERSION__ === 'string' ? __VERSION__ : '')),
    ].filter(Boolean),
  };
}

// ---------- the main page and the person's profile ----------

/** The main page over everything: the book read last, the notes, the library. */
async function showHome() {
  hideNotes();
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
    reading: { today: readingLog.days[dayKey()] ?? 0, goal: readingLog.goal, streak: streakOf(readingLog.days) },
    onGoal: (anchor) => {
      const r = anchor.getBoundingClientRect();
      showMenu(r.left + 12, r.bottom - 8, [
        { header: t('home.goalPick') },
        ...GOALS.map((m) => ({ icon: m === readingLog.goal ? '✓' : '', text: t('home.goalWhat', m), run: () => setGoal(m) })),
      ]);
    },
    onMenu: () => sideMenu?.open('account'),
    onNote: (id) => {
      if (!id) {
        showNotes();
        return;
      }
      hideHome();
      if (id !== currentId) openNote(id);
      else editor.view.focus();
    },
    onNotes: () => showNotes(),
    onNewNote: leave(() => createNote()),
    // the library and the reader open over the main page, which is there again when they close
    onLibrary: () => (library ? openLibrary() : toast(t('home.noLibrary'))),
    onBook: (id) => {
      flushSave();
      library?.readDoc(id);
    },
    onAddBook: () => (library ? openLibrary({ pick: true }) : toast(t('home.noLibrary'))),
    onShelf: (name) => library?.open({ shelf: name }),
  });
  homeEl.hidden = false;
  document.body.classList.add('at-home');
  // the first time the main page shows, its parts come in one after another
  stagger(homeEl.querySelector('.home-body'), 'home', { step: 60, max: 6 });
  updateTabs();
  homeEl.querySelector('.home-book, .home-tile')?.focus({ preventScroll: true });
}

/** The notes screen (notesScreen.js): folders and the notes in them, over the editor. */
function showNotes() {
  closeIndexPanel();
  sideMenu?.close?.();
  if (atlas?.isOpen) atlas.hide();
  if (focusMode) toggleFocus(false);
  flushSave();
  // the list shows the text as typed so far
  if (currentId && notes.has(currentId)) {
    const note = notes.get(currentId);
    const text = editor.view.state.doc.toString();
    if (note.content !== text) notes.set(currentId, { ...note, content: text, info: analyze(text) });
  }
  hideHome();
  notesScreen.show({ focus: !phone });
  document.body.classList.add('at-notes');
  updateTabs();
}

function hideNotes() {
  if (!notesScreen.isOpen()) return;
  notesScreen.hide();
  document.body.classList.remove('at-notes');
  updateTabs();
}

function hideHome() {
  if (homeEl.hidden) return;
  homeEl.hidden = true;
  document.body.classList.remove('at-home');
  updateTabs();
}

/** The tab bar shows on the main page and the library's shelf, with the place it is at marked. */
function updateTabs() {
  const libraryOpen = document.documentElement.classList.contains('library-open');
  const notesOpen = notesScreen.isOpen();
  tabBar.node.hidden = homeEl.hidden && !libraryOpen && !notesOpen;
  document.body.classList.toggle('has-tabbar', !tabBar.node.hidden);
  tabBar.select(libraryOpen ? 'library' : notesOpen ? 'notes' : 'home');
}

/** Which tab the screen is on now: the order of the tabs is the way a change between them moves. */
function currentTab() {
  if (document.documentElement.classList.contains('library-open')) return 'library';
  if (notesScreen.isOpen()) return 'notes';
  return homeEl.hidden ? null : 'home';
}

function pickTab(tab) {
  if (tab === 'profile') {
    sideMenu?.open('account');
    return;
  }
  const from = TABS.indexOf(currentTab());
  const to = TABS.indexOf(tab);
  if (from === to) return;
  const dir = from < 0 ? 'fade' : to > from ? 'forward' : 'back';
  navigate(dir, async () => {
    if (tab === 'library') {
      await openLibrary();
      return;
    }
    // the library closes onto whatever is under it
    if (library?.isOpen()) library.close();
    if (tab === 'notes') showNotes();
    else if (tab === 'home') await showHome();
    else editor.view.focus();
  });
}

/** Every half minute with a book open on screen: half a minute more read today. */
function countReading() {
  if (!library?.openDocId() || document.visibilityState !== 'visible') return;
  readingLog.days = addReading(readingLog.days, 0.5);
  api.setState({ readDays: readingLog.days }).catch(() => {});
}

function setGoal(minutes) {
  readingLog.goal = minutes;
  api.setState({ readGoal: minutes }).catch(() => {});
  showHome();
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
    { icon: '▤', title: t('commands.sidebar'), kbd: 'Ctrl+Shift+B', keywords: 'sidebar list панель список', run: toggleIndex },
    { icon: '◎', title: t(focusMode ? 'commands.unfocus' : 'commands.focus'), kbd: 'Ctrl+.', keywords: 'focus фокус', run: () => toggleFocus() },
    { icon: '❝', title: t('commands.comment'), kbd: 'Ctrl+Shift+M', keywords: 'comment комментарий', run: () => requestComment(editor.view) },
    { icon: '⌗', title: t('commands.codeBlock'), kbd: 'Ctrl+E', keywords: 'code код', run: () => {
        ensureEditing();
        insertCodeBlock(editor.view);
      },
    },
    { icon: '⇩', title: t('commands.saveCopy'), keywords: 'export save экспорт скачать', run: () => exportNote(currentId) },
    { icon: '▸', title: t('accordion.insert'), keywords: 'accordion details collapse раскрыть свернуть аккордеон', run: () => {
      ensureEditing();
      insertAccordionBlock(editor.view);
    } },
    { icon: '⇊', title: t('commands.exportAll'), keywords: 'backup download резервная копия архив экспорт zip', run: exportAll },
    { icon: '⇡', title: t('commands.import'), keywords: 'import upload files импорт загрузить файлы', run: importFiles },
    { icon: '◉', title: t('commands.dictate'), kbd: 'Ctrl+Shift+D', keywords: 'dictate voice speech microphone диктовка голос речь микрофон', run: toggleDictation },
    { icon: '🌐', title: t('commands.translate'), kbd: 'Ctrl+Shift+X', keywords: 'translate translation english russian перевод перевести английский русский', run: () => translateSelection() },
    { icon: '◴', title: t('versions.title'), keywords: 'history versions restore diff история версии вернуть сравнить', run: showVersions },
    { icon: '∑', title: t('stats.title'), keywords: 'statistics words count heat map статистика слова знаки карта', run: showWritingStats },
  ];
  if (pinLock && lockScreen.canLock) list.push({ icon: '🔒', title: t('lock.now'), keywords: 'lock pin блокировка закрыть пин', run: () => lockScreen.lock() });
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
  if (e.defaultPrevented) return;
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
  else if (code === 'KeyB' && (shiftKey || !editor.view.rich)) toggleIndex();
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
  $('#btn-edit').addEventListener('click', () => setEditing(!editing, { focus: true }));
  // one step back or forward in the note's text, next to ✎ (hidden while the note is only read)
  noteSteps = stepButtons({ undo: () => editor.undo(), redo: () => editor.redo(), className: 'tb-steps' });
  $('#btn-edit').before(noteSteps.node);
  showNoteSteps();
  // ⋯ after ✎: the note's own menu (copy, clear, tags, history, statistics, export)
  const noteMore = h('button', { type: 'button', class: 'tb-btn icon tb-note-more', id: 'btn-note-more', 'aria-haspopup': 'menu', 'data-i18n-title': 'noteMenu.more', 'data-i18n-label': 'noteMenu.more', title: t('noteMenu.more'), 'aria-label': t('noteMenu.more') }, '⋯');
  noteMore.addEventListener('pointerdown', (e) => e.preventDefault()); // the selection stays for "Mark with a tag"
  noteMore.addEventListener('click', () => openNoteMenu(noteMore));
  $('#btn-edit').after(noteMore);
  // the statistics strip under the title bar, the formatting bar over the status bar (and the keyboard)
  $('.titlebar').after(statsStrip.node);
  $('.statusbar').before(formatBar.node);
  document.body.append(noteSel, selFocus);
  // what was written is saved when the app goes away, not only every few seconds
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushWriting();
  });
  window.addEventListener('pagehide', flushWriting);
  // where the page is not shrunk for the on-screen keyboard, --kb says how much of it the keyboard
  // covers, so a comment being typed rises above it (on Android the app tells it, MainActivity.tellInsets)
  if (!android && window.visualViewport) {
    const vv = window.visualViewport;
    const keyboard = () => document.documentElement.style.setProperty('--kb', `${Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))}px`);
    vv.addEventListener('resize', keyboard);
    vv.addEventListener('scroll', keyboard);
  }
  // a tap on a note open for reading says how to write in it (now and then, not on every tap)
  $('#editor').addEventListener('click', () => {
    if (editing || !editor.view.state.selection.main.empty || Date.now() - readHintAt < 20_000) return;
    readHintAt = Date.now();
    toast(t('notes.readOnly'), { timeout: 3500, action: { text: t('notes.edit'), run: () => setEditing(true, { focus: true }) } });
  });
  $('#btn-new-2').addEventListener('click', () => {
    closeIndexPanel();
    createNote();
  });
  $('#btn-index').addEventListener('click', toggleIndex);
  const notesBack = h('button', { type: 'button', class: 'tb-btn icon tb-notes-back', id: 'btn-notes-back', title: t('notesScreen.toList'), 'aria-label': t('notesScreen.toList'), onclick: () => showNotes() }, '←');
  $('.titlebar').prepend(notesBack);
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
  // Android's updater reports here (MainActivity → Updater.java)
  updateEvent: (event) => updater?.event(event),
  trash: (tab) => trashView?.open(tab),
  setEditing: (on) => setEditing(on),
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
    if (notesScreen.isOpen()) {
      showHome();
      return true;
    }
    if (homeEl.hidden) {
      showNotes();
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

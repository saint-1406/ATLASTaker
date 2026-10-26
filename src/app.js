// ATLAS Notetaker, renderer entry point: wires the editor, the chrome around it (in one of two looks)
// and keeps every keystroke saved.

import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { api, rescue } from './bridge.js';
import { createEditor, insertComment, insertCodeBlock, pasteText, codeLanguageAt, urlAt } from './editor.js';
import { analyze, formatCount, WORD_FORMS } from './markdown.js';
import { commentTarget, commentsUnder } from './comments.js';
import { COPY, normalizeLook } from './skins.js';
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
  openSettings,
  toast,
  isOverlayOpen,
  showBlocker,
} from './overlays.js';
import { fileNameFor, makeZip } from './backup.js';
import welcomeText from './welcome.md';
import welcomeBrowserText from './welcome-browser.md';

const $ = (sel) => document.querySelector(sel);
const number = new Intl.NumberFormat('ru-RU');
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const PEAK_FORMS = { one: 'вершина', few: 'вершины', many: 'вершин', other: 'вершины' };
const COMMENT_FORMS = { one: 'комментарий', few: 'комментария', many: 'комментариев', other: 'комментария' };
const NOTE_FORMS = { one: 'заметка', few: 'заметки', many: 'заметок', other: 'заметки' };
const UNTITLED = 'Без названия';
const SAVE_DELAY = 400;
const LOOK_KEY = 'atlas-notetaker:look';
const BACKUP_EVERY = 7 * 24 * 60 * 60 * 1000;
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const inBrowser = api.kind !== 'server'; // the single-file build: notes live in this browser

const notes = new Map(); // id → { id, content, created, updated, cursor, scroll, info }
const editorStates = new Map(); // id → EditorState, keeps undo history while the window is open
const indexItems = new Map(); // id → <li>
const prefs = { ...normalizeLook(cachedLook()), sidebar: true, fontScale: 1 };
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

let markReady;
const ready = new Promise((resolve) => {
  markReady = resolve;
});

const copy = () => COPY[prefs.skin];
const isAtlas = () => prefs.skin === 'atlas';
const when = (ms) => {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? timeFmt.format(d) : dayFmt.format(d).replace('.', '');
};
const titleOf = (note) => note?.info.title || UNTITLED;
const newestId = () => [...notes.values()].sort((a, b) => b.updated - a.updated)[0]?.id ?? null;
const effectiveTheme = () => (prefs.theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : prefs.theme);

// The look is remembered in this browser too, so the window opens in it before the server answers.
function cachedLook() {
  try {
    return JSON.parse(localStorage.getItem(LOOK_KEY)) ?? {};
  } catch {
    return {};
  }
}

applyLook({ persist: false });

boot().catch((err) => {
  console.error(err);
  showBlocker({
    title: 'ATLAS не загрузился',
    text: `${err.message}. Закройте окно и запустите ATLAS ещё раз.`,
    action: { text: 'Перезагрузить', run: () => location.reload() },
  });
});

async function boot() {
  await claimWindow();
  const saved = (await api.getState()) ?? {};
  Object.assign(prefs, normalizeLook({ ...prefs, ...pickDefined(saved, ['skin', 'theme', 'accent']) }));
  if (typeof saved.sidebar === 'boolean') prefs.sidebar = saved.sidebar;
  if (typeof saved.fontScale === 'number') prefs.fontScale = saved.fontScale;
  applySidebar(prefs.sidebar, { persist: false });
  applyFontScale(prefs.fontScale, { persist: false });

  let list = await api.list();
  const firstRun = !list.length && !saved.welcomed;
  if (!list.length) {
    list = [await api.create(saved.welcomed ? '' : inBrowser ? welcomeBrowserText : welcomeText)];
    api.setState({ welcomed: true }).catch(() => {});
  }
  for (const note of list) notes.set(note.id, { ...note, info: analyze(note.content) });
  const restored = restoreRescued();

  editor = createEditor({
    parent: $('#editor'),
    onDocChange,
    onSelectionChange,
    onSmartPaste,
    onOpenLink: (url) => api.openExternal(url),
    onContextMenu: openEditorMenu,
    onCopy: (text) => api.copy(text),
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
  bindChrome();
  applyLook({ persist: false });

  const fonts = ['500 16px "Inter Variable"', '500 10px "JetBrains Mono Variable"', 'italic 600 16px "Cormorant Garamond"'];
  await Promise.all([...fonts.map((f) => document.fonts.load(f)), document.fonts.ready].map((p) => p.catch(() => {})));
  await openNote(notes.has(saved.lastOpen) ? saved.lastOpen : newestId());
  if (restored) toast(`Вернул несохранённый текст: ${formatCount(restored, NOTE_FORMS)}`, { timeout: 6000 });
  else if (inBrowser && !firstRun && Date.now() - (saved.lastBackup ?? 0) > BACKUP_EVERY) remindBackup(saved.lastBackup);
  if (api.ping) setInterval(ping, 20_000);
  setInterval(tickPace, 10_000);
  markReady();
}

// In the browser build clearing the browser's data would take the notes with it, hence the nudge.
function remindBackup(lastBackup) {
  const since = lastBackup ? `Последняя копия — ${dayFmt.format(lastBackup).replace('.', '')}.` : 'Копии ещё не было.';
  toast(`Заметки хранятся только в этом браузере. ${since}`, { action: { text: 'Скачать .zip', run: exportAll }, timeout: 10_000 });
}

function pickDefined(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function ping() {
  api.ping?.().catch((err) => {
    if (err.offline || err.status === 403) connectionLost(err);
  });
}

/** Text that never reached the disk (server died, save failed) is put back from the rescue copy. */
function restoreRescued() {
  let count = 0;
  for (const [id, saved] of Object.entries(rescue.all())) {
    const note = notes.get(id);
    if (!note || saved.content === note.content || saved.at <= note.updated) {
      rescue.drop(id);
      continue;
    }
    note.content = saved.content;
    note.info = analyze(saved.content);
    api.write(id, saved.content).then(({ updated }) => {
      note.updated = updated;
      rescue.drop(id, saved.content);
      renderIndex();
    }, () => {});
    count++;
  }
  return count;
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
    title: 'ATLAS открыт в другом окне',
    text: saved
      ? 'Писать можно только в одном окне, чтобы правки не перезаписывали друг друга. Здесь всё сохранено.'
      : 'Писать можно только в одном окне. Последние правки не дошли до диска, но лежат в аварийной копии — новое окно их подхватит после перезагрузки.',
    action: { text: 'Продолжить здесь', run: () => location.reload() },
  });
}

function connectionLost(err) {
  if (lost) return;
  lost = true;
  setSaveState('error');
  const restarted = err.status === 403;
  showBlocker({
    title: restarted ? 'ATLAS перезапустился' : 'Связь с ATLAS потеряна',
    text: restarted
      ? 'Сервер заметок начал новый сеанс. Обновите окно: несохранённый текст лежит в аварийной копии и вернётся.'
      : 'Сервер заметок не отвечает. Несохранённый текст лежит в аварийной копии этого окна. Запустите ATLAS с ярлыка — текст вернётся.',
    action: { text: restarted ? 'Обновить окно' : 'Попробовать снова', run: () => location.reload() },
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
  if (currentId && !(await leaveCurrent())) {
    toast('Заметка не сохранилась, поэтому остаюсь на ней. Сохранение повторяется.');
    return;
  }

  currentId = id;
  note.blankAtOpen = !note.content.trim();
  editor.view.setState(editorStates.get(id) ?? editor.makeState(note.content, savedSelection(note)));
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
    toast(`Не получилось удалить: ${err.message}`);
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
  toast(copy().deleted(titleOf(note)), api.openNotesFolder ? { action: { text: 'Открыть папку', run: () => api.openNotesFolder() } } : {});
}

// ---------- saving ----------

function onDocChange(update) {
  if (suspended || lost) return;
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
  if (suspended || lost) return false;
  const id = currentId;
  const content = editor.view.state.doc.toString();
  dirty = false;
  setSaveState('pending');
  rescue.put(id, content);
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
    label.textContent = lastSave.at ? `${c.saved} · ${timeFmt.format(lastSave.at)}` : c.saved;
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
  // about six characters per Russian word, space included
  el.textContent = `${pace.map((v) => bars[Math.min(7, Math.round((v / max) * 7))]).join('')} ${Math.round(perMinute / 6)} сл/мин`;
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
  const comments = info.comments ? formatCount(info.comments, COMMENT_FORMS) : '';
  const words = `${formatCount(info.words, WORD_FORMS)} · ${number.format(info.chars)} зн.`;
  $('#sb-words').textContent = !isAtlas() && comments ? `${words} · ${comments}` : words;
  const peaks = info.headings.length ? `▲ ${formatCount(info.headings.length, PEAK_FORMS)} · 1 слово = 1 м` : copy().noHeadings;
  $('#sb-peaks').textContent = comments ? `${peaks} · 💬 ${comments}` : peaks;
  outline.setHeadings(info.headings);
  outline.setCursorLine(editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number);
}

function onSelectionChange(update) {
  showCursorStatus(update.state);
  schedulePositionSave();
}

function showCursorStatus(state) {
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  $('#sb-coords').textContent = copy().coords(line.number, sel.head - line.from + 1);
  const selected = state.selection.ranges.reduce((n, r) => n + r.to - r.from, 0);
  const selEl = $('#sb-sel');
  selEl.hidden = !selected;
  selEl.textContent = `Выделено ${number.format(selected)} зн.`;
  const lang = codeLanguageAt(state, sel.head);
  const langEl = $('#sb-lang');
  langEl.hidden = lang == null;
  langEl.textContent = `⌗ ${lang || 'код'}`;
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
  const del = h('button', { type: 'button', class: 'idx-del', 'aria-label': 'Удалить заметку' }, '✕');
  const li = h(
    'li',
    { class: 'idx-item', tabindex: '0', role: 'button', 'data-id': note.id },
    thumb,
    h('span', { class: 'idx-text' }, h('span', { class: 'idx-title' }), h('span', { class: 'idx-meta' })),
    del,
  );
  const open = () => {
    const r = li.getBoundingClientRect();
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
      { icon: '↗', text: 'Открыть', run: open },
      { icon: '⇩', text: 'Сохранить копию .md', run: () => exportNote(note.id) },
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
  li.querySelector('.idx-meta').textContent = `${when(note.updated)} · ${number.format(note.info.words)} сл.`;
  li.querySelector('.idx-del').title = copy().deleteItem;
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
  if (url) items.push({ icon: '↗', text: 'Открыть ссылку', kbd: 'Ctrl+клик', run: () => api.openExternal(url) }, '-');
  items.push(
    {
      icon: '❝',
      text: 'Добавить комментарий',
      kbd: 'Ctrl+Shift+M',
      disabled: inCode,
      title: inCode ? 'Внутри блока кода комментарий сломал бы код' : undefined,
      run: () => requestComment(view, line.number),
    },
    '-',
    { icon: '✂', text: 'Вырезать', kbd: 'Ctrl+X', disabled: sel.empty, run: () => cutSelection(view) },
    { icon: '⧉', text: 'Копировать', kbd: 'Ctrl+C', disabled: sel.empty, run: () => copySelection(view) },
    { icon: '⎘', text: 'Вставить', kbd: 'Ctrl+V', run: () => pasteFromClipboard(view) },
    '-',
    { icon: '⌗', text: sel.empty ? 'Блок кода' : 'Обернуть в блок кода', kbd: 'Ctrl+E', run: () => insertCodeBlock(view) },
    { icon: '▣', text: 'Выделить всё', kbd: 'Ctrl+A', run: () => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }) },
    { icon: '⇩', text: 'Сохранить копию .md', run: () => exportNote(currentId) },
    { note: 'Shift + правая кнопка — меню браузера с орфографией' },
  );
  showMenu(event.clientX, event.clientY, items, { onClose: () => view.focus() });
}

async function requestComment(view, lineNumber) {
  const { state } = view;
  const sel = state.selection.main;
  const n = lineNumber ?? state.doc.lineAt(sel.empty ? sel.head : Math.max(sel.from, sel.to - 1)).number;
  if (codeLanguageAt(state, state.doc.line(n).from) !== null) {
    toast('Внутри блока кода комментарий сломал бы код');
    return;
  }
  const lines = state.doc.toJSON();
  const target = commentTarget(lines, n);
  const body = await openCommentDialog({
    kicker: copy().commentKicker,
    quote: lines[target - 1].trim() || '(пустая строка)',
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
    toast('Браузер не дал доступ к буферу — используйте Ctrl+C');
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
    toast('Браузер не дал доступ к буферу — используйте Ctrl+V');
  }
}

function onSmartPaste(lang, undoWrap) {
  toast(`Код обёрнут в блок${lang ? ` · ${lang}` : ''}`, { action: { text: 'Отменить', run: undoWrap } });
}

function exportNote(id) {
  const note = notes.get(id);
  if (!note) return;
  const content = id === currentId ? editor.view.state.doc.toString() : note.content;
  api.download(fileNameFor(titleOf(note), new Set()), content);
}

/** Every note as a .md file in one .zip: the backup of the browser build, and handy anywhere. */
async function exportAll() {
  await flushSave();
  const used = new Set();
  const files = [...notes.values()]
    .sort((a, b) => a.created - b.created)
    .map((note) => ({
      name: fileNameFor(titleOf(note), used),
      text: note.id === currentId ? editor.view.state.doc.toString() : note.content,
      date: note.updated,
    }));
  const stamp = new Date().toISOString().slice(0, 10);
  api.download(`ATLAS-заметки-${stamp}.zip`, makeZip(files), 'application/zip');
  api.setState({ lastBackup: Date.now() }).catch(() => {});
  toast(`Скачано: ${formatCount(files.length, NOTE_FORMS)}`);
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
    toast(`Добавлено: ${formatCount(input.files.length, NOTE_FORMS)}`);
  });
  input.click();
}

// ---------- the look: skin, theme, accent ----------

/** Puts the current look on the page: root attributes, the look's words, the map on or off. */
function applyLook({ persist = true } = {}) {
  const root = document.documentElement;
  const skinChanged = root.dataset.skin !== prefs.skin;
  const theme = effectiveTheme();
  root.dataset.skin = prefs.skin;
  root.dataset.theme = theme;
  root.dataset.accent = prefs.accent;
  $('#btn-theme').textContent = theme === 'dark' ? '☀' : '☾';
  const c = copy();
  document.querySelectorAll('[data-copy]').forEach((el) => {
    el.textContent = c[el.dataset.copy];
  });
  document.querySelectorAll('[data-copy-placeholder]').forEach((el) => {
    el.placeholder = c[el.dataset.copyPlaceholder];
  });
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify({ skin: prefs.skin, theme: prefs.theme, accent: prefs.accent }));
  } catch {
    // only a convenience
  }
  if (persist) api.setState({ skin: prefs.skin, theme: prefs.theme, accent: prefs.accent }).catch(() => {});
  if (!editor) return;

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

function setLook(patch) {
  Object.assign(prefs, normalizeLook({ ...prefs, ...patch }));
  applyLook();
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

function applyFontScale(scale, { persist = true } = {}) {
  prefs.fontScale = Math.round(Math.max(0.75, Math.min(1.6, scale)) * 100) / 100;
  document.documentElement.style.setProperty('--fs', String(prefs.fontScale));
  editor?.view.requestMeasure();
  if (!persist) return;
  api.setState({ fontScale: prefs.fontScale }).catch(() => {});
  toast(`Размер текста ${Math.round(prefs.fontScale * 100)}%`, { timeout: 1400 });
}

function toggleFocus(on = !focusMode) {
  focusMode = on;
  $('#app').classList.toggle('focus', on);
  requestAnimationFrame(() => terrain.render('fade'));
  if (on) toast('Режим фокуса · Esc или Ctrl+. — выйти', { timeout: 2200 });
  editor.view.focus();
}

function showSettings() {
  const where = inBrowser
    ? 'Заметки хранятся в этом браузере. Если очистить его данные, они пропадут — время от времени скачивайте копию.'
    : 'Заметки — обычные файлы .md в папке %APPDATA%\\ATLAS Notetaker\\notes.';
  const actions = [
    { text: 'Скачать все заметки (.zip)', run: exportAll },
    { text: 'Импорт .md', run: importFiles },
  ];
  if (api.openNotesFolder) actions.push({ text: 'Открыть папку', run: () => api.openNotesFolder() });
  openSettings({
    data: { text: where, actions },
    getPrefs: () => ({ ...prefs }),
    onChange(patch) {
      if ('fontScale' in patch) applyFontScale(patch.fontScale);
      else setLook(patch);
    },
  });
}

// ---------- commands & keys ----------

function commandList() {
  const c = copy();
  const list = [
    { icon: '＋', title: c.newNote, kbd: 'Ctrl+N', keywords: 'new создать', run: () => createNote() },
    { icon: '◐', title: effectiveTheme() === 'dark' ? 'Светлая тема' : 'Тёмная тема', kbd: 'Ctrl+Shift+L', keywords: 'theme тема', run: toggleTheme },
    {
      icon: '◇',
      title: isAtlas() ? 'Оформление «Минимал»' : 'Оформление «Атлас»',
      keywords: 'skin оформление дизайн атлас минимал',
      run: () => setLook({ skin: isAtlas() ? 'minimal' : 'atlas' }),
    },
    { icon: '⚙', title: 'Настройки', kbd: 'Ctrl+,', keywords: 'settings акцент цвет шрифт размер', run: showSettings },
    { icon: '▤', title: prefs.sidebar ? 'Скрыть список заметок' : 'Показать список заметок', kbd: 'Ctrl+B', keywords: 'sidebar', run: () => applySidebar(!prefs.sidebar) },
    { icon: '◎', title: focusMode ? 'Выйти из режима фокуса' : 'Режим фокуса', kbd: 'Ctrl+.', keywords: 'focus фокус', run: () => toggleFocus() },
    { icon: '❝', title: 'Комментарий к строке', kbd: 'Ctrl+Shift+M', keywords: 'comment', run: () => requestComment(editor.view) },
    { icon: '⌗', title: 'Блок кода', kbd: 'Ctrl+E', keywords: 'code код', run: () => insertCodeBlock(editor.view) },
    { icon: '⇩', title: 'Сохранить копию .md', keywords: 'export экспорт скачать', run: () => exportNote(currentId) },
    { icon: '⇊', title: 'Скачать все заметки (.zip)', keywords: 'backup резервная копия архив экспорт zip', run: exportAll },
    { icon: '⇡', title: 'Импорт .md', keywords: 'import импорт загрузить файлы', run: importFiles },
  ];
  if (isAtlas()) list.splice(1, 0, { icon: '▦', title: 'Атлас заметок', kbd: 'Ctrl+M', keywords: 'atlas карта архипелаг', run: toggleAtlas });
  if (api.openNotesFolder) list.push({ icon: '▭', title: 'Открыть папку заметок', keywords: 'folder папка файлы', run: () => api.openNotesFolder() });
  return list;
}

function openPalette(initial = '') {
  commandPalette({
    initial,
    notes: [...notes.values()]
      .sort((a, b) => b.updated - a.updated)
      .map((n) => ({ id: n.id, title: titleOf(n), meta: `${when(n.updated)} · ${number.format(n.info.words)} сл.`, content: n.content })),
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
  else if (code === 'KeyB' && !shiftKey) applySidebar(!prefs.sidebar);
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
  $('#btn-new-2').addEventListener('click', () => createNote());
  $('#btn-atlas').addEventListener('click', toggleAtlas);
  $('#btn-find').addEventListener('click', () => openPalette());
  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#btn-settings').addEventListener('click', showSettings);
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
  window.addEventListener('pagehide', flushOnExit);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushSave();
      rememberPosition();
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
      save: $('#sb-save').dataset.state,
    };
  },
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
  palette: (initial) => openPalette(initial),
  settings: showSettings,
  setLook,
  toggleAtlas,
  toggleFocus,
  flush: () => flushSave(),
};

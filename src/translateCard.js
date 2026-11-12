// The translation card: a selected passage, Russian ↔ English, shown next to the selection with
// "Copy" and "To note". Used by the reader (library.js) and the notes (app.js); the engines are in
// translate.js. A model that is not on the device yet is downloaded only after a press on the card.

import { h, toast } from './overlays.js';
import { t } from './i18n.js';
import { androidEngine, browserEngine, directionOf, modelEngine, myMemoryEngine, otherWay, pickEngine, translateWith } from './translate.js';
import { androidFiles, bergamotEngine } from './bergamot.js';

let modelCode = null;

/** window.AtlasTranslate from dist/translate.js (transformers.js with the ONNX runtime), loaded once. */
function loadModelCode() {
  if (window.AtlasTranslate) return Promise.resolve(window.AtlasTranslate);
  modelCode ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'dist/translate.js';
    script.onload = () => (window.AtlasTranslate ? resolve(window.AtlasTranslate) : reject(new Error(t('translate.loadFailed'))));
    script.onerror = () => {
      modelCode = null;
      script.remove();
      reject(new Error(t('translate.loadFailed')));
    };
    document.head.append(script);
  });
  return modelCode;
}

const LANG_NAMES = { ru: 'RU', en: 'EN' };

/**
 * api: the bridge (api.copy, and api.translate on the Windows app); android: window.AtlasAndroid.
 * Returns { open({ text, rect, toNote }), close(), isOpen(), receive(event) } — receive takes the
 * Android side's answers (window.__atlas.translate).
 */
export function createTranslator({ api, android = null }) {
  const mlkit = android?.translate ? androidEngine(android) : null;
  // Firefox's offline translator where its files can be fetched (the Windows app's server, the Android app)
  const files = android?.translateFilesStatus ? androidFiles(android) : api.translate ?? null;
  const bergamot = files ? bergamotEngine({ files }) : null;
  const offline = [bergamot, ...(mlkit ? [mlkit] : [browserEngine(), api.translate ? modelEngine({ translateApi: api.translate, loadModelCode }) : null])];
  // MyMemory first (online, no key); the single-file browser build may not reach the network at all
  const online = api.kind === 'browser' && !android ? null : myMemoryEngine();
  const engines = [online, ...offline];
  let onlineOff = false; // MyMemory said no today (its allowance is used up): the device's engines from now on

  let card = null;
  let run = 0; // the latest translation; an older one that finishes late is dropped

  function close() {
    run++;
    card?.remove();
    card = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onPointer, true);
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  }

  function onPointer(e) {
    if (card && !card.contains(e.target)) close();
  }

  /**
   * text: the passage; rect: where it is on screen (the card goes under it, or over it near the
   * bottom); toNote: { title, run(translation) } — what "To note" does here.
   */
  function open({ text, rect, toNote }) {
    const source = String(text ?? '').trim();
    if (!source) return;
    const way = directionOf(source);
    if (!way) {
      toast(t('translate.noWords'));
      return;
    }
    close();
    const heading = h('span', { class: 'tr-way' });
    const body = h('div', { class: 'tr-body', 'aria-live': 'polite' });
    const actions = h('div', { class: 'tr-actions' });
    const swap = h('button', { type: 'button', class: 'tb-btn icon', title: t('translate.swap'), 'aria-label': t('translate.swap') }, '⇄');
    card = h(
      'aside',
      { class: 'tr-card', role: 'dialog', 'aria-label': t('translate.title') },
      h(
        'div',
        { class: 'tr-head' },
        heading,
        swap,
        h('button', { type: 'button', class: 'tb-btn icon', title: t('translate.close'), 'aria-label': t('translate.close'), onclick: close }, '✕'),
      ),
      body,
      actions,
    );
    document.body.append(card);
    place(card, rect);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);

    let current = way;
    let skipOnline = false; // this passage: MyMemory failed, the device translates it
    swap.onclick = () => {
      current = otherWay(current);
      go();
    };

    const say = (message, kind = 'note') => {
      body.replaceChildren(h('p', { class: `tr-${kind}` }, message));
      actions.replaceChildren();
    };

    async function go() {
      const mine = ++run;
      const pair = `${current.from}-${current.to}`;
      heading.textContent = `${LANG_NAMES[current.from]} → ${LANG_NAMES[current.to]}`;
      say(t('translate.working'));
      const live = () => mine === run && card;
      try {
        const picked = await pickEngine(onlineOff || skipOnline ? offline : engines, pair);
        if (!live()) return;
        if (!picked) return say(t(api.kind === 'browser' && !android ? 'translate.unavailableBrowser' : 'translate.unavailable'), 'error');
        if (picked.state === 'download') {
          // nothing is downloaded before the person says so
          body.replaceChildren(h('p', { class: 'tr-note' }, t(`translate.download.${picked.engine.name}`)));
          actions.replaceChildren(
            h('button', { type: 'button', class: 'tb-btn', onclick: close }, t('dialog.cancel')),
            h('button', { type: 'button', class: 'tb-btn accent', onclick: () => fetchModel(picked.engine, pair, mine) }, t('translate.downloadOk')),
          );
          actions.lastChild.focus({ preventScroll: true });
          return;
        }
        await translate(picked.engine, pair, mine);
      } catch (err) {
        if (!live()) return;
        // MyMemory out of reach or out of allowance: the same passage on the device, if it can
        if (err?.code === 'quota' || err?.code === 'network') {
          if (err.code === 'quota') onlineOff = true;
          if (!skipOnline && (await pickEngine(offline, pair))) {
            skipOnline = true;
            toast(t(`translate.offlineNow.${err.code}`));
            return go();
          }
        }
        failed(err);
      }
    }

    async function fetchModel(engine, pair, mine) {
      const bar = h('i');
      const progress = h('div', { class: 'tr-progress' }, bar);
      const label = h('p', { class: 'tr-note' }, t('translate.downloading'));
      body.replaceChildren(label, progress);
      actions.replaceChildren();
      try {
        await engine.prepare(pair, (share) => {
          if (share > 0) {
            progress.classList.add('known');
            bar.style.transform = `scaleX(${Math.min(1, share)})`;
            label.textContent = t('translate.downloadingPct', Math.round(share * 100));
          }
        });
        if (mine !== run || !card) return;
        await translate(engine, pair, mine);
      } catch (err) {
        if (mine === run && card) failed(err);
      }
    }

    async function translate(engine, pair, mine) {
      say(t('translate.working'));
      const result = await translateWith(engine, pair, source);
      if (mine !== run || !card) return;
      body.replaceChildren(h('p', { class: 'tr-text', lang: current.to }, result));
      actions.replaceChildren(
        h(
          'button',
          {
            type: 'button',
            class: 'tb-btn',
            onclick: async () => {
              try {
                await api.copy(result);
                toast(t('translate.copied'));
              } catch {
                toast(t('translate.copyFailed'));
              }
            },
          },
          '⧉ ',
          t('translate.copy'),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'tb-btn accent',
            title: toNote?.title ?? '',
            onclick: () => {
              close();
              toNote?.run(result);
            },
          },
          '❝ ',
          t('translate.toNote'),
        ),
      );
    }

    function failed(err) {
      console.error(err);
      const key = `translate.errors.${err?.code}`;
      say(err?.code && t(key) !== key ? t(key) : t('translate.failed', err?.message || String(err)), 'error');
    }

    go();
  }

  return {
    open,
    close,
    isOpen: () => Boolean(card),
    /** Firefox's offline model: null where there is none; else { ready } for both directions. */
    async offline() {
      if (!bergamot) return null;
      const states = await Promise.all(['ru-en', 'en-ru'].map((pair) => bergamot.state(pair)));
      if (states.includes('unavailable')) return null;
      return { ready: states.every((s) => s === 'ready') };
    },
    /** Downloads it for both directions; onProgress(share 0..1). */
    async prepareOffline(onProgress) {
      let done = 0;
      for (const pair of ['ru-en', 'en-ru']) {
        await bergamot.prepare(pair, (share) => onProgress?.((done + share) / 2));
        done += 1;
      }
    },
    receive: (event) => (files?.receive?.(event) ? undefined : mlkit?.receive(event)),
  };
}

/** Under the passage, or over it when there is no room below; on a narrow screen, along the bottom. */
function place(card, rect) {
  if (!rect || innerWidth <= 560) {
    card.classList.add('tr-sheet');
    return;
  }
  const left = Math.max(8, Math.min(innerWidth - card.offsetWidth - 8, rect.left));
  card.style.left = `${left}px`;
  // the card grows once the translation is in: below the passage it grows down, over it — up
  if (rect.bottom + 8 + 260 < innerHeight) card.style.top = `${rect.bottom + 8}px`;
  else card.style.bottom = `${Math.max(8, innerHeight - rect.top + 8)}px`;
}

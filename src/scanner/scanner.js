// The document scanner: a full-screen layer over the notes screen, in four views —
//   capture  the camera (the sheet's outline found live), the gallery, the pages taken so far;
//   adjust   one photo with the sheet's four corners to move (a loupe under the finger), a turn by 90°;
//   process  the pages being flattened and read, one after another, with how far it has got;
//   result   the text to correct, saved into a new note (with the pages' pictures if wanted) or as TXT,
//            and what the recognizer took (time, memory) for the person who measures it.
// Pages go to the engine (engine.js) as soon as they are accepted, so reading runs while the next
// photo is taken. Everything stays on the device. Styles: scanner.css (dist/scanner.css, loaded on
// first use); motion follows the app's tokens and gives way to "reduce motion" and Settings → Animations.

import { h, toast, confirmDialog, openDialog } from '../overlays.js';
import { t, currentLocale } from '../i18n.js';
import { motionOn } from '../motion.js';
import { startCamera, watchSheet, findSheet } from './camera.js';
import { pageConfidence, scanText } from './layout.js';

const MAX_PAGES = 30;
const LOW_CONFIDENCE = 0.8;
const FULL = [[0.04, 0.04], [0.96, 0.04], [0.96, 0.96], [0.04, 0.96]];
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};
const pts = (quad, w, h) => quad.map(([x, y]) => `${(x * w).toFixed(1)},${(y * h).toFixed(1)}`).join(' ');
const lerpQuad = (a, b, k) => a.map((p, i) => [p[0] + (b[i][0] - p[0]) * k, p[1] + (b[i][1] - p[1]) * k]);
/** Waits for a picture to load (onload rather than decode(): that one may wait for the screen). */
function loaded(img, timeout = 15000) {
  if (img.complete && img.naturalWidth) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(reject, new Error('timeout')), timeout);
    const done = (fn, arg) => {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      fn(arg);
    };
    img.onload = () => done(resolve);
    img.onerror = () => done(reject, new Error('not a picture'));
  });
}

let nextId = 0;
const newId = () => `p${Date.now().toString(36)}-${(nextId++).toString(36)}`;

let stylesLoaded = null;
/** dist/scanner.css, once; the layer waits for it so it never shows unstyled. */
function loadStyles() {
  stylesLoaded ??= new Promise((resolve) => {
    if (document.querySelector('link[data-scanner-css]')) return resolve();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'dist/scanner.css';
    link.dataset.scannerCss = '';
    link.onload = () => resolve();
    link.onerror = () => resolve(); // unstyled is still usable; nothing to wait for
    document.head.append(link);
  });
  return stylesLoaded;
}

/** Icons of the scanner's own buttons (16×16, the stroke of icons.js). */
const ICONS = {
  close: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>',
  back: '<path d="M13.5 8H2.75M7 3.75L2.75 8 7 12.25"/>',
  gallery: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><circle cx="5.5" cy="6.25" r="1.25"/><path d="M2 12.25l3.75-3.5 2.75 2.5 2.25-2 3.25 3"/>',
  torch: '<path d="M5.5 1.75h5l-1 4h-3zM6.5 5.75h3v8.5h-3z"/><path d="M8 8.5v2"/>',
  rotate: '<path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.75 2.5v2.75H10"/>',
  full: '<path d="M2.25 5.5V2.25H5.5M10.5 2.25h3.25V5.5M13.75 10.5v3.25H10.5M5.5 13.75H2.25V10.5"/>',
  trash: '<path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4 4.25l.75 9.5h6.5l.75-9.5"/>',
  left: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
  right: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  check: '<path d="M3 8.5l3.25 3.25L13 4.75"/>',
  copy: '<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.75"/><path d="M10.75 5.25V3.5a1.25 1.25 0 0 0-1.25-1.25h-6A1.25 1.25 0 0 0 2.25 3.5v6a1.25 1.25 0 0 0 1.25 1.25h1.75"/>',
  file: '<path d="M3.25 1.75h6l3.5 3.5v9H3.25z"/><path d="M9.25 1.75v3.5h3.5M5.5 8.5h5M5.5 11h3.5"/>',
};
function ico(name) {
  const node = svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', class: 'scan-ico', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  node.innerHTML = ICONS[name];
  return node;
}
const button = (cls, label, iconName, onclick, text = null) =>
  h('button', { type: 'button', class: cls, title: label, 'aria-label': label, onclick }, iconName ? ico(iconName) : null, text ? h('span', {}, text) : null);

/**
 * engine: engine.js; saveNote({ title, text, images: [{ blob, alt }], folder }) → Promise;
 * download(name, text, type); copy(text) → Promise<boolean>; onClosed().
 */
export function createScanner({ engine, saveNote, download, copy, onClosed = () => {} }) {
  let root = null;
  let view = 'capture';
  let pages = [];
  let editing = null; // { page, isNew }
  let folder = '';
  let camera = null;
  let stopWatch = null;
  let liveQuad = null;
  let working = null; // the page being processed
  let cameraState = 'off'; // off | starting | on | failed
  let resultText = null; // the text as the person edits it (null: not shown yet)
  let resultEdited = false;
  let keepLines = false;
  let imagesMode = 'none';
  let stageW = 0; // the photo's size on the screen, before its turn (layoutAdjust)
  let stageH = 0;
  const els = {};

  // ---------- open, close, back ----------

  async function open({ folder: where = '' } = {}) {
    if (root) return;
    folder = where;
    await loadStyles();
    root = h('section', { class: 'scan', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('scanner.title'), 'data-view': 'capture' });
    root.append(buildCapture(), buildAdjust(), buildProcess(), buildResult());
    document.body.append(root);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize);
    if (motionOn()) root.classList.add('scan-entering');
    requestAnimationFrame(() => root?.classList.remove('scan-entering'));
    show('capture');
  }

  function isOpen() {
    return Boolean(root);
  }

  async function close({ force = false } = {}) {
    if (!root) return;
    const unsaved = pages.length && !force;
    if (unsaved && !(await confirmDialog({ title: t('scanner.closeTitle'), text: t('scanner.closeText'), ok: t('scanner.closeOk'), danger: true }))) return;
    stopCamera();
    if (working) engine.cancel(working.id);
    for (const p of pages) revoke(p);
    pages = [];
    engine.close();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('resize', onResize);
    const node = root;
    root = null;
    resultText = null;
    resultEdited = false;
    if (motionOn()) {
      node.classList.add('scan-leaving');
      setTimeout(() => node.remove(), 260);
    } else {
      node.remove();
    }
    onClosed();
  }

  /** The back button (Android) or Escape: one step back; true when the scanner took it. */
  function back() {
    if (!root) return false;
    if (document.querySelector('#overlays .scrim')) return false; // a dialog over the scanner closes first
    if (view === 'adjust') cancelAdjust();
    else if (view === 'process') show('capture');
    else if (view === 'result') show('capture');
    else close();
    return true;
  }

  function onKey(e) {
    if (e.key !== 'Escape' || !root || document.querySelector('#overlays .scrim')) return;
    e.preventDefault();
    e.stopPropagation();
    back();
  }

  function onVisibility() {
    if (!root) return;
    if (document.hidden) stopCamera();
    else if (view === 'capture') startCameraView();
  }

  function onResize() {
    if (view === 'adjust') layoutAdjust();
  }

  function show(next) {
    const prev = view;
    view = next;
    root.dataset.view = next;
    root.dataset.from = prev;
    if (next === 'capture') {
      startCameraView();
      drawTray();
    } else {
      stopCamera();
    }
    if (next === 'adjust') requestAnimationFrame(layoutAdjust);
    if (next === 'process') drawProcess();
    if (next === 'result') drawResult();
    const focusable = root.querySelector(`.scan-view[data-name="${next}"] [data-autofocus]`);
    focusable?.focus({ preventScroll: true });
  }

  // ---------- capture ----------

  function buildCapture() {
    els.video = h('video', { class: 'scan-video', muted: true, playsinline: true, autoplay: true });
    els.live = svg('svg', { class: 'scan-live', preserveAspectRatio: 'none' });
    els.livePoly = svg('polygon', { class: 'scan-live-quad' });
    els.live.append(els.livePoly);
    els.flash = h('div', { class: 'scan-flash' });
    els.camMessage = h('div', { class: 'scan-cam-message', hidden: true });
    els.torch = button('scan-round scan-torch', t('scanner.torch'), 'torch', toggleTorch);
    els.torch.hidden = true;
    els.hint = h('div', { class: 'scan-hint' }, t('scanner.hint'));
    els.tray = h('div', { class: 'scan-tray', role: 'list', 'aria-label': t('scanner.pages') });
    els.shutter = h('button', { type: 'button', class: 'scan-shutter', title: t('scanner.shoot'), 'aria-label': t('scanner.shoot'), onclick: shoot }, h('span'));
    els.gallery = button('scan-round', t('scanner.gallery'), 'gallery', pickFromGallery);
    els.done = h('button', { type: 'button', class: 'scan-done', onclick: finish, disabled: true }, ico('check'), h('span', { class: 'scan-done-label' }, t('scanner.done')), h('span', { class: 'scan-count' }, '0'));
    els.fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    els.fileInput.addEventListener('change', () => {
      const files = [...(els.fileInput.files ?? [])];
      els.fileInput.value = '';
      addFiles(files);
    });
    return h(
      'div',
      { class: 'scan-view scan-capture', 'data-name': 'capture' },
      h('div', { class: 'scan-viewport' }, els.video, els.live, els.flash, els.camMessage),
      h('header', { class: 'scan-top' }, button('scan-round', t('scanner.close'), 'close', () => close()), h('h2', { class: 'scan-title' }, t('scanner.title')), els.torch),
      h('footer', { class: 'scan-bottom' }, els.hint, els.tray, h('div', { class: 'scan-controls' }, els.gallery, els.shutter, els.done)),
      els.fileInput,
    );
  }

  async function startCameraView() {
    if (camera || cameraState === 'starting' || document.hidden || !root) return;
    cameraState = 'starting';
    els.camMessage.hidden = true;
    try {
      const cam = await startCamera(els.video);
      if (!root || view !== 'capture' || document.hidden) {
        cam.stop();
        cameraState = 'off';
        return;
      }
      camera = cam;
      cameraState = 'on';
      els.torch.hidden = !cam.torch.supported;
      els.torch.classList.toggle('on', cam.torch.on);
      els.shutter.disabled = false;
      liveQuad = null;
      stopWatch = watchSheet(els.video, onLiveSheet);
    } catch (err) {
      cameraState = 'failed';
      els.shutter.disabled = true;
      els.camMessage.hidden = false;
      els.camMessage.replaceChildren(
        h('p', {}, t(`scanner.camera.${err.code ?? 'unsupported'}`)),
        h('div', { class: 'scan-cam-actions' },
          h('button', { type: 'button', class: 'btn primary', onclick: pickFromGallery }, t('scanner.gallery')),
          err.code === 'unsupported' || err.code === 'missing' ? null : h('button', { type: 'button', class: 'btn', onclick: () => { cameraState = 'off'; startCameraView(); } }, t('scanner.retry')),
        ),
      );
    }
  }

  function stopCamera() {
    stopWatch?.();
    stopWatch = null;
    camera?.stop();
    camera = null;
    if (cameraState !== 'failed') cameraState = 'off';
    if (els.livePoly) els.live.classList.remove('found');
  }

  /** The live outline: eased toward each new finding, hidden when nothing sheet-like is seen. */
  function onLiveSheet({ quad, confidence }) {
    const vw = els.video.videoWidth;
    const vh = els.video.videoHeight;
    if (!vw || !vh) return;
    // the video fills the screen (object-fit: cover): the outline uses the video's own coordinates
    els.live.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
    els.live.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    const found = quad && confidence >= 0.45;
    els.live.classList.toggle('found', Boolean(found));
    if (!found) return;
    liveQuad = liveQuad && motionOn() ? lerpQuad(liveQuad, quad, 0.6) : quad;
    els.livePoly.setAttribute('points', pts(liveQuad, vw, vh));
  }

  async function toggleTorch() {
    if (!camera) return;
    const on = await camera.torch.set(!camera.torch.on);
    els.torch.classList.toggle('on', on);
  }

  async function shoot() {
    if (!camera || els.shutter.disabled) return;
    if (pages.length >= MAX_PAGES) return toast(t('scanner.tooMany', MAX_PAGES));
    els.shutter.disabled = true;
    root.classList.add('scan-shooting');
    if (motionOn()) {
      els.flash.classList.remove('go');
      void els.flash.offsetWidth;
      els.flash.classList.add('go');
    }
    const guess = liveQuad;
    try {
      const blob = await camera.capture();
      await beginAdjust(blob, guess);
    } catch {
      toast(t('scanner.shotFailed'));
    } finally {
      root?.classList.remove('scan-shooting');
      if (els.shutter) els.shutter.disabled = false;
    }
  }

  function pickFromGallery() {
    els.fileInput.click();
  }

  /** Pictures from the gallery: one is adjusted by hand; several go straight in, corners found. */
  async function addFiles(files) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    const room = MAX_PAGES - pages.length;
    if (images.length > room) toast(t('scanner.tooMany', MAX_PAGES));
    const taken = images.slice(0, Math.max(0, room));
    if (taken.length === 1) return beginAdjust(taken[0], null);
    for (const file of taken) {
      const page = await newPage(file);
      if (!page) continue;
      pages.push(page);
      queue(page);
    }
    drawTray();
  }

  /** A page from a photo: its size, and where the sheet seems to be. */
  async function newPage(blob, guess = null) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try {
      await loaded(img);
    } catch {
      URL.revokeObjectURL(url);
      toast(t('scanner.notPicture'));
      return null;
    }
    let quad = guess;
    let confidence = guess ? 1 : 0;
    try {
      const found = findSheet(img, img.naturalWidth, img.naturalHeight);
      if (found.quad && found.confidence >= 0.35) ({ quad, confidence } = found);
    } catch {
      // the frame stays where it was
    }
    return { id: newId(), blob, photoUrl: url, width: img.naturalWidth, height: img.naturalHeight, quad: quad ?? FULL, found: Boolean(quad), confidence, rotate: 0, status: 'new', result: null, thumb: null };
  }

  // ---------- the pages tray ----------

  function drawTray() {
    if (!els.tray) return;
    const items = pages.map((p, i) => {
      const thumb = h('button', { type: 'button', class: `scan-thumb is-${p.status}`, role: 'listitem', 'data-id': p.id, title: t('scanner.pageN', i + 1), 'aria-label': `${t('scanner.pageN', i + 1)} · ${t(`scanner.status.${p.status}`)}`, onclick: () => beginAdjust(null, null, p) });
      if (p.thumb) thumb.append(h('img', { src: p.thumb, alt: '' }));
      thumb.append(h('span', { class: 'scan-thumb-n' }, String(i + 1)));
      if (p.status === 'waiting' || p.status === 'working') thumb.append(h('span', { class: 'scan-spinner', 'aria-hidden': 'true' }));
      if (p.status === 'failed') thumb.append(h('span', { class: 'scan-thumb-bad', 'aria-hidden': 'true' }, '!'));
      return thumb;
    });
    els.tray.replaceChildren(...items);
    els.tray.hidden = !pages.length;
    els.hint.hidden = Boolean(pages.length);
    els.done.disabled = !pages.length;
    els.done.querySelector('.scan-count').textContent = String(pages.length);
    const last = els.tray.lastElementChild;
    last?.scrollIntoView?.({ block: 'nearest', inline: 'end', behavior: motionOn() ? 'smooth' : 'auto' });
  }

  // ---------- adjust ----------

  function buildAdjust() {
    els.stage = h('div', { class: 'scan-stage' });
    els.photo = h('img', { class: 'scan-photo', alt: '', draggable: 'false' });
    els.frame = svg('svg', { class: 'scan-frame' });
    els.shade = svg('path', { class: 'scan-shade', 'fill-rule': 'evenodd' });
    els.quad = svg('polygon', { class: 'scan-quad' });
    els.frame.append(els.shade, els.quad);
    els.handles = [0, 1, 2, 3].map((i) => {
      const handle = h('div', { class: 'scan-handle', role: 'slider', tabindex: '0', 'aria-label': t(`scanner.corner${i}`) }, h('span'));
      handle.addEventListener('pointerdown', (e) => dragCorner(e, i));
      handle.addEventListener('keydown', (e) => nudgeCorner(e, i));
      return handle;
    });
    els.loupe = h('canvas', { class: 'scan-loupe', width: 220, height: 220, hidden: true });
    els.stage.append(els.photo, els.frame, ...els.handles);
    els.adjustTitle = h('h2', { class: 'scan-title' });
    els.rotateBadge = h('span', { class: 'scan-rotate-badge', hidden: true });
    els.moveLeft = button('scan-round', t('scanner.earlier'), 'left', () => movePage(-1));
    els.moveRight = button('scan-round', t('scanner.later'), 'right', () => movePage(1));
    els.remove = button('scan-round', t('scanner.removePage'), 'trash', removePage);
    els.accept = h('button', { type: 'button', class: 'scan-accept', 'data-autofocus': '', onclick: acceptAdjust }, ico('check'), h('span', {}, t('scanner.keep')));
    return h(
      'div',
      { class: 'scan-view scan-adjust', 'data-name': 'adjust' },
      h('header', { class: 'scan-top' }, button('scan-round', t('scanner.back'), 'back', cancelAdjust), els.adjustTitle, els.moveLeft, els.moveRight, els.remove),
      h('div', { class: 'scan-stage-wrap' }, els.stage, els.rotateBadge),
      els.loupe,
      h(
        'footer',
        { class: 'scan-bottom scan-adjust-bar' },
        button('scan-tool', t('scanner.rotate'), 'rotate', rotatePage, t('scanner.rotate')),
        button('scan-tool', t('scanner.wholePhoto'), 'full', () => setQuad(FULL, true), t('scanner.wholePhoto')),
        els.accept,
      ),
    );
  }

  async function beginAdjust(blob, guess, existing = null) {
    let page = existing;
    if (!page) {
      page = await newPage(blob, guess);
      if (!page) return;
      editing = { page, isNew: true, before: null };
    } else {
      // the page waits while it is edited; a reading under way is stopped and its answer ignored
      if (page.status === 'working') engine.cancel(page.id);
      editing = { page, isNew: false, before: { quad: page.quad, rotate: page.rotate, status: page.status, result: page.result } };
      page.version = (page.version ?? 0) + 1;
      page.status = 'editing';
      if (!page.photoUrl) page.photoUrl = page.blob ? URL.createObjectURL(page.blob) : `/scan/${page.id}.src`;
    }
    els.photo.src = page.photoUrl;
    try {
      await loaded(els.photo);
    } catch {
      // shown when it comes
    }
    const index = pages.indexOf(page);
    els.adjustTitle.textContent = index >= 0 ? t('scanner.pageN', index + 1) : t('scanner.newPage');
    els.moveLeft.hidden = els.moveRight.hidden = els.remove.hidden = index < 0;
    els.moveLeft.disabled = index <= 0;
    els.moveRight.disabled = index < 0 || index >= pages.length - 1;
    show('adjust');
    layoutAdjust();
    // the frame grows from the whole photo to the sheet: where the finder put it
    const target = page.quad;
    if (motionOn() && editing.isNew && page.found) {
      drawQuad(FULL);
      animateQuad(FULL, target);
    } else {
      drawQuad(target);
    }
  }

  /** The photo fitted into the stage, turned as the page will be. */
  function layoutAdjust() {
    if (!editing || !root) return;
    const { page } = editing;
    const wrap = els.stage.parentElement;
    const availW = wrap.clientWidth - 24;
    const availH = wrap.clientHeight - 24;
    const turned = page.rotate % 180 !== 0;
    const k = Math.min(availW / (turned ? page.height : page.width), availH / (turned ? page.width : page.height));
    const w = Math.max(1, Math.round(page.width * k));
    const hgt = Math.max(1, Math.round(page.height * k));
    stageW = w;
    stageH = hgt;
    els.stage.style.width = `${w}px`;
    els.stage.style.height = `${hgt}px`;
    els.stage.style.transform = `rotate(${page.rotate}deg)`;
    els.stage.style.setProperty('--counter', `${-page.rotate}deg`);
    els.frame.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    els.rotateBadge.hidden = !page.rotate;
    els.rotateBadge.textContent = `↻ ${page.rotate}°`;
    drawQuad(page.quad);
  }

  function drawQuad(quad) {
    const w = stageW;
    const hgt = stageH;
    if (!w || !hgt) return;
    els.quad.setAttribute('points', pts(quad, w, hgt));
    els.shade.setAttribute('d', `M0 0H${w}V${hgt}H0Z M${pts(quad, w, hgt).replace(/ /g, ' L')}Z`);
    quad.forEach(([x, y], i) => {
      els.handles[i].style.left = `${x * w}px`;
      els.handles[i].style.top = `${y * hgt}px`;
      els.handles[i].setAttribute('aria-valuetext', `${Math.round(x * 100)}%, ${Math.round(y * 100)}%`);
    });
  }

  function animateQuad(from, to) {
    const start = performance.now();
    const dur = 420;
    const ease = (x) => 1 - (1 - x) ** 3;
    const step = (now) => {
      if (!editing) return;
      const k = Math.min(1, (now - start) / dur);
      drawQuad(lerpQuad(from, to, ease(k)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function setQuad(quad, animate = false) {
    if (!editing) return;
    const from = editing.page.quad;
    editing.page.quad = quad.map((p) => [...p]);
    if (animate && motionOn()) animateQuad(from, editing.page.quad);
    else drawQuad(editing.page.quad);
  }

  /** A point on the screen → a fraction of the photo, through the stage's turn. */
  function toPhoto(clientX, clientY) {
    const r = els.stage.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const a = (-editing.page.rotate * Math.PI) / 180;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const x = dx * Math.cos(a) - dy * Math.sin(a) + stageW / 2;
    const y = dx * Math.sin(a) + dy * Math.cos(a) + stageH / 2;
    return [Math.min(1, Math.max(0, x / stageW)), Math.min(1, Math.max(0, y / stageH))];
  }

  function dragCorner(e, i) {
    if (!editing) return;
    e.preventDefault();
    const handle = els.handles[i];
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    // the finger covers the corner: the loupe shows it above, two and a half times larger
    const move = (ev) => {
      const quad = editing.page.quad.map((p) => [...p]);
      quad[i] = toPhoto(ev.clientX, ev.clientY);
      editing.page.quad = quad;
      drawQuad(quad);
      drawLoupe(ev.clientX, ev.clientY, quad[i]);
    };
    const up = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      els.loupe.hidden = true;
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    move(e);
  }

  function nudgeCorner(e, i) {
    const step = e.shiftKey ? 0.02 : 0.005;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d || !editing) return;
    e.preventDefault();
    const quad = editing.page.quad.map((p) => [...p]);
    quad[i] = [Math.min(1, Math.max(0, quad[i][0] + d[0])), Math.min(1, Math.max(0, quad[i][1] + d[1]))];
    setQuad(quad);
  }

  function drawLoupe(clientX, clientY, [fx, fy]) {
    const img = els.photo;
    if (!img.naturalWidth) return;
    const c = els.loupe;
    const ctx = c.getContext('2d');
    const zoom = 2.5;
    const shown = stageW / img.naturalWidth; // screen pixels per photo pixel
    const cssSize = c.getBoundingClientRect().width || 110;
    const span = cssSize / (zoom * shown) / 2; // half the loupe's width, in photo pixels
    const sx = fx * img.naturalWidth;
    const sy = fy * img.naturalHeight;
    ctx.save();
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((editing.page.rotate * Math.PI) / 180);
    ctx.drawImage(img, sx - span, sy - span, span * 2, span * 2, -c.width / 2, -c.height / 2, c.width, c.height);
    ctx.restore();
    ctx.strokeStyle = getComputedStyle(root).getPropertyValue('--scan-accent') || '#ff6a2b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c.width / 2 - 14, c.height / 2);
    ctx.lineTo(c.width / 2 + 14, c.height / 2);
    ctx.moveTo(c.width / 2, c.height / 2 - 14);
    ctx.lineTo(c.width / 2, c.height / 2 + 14);
    ctx.stroke();
    // above the finger, or below it near the top of the screen
    const size = cssSize;
    const above = clientY - size - 48 > 8;
    c.style.left = `${Math.min(window.innerWidth - size - 8, Math.max(8, clientX - size / 2))}px`;
    c.style.top = `${above ? clientY - size - 48 : clientY + 48}px`;
    c.hidden = false;
  }

  function rotatePage() {
    if (!editing) return;
    editing.page.rotate = (editing.page.rotate + 90) % 360;
    layoutAdjust();
  }

  function cancelAdjust() {
    if (!editing) return show('capture');
    const { page, isNew, before } = editing;
    editing = null;
    if (isNew) revoke(page);
    else restoreOrQueue(page, before, false);
    show('capture');
  }

  function acceptAdjust() {
    if (!editing) return;
    const { page, isNew, before } = editing;
    editing = null;
    if (isNew) {
      pages.push(page);
      queue(page);
    } else {
      const changed = before.rotate !== page.rotate || JSON.stringify(before.quad) !== JSON.stringify(page.quad);
      restoreOrQueue(page, before, changed);
    }
    flyToTray(page);
    show('capture');
  }

  /** The kept photo shrinks into its place in the tray (or just appears there). */
  function flyToTray(page) {
    if (!motionOn()) return;
    const from = els.stage.getBoundingClientRect();
    requestAnimationFrame(() => {
      const target = els.tray.querySelector(`[data-id="${page.id}"]`);
      if (!target || !from.width) return;
      const to = target.getBoundingClientRect();
      const ghost = h('img', { class: 'scan-ghost', src: page.photoUrl ?? '', alt: '' });
      Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
      root.append(ghost);
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      const k = to.width / from.width;
      const anim = ghost.animate(
        [
          { transform: 'translate(0, 0) scale(1)', opacity: 1, borderRadius: '4px' },
          { transform: `translate(${dx}px, ${dy}px) scale(${k})`, opacity: 0.6, borderRadius: `${8 / k}px` },
        ],
        { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      );
      anim.onfinish = anim.oncancel = () => ghost.remove();
    });
  }

  /** After an edit: the page's earlier answer stands if nothing changed and it had one, else it is read again. */
  function restoreOrQueue(page, before, changed) {
    if (!changed) Object.assign(page, { quad: before.quad, rotate: before.rotate });
    if (!changed && before.result && ['done', 'flat'].includes(before.status)) {
      page.status = before.status;
      page.result = before.result;
      drawTray();
    } else {
      queue(page);
    }
  }

  function movePage(dir) {
    if (!editing) return;
    const i = pages.indexOf(editing.page);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= pages.length) return;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    resultEdited = false;
    resultText = null;
    els.adjustTitle.textContent = t('scanner.pageN', j + 1);
    els.moveLeft.disabled = j <= 0;
    els.moveRight.disabled = j >= pages.length - 1;
  }

  async function removePage() {
    if (!editing) return;
    const { page } = editing;
    if (!(await confirmDialog({ title: t('scanner.removeTitle'), ok: t('scanner.removeOk'), danger: true }))) return;
    if (page.status === 'working') engine.cancel(page.id);
    pages = pages.filter((p) => p !== page);
    revoke(page);
    engine.drop(page.id);
    editing = null;
    resultText = null;
    show('capture');
  }

  function revoke(page) {
    if (page.photoUrl?.startsWith('blob:')) URL.revokeObjectURL(page.photoUrl);
    if (page.thumb?.startsWith('blob:')) URL.revokeObjectURL(page.thumb);
    page.photoUrl = null;
    page.thumb = null;
  }

  // ---------- processing, page after page ----------

  function queue(page) {
    page.version = (page.version ?? 0) + 1;
    page.status = 'waiting';
    page.result = null;
    resultText = null;
    resultEdited = false;
    drawTray();
    pump();
  }

  async function pump() {
    if (working || !root) return;
    const page = pages.find((p) => p.status === 'waiting');
    if (!page) {
      if (view === 'process') show('result');
      return;
    }
    working = page;
    const version = page.version;
    page.status = 'working';
    page.stage = 'upload';
    drawTray();
    if (view === 'process') drawProcess();
    let result;
    try {
      result = await engine.process(
        { id: page.id, blob: page.blob, quad: page.quad, rotate: page.rotate },
        {
          onStage: (stage) => {
            page.stage = stage;
            if (view === 'process') drawProcess();
          },
        },
      );
    } catch (err) {
      result = { ok: false, code: err?.code ?? 'internal' };
    }
    working = null;
    if (!root) return;
    // removed, edited or queued again meanwhile: this answer is not for the page as it is now
    if (!pages.includes(page) || page.version !== version || result.code === 'cancelled') {
      if (page.status === 'working') page.status = 'waiting';
      drawTray();
      return pump();
    }
    page.result = result;
    // the text is there, or (no recognizer, or it failed) at least the flattened page
    page.status = result.ok ? 'done' : result.image ? 'flat' : 'failed';
    if (result.image) page.thumb = await thumbnail(result, page.thumb);
    if (engine.kind === 'android' && result.image && page.blob) {
      // the photo is in the app's cache now: the page lets go of its copy (memory for the next ones)
      page.blob = null;
      if (page.photoUrl?.startsWith('blob:')) URL.revokeObjectURL(page.photoUrl);
      page.photoUrl = null;
    }
    if (!result.ok && result.code === 'memory') toast(t('scanner.error.memory'));
    drawTray();
    if (view === 'process') drawProcess();
    pump();
  }

  /** The flattened page as a Blob: the engine's own, or fetched from the app (/scan/…). */
  async function pageBlob(result) {
    if (result.blob) return result.blob;
    const response = await fetch(result.image);
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    return blob.type ? blob : new Blob([blob], { type: 'image/jpeg' });
  }

  /** A small copy of the flattened page for the tray (never the full page: thirty of those would not fit in memory). */
  async function thumbnail(result, old) {
    try {
      const blob = await pageBlob(result);
      const bitmap = await createImageBitmap(blob, { resizeWidth: 144, resizeQuality: 'medium' });
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      bitmap.close();
      const small = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
      return small ? URL.createObjectURL(small) : old;
    } catch {
      return old;
    }
  }

  function finish() {
    if (!pages.length) return;
    if (pages.some((p) => p.status === 'waiting' || p.status === 'working')) show('process');
    else show('result');
  }

  function buildProcess() {
    els.procImage = h('img', { class: 'scan-proc-image', alt: '' });
    els.procPage = h('div', { class: 'scan-proc-page' }, els.procImage, h('div', { class: 'scan-sweep', 'aria-hidden': 'true' }));
    els.procText = h('p', { class: 'scan-proc-text', role: 'status', 'aria-live': 'polite' });
    els.procBar = h('div', { class: 'scan-progress' }, h('span'));
    return h(
      'div',
      { class: 'scan-view scan-process', 'data-name': 'process' },
      h('header', { class: 'scan-top' }, button('scan-round', t('scanner.back'), 'back', () => show('capture')), h('h2', { class: 'scan-title' }, t('scanner.reading'))),
      h('div', { class: 'scan-proc-body' }, els.procPage, els.procText, els.procBar),
      h('footer', { class: 'scan-bottom' }, h('button', { type: 'button', class: 'btn', 'data-autofocus': '', onclick: () => show('capture') }, t('scanner.addMore'))),
    );
  }

  const STAGE_SHARE = { upload: 0.05, decode: 0.15, flatten: 0.25, load: 0.35, recognize: 0.5 };

  function drawProcess() {
    if (!els.procText) return;
    const done = pages.filter((p) => p.status === 'done' || p.status === 'flat' || p.status === 'failed').length;
    const current = working ?? pages.find((p) => p.status === 'waiting');
    const n = current ? pages.indexOf(current) + 1 : pages.length;
    const stage = current?.stage ? t(`scanner.stage.${current.stage}`) : '';
    els.procText.textContent = current ? `${t('scanner.pageOf', n, pages.length)} · ${stage}` : t('scanner.allRead');
    const share = (done + (current ? STAGE_SHARE[current.stage] ?? 0 : 0)) / pages.length;
    els.procBar.firstElementChild.style.transform = `scaleX(${Math.min(1, share).toFixed(3)})`;
    const shown = current?.photoUrl ?? current?.thumb ?? pages[pages.length - 1]?.thumb ?? '';
    if (shown && els.procImage.getAttribute('src') !== shown) els.procImage.src = shown;
  }

  // ---------- result ----------

  function buildResult() {
    els.resTitle = h('input', { class: 'field scan-res-title', type: 'text', maxlength: '120', 'aria-label': t('scanner.noteTitle'), placeholder: t('scanner.noteTitle') });
    els.resText = h('textarea', { class: 'field scan-res-text', spellcheck: 'true', 'aria-label': t('scanner.textLabel') });
    els.resText.addEventListener('input', () => {
      resultText = els.resText.value;
      resultEdited = true;
    });
    els.resNotes = h('div', { class: 'scan-res-notes' });
    els.keepLines = h('input', { type: 'checkbox' });
    els.keepLines.addEventListener('change', async () => {
      if (resultEdited && !(await confirmDialog({ title: t('scanner.relayoutTitle'), text: t('scanner.relayoutText'), ok: t('scanner.relayoutOk') }))) {
        els.keepLines.checked = keepLines;
        return;
      }
      keepLines = els.keepLines.checked;
      resultText = null;
      resultEdited = false;
      drawResult();
    });
    els.images = h(
      'select',
      { class: 'field scan-res-images', 'aria-label': t('scanner.images.label') },
      ...['none', 'scans', 'photos'].map((v) => h('option', { value: v }, t(`scanner.images.${v}`))),
    );
    els.images.addEventListener('change', () => (imagesMode = els.images.value));
    els.report = h('pre', { class: 'scan-report' });
    els.save = h('button', { type: 'button', class: 'btn primary scan-save', onclick: saveToNote }, t('scanner.saveNote'));
    return h(
      'div',
      { class: 'scan-view scan-result', 'data-name': 'result' },
      h('header', { class: 'scan-top scan-top-solid' }, button('scan-round', t('scanner.back'), 'back', () => show('capture')), h('h2', { class: 'scan-title' }, t('scanner.resultTitle'))),
      h(
        'div',
        { class: 'scan-res-body' },
        els.resTitle,
        els.resNotes,
        els.resText,
        h(
          'div',
          { class: 'scan-res-options' },
          h('label', { class: 'scan-check' }, els.keepLines, h('span', {}, t('scanner.keepLines'))),
          h('label', { class: 'scan-select' }, h('span', {}, t('scanner.images.label')), els.images),
        ),
        h(
          'details',
          { class: 'scan-details' },
          h('summary', {}, t('scanner.details')),
          els.report,
          h(
            'div',
            { class: 'scan-details-actions' },
            h('button', { type: 'button', class: 'btn', onclick: copyReport }, t('scanner.copyReport')),
            engine.notice ? h('button', { type: 'button', class: 'btn', onclick: showLicenses }, t('scanner.licenses')) : null,
          ),
        ),
      ),
      h(
        'footer',
        { class: 'scan-res-actions' },
        h('button', { type: 'button', class: 'btn', onclick: copyText }, ico('copy'), h('span', {}, t('scanner.copy'))),
        h('button', { type: 'button', class: 'btn', onclick: saveTxt }, ico('file'), h('span', {}, 'TXT')),
        els.save,
      ),
    );
  }

  function drawResult() {
    const readable = pages.filter((p) => p.result?.items);
    if (resultText == null) {
      resultText = scanText(readable.map((p) => p.result), { keepLines });
      els.resText.value = resultText;
      resultEdited = false;
    }
    if (!els.resTitle.value) els.resTitle.value = defaultTitle(resultText);
    els.keepLines.checked = keepLines;
    els.images.value = imagesMode;
    // what the person should know before saving
    const notes = [];
    if (!engine.recognizes) notes.push(t('scanner.noOcr'));
    pages.forEach((p, i) => {
      if (p.status === 'failed' || (p.result && !p.result.ok && p.result.code !== 'unsupported')) notes.push(t('scanner.pageFailed', i + 1, t(`scanner.error.${p.result?.code ?? 'internal'}`)));
      else if (p.result?.ok && !p.result.items?.length) notes.push(t('scanner.pageEmpty', i + 1));
      else if (p.result?.ok && pageConfidence(p.result.items) < LOW_CONFIDENCE) notes.push(t('scanner.pageUnsure', i + 1));
    });
    els.resNotes.replaceChildren(...notes.map((n) => h('p', {}, n)));
    els.resNotes.hidden = !notes.length;
    els.report.textContent = report();
    if (!readable.length && engine.recognizes === false) els.images.value = imagesMode = 'scans';
  }

  function defaultTitle(text) {
    const first = (text ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
    if (first && first.length <= 60) return first;
    const day = new Intl.DateTimeFormat(currentLocale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date());
    return t('scanner.defaultTitle', day);
  }

  /** What each page took: for the person who measures speed and memory on a phone. */
  function report() {
    const lines = [`ATLAS ${typeof __VERSION__ === 'string' ? __VERSION__ : ''} · ${engine.info?.engine ?? engine.kind}`.trim()];
    if (engine.info?.abi) lines.push(`ABI ${engine.info.abi} · ${engine.info.cores ?? '?'} cores · memoryClass ${engine.info.memoryClass ?? '?'} MB`);
    pages.forEach((p, i) => {
      const r = p.result;
      if (!r) return lines.push(`#${i + 1}: —`);
      const tm = r.timings ?? {};
      const nat = r.native ?? {};
      const mem = r.memory ?? {};
      lines.push(
        `#${i + 1}: ${r.ok ? 'ok' : r.code} · ${r.width}×${r.height} · ${p.width}×${p.height} photo · rot ${r.rotation ?? 0}°${r.enhanced ? ' · enhanced' : ''} · ${r.items?.length ?? 0} lines · conf ${(pageConfidence(r.items) * 100).toFixed(0)}%`,
        `    ms: decode ${tm.decode ?? '-'} · flatten ${tm.flatten ?? '-'} · load ${tm.load ?? '-'} · recognize ${tm.recognize ?? '-'} (enhance ${nat.enhance ?? '-'}, detect ${nat.detect ?? '-'}, orient ${nat.orient ?? '-'}, lines ${nat.recognize ?? '-'}) · save ${tm.save ?? '-'} · total ${tm.total ?? '-'}`,
        mem.nativePeakMB != null ? `    MB: native ${mem.nativeBeforeMB} → peak ${mem.nativePeakMB} · java peak ${mem.javaPeakMB}` : '',
      );
    });
    return lines.filter(Boolean).join('\n');
  }

  async function showLicenses() {
    const text = await engine.notice().catch(() => '');
    if (!text) return;
    openDialog((box, done) => {
      box.append(
        h('h3', {}, t('scanner.licenses')),
        h('pre', { class: 'scan-licenses' }, text),
        h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => done(null) }, t('scanner.closeLicenses'))),
      );
    });
  }

  async function copyReport() {
    const ok = await copy(report()).catch(() => false);
    toast(ok === false ? t('scanner.copyFailed') : t('scanner.copied'));
  }

  async function copyText() {
    const ok = await copy(els.resText.value).catch(() => false);
    toast(ok === false ? t('scanner.copyFailed') : t('scanner.copied'));
  }

  function saveTxt() {
    const name = `${(els.resTitle.value.trim() || 'scan').replace(/[\\/:*?"<>|\n]+/g, ' ').slice(0, 80)}.txt`;
    download(name, els.resText.value.replace(/\n/g, '\r\n'), 'text/plain;charset=utf-8');
  }

  async function saveToNote() {
    els.save.disabled = true;
    try {
      const images = [];
      if (imagesMode !== 'none') {
        for (const [i, p] of pages.entries()) {
          let blob = null;
          if (imagesMode === 'photos') blob = p.blob ?? (await engine.original(p.id));
          if (!blob && p.result?.image) blob = await pageBlob(p.result);
          if (blob) images.push({ blob, alt: t('scanner.pageN', i + 1) });
        }
      }
      await saveNote({ title: els.resTitle.value.trim() || defaultTitle(''), text: els.resText.value, images, folder });
      await close({ force: true });
    } catch (err) {
      toast(t('scanner.saveFailed', err?.message ?? ''));
    } finally {
      if (els.save) els.save.disabled = false;
    }
  }

  return { open, isOpen, back, close };
}

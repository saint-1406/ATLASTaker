// The scanner's engines: what turns a photo and four corners into a flat page and its text.
//   android — the app's own (MainActivity → Scanner.java → libatlasocr.so): PaddleOCR v5 on ncnn,
//             fully on the phone. The photo goes over in base64 pieces; the answers come back through
//             window.__atlas.scan(event), which app.js hands to `dispatch` below.
//   page    — flattening in the page (geometry.js warp), no text: where the app has no recognizer.
// Both answer process() with { ok, image (URL), width, height, items, rotation, timings, memory, code };
// the page engine also with `blob`, the image itself (the page's CSP lets fetch read only its own
// address, not blob: URLs).

import { flatSize, warp } from './geometry.js';

const CHUNK = 384 * 1024; // bytes of the photo per call over the bridge (≈ 512 KB of base64)

const listeners = new Map(); // id → (event) => void

/** Events from the Android side (window.__atlas.scan). */
export function dispatch(event) {
  if (!event || typeof event.id !== 'string') return;
  listeners.get(event.id)?.(event);
}

function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The app's recognizer, or null where the app has none (a browser, the Windows app, an x86 phone). */
export function androidEngine(android) {
  if (!android || typeof android.scanInfo !== 'function') return null;
  let info;
  try {
    info = JSON.parse(android.scanInfo());
  } catch {
    return null;
  }
  if (!info?.ok) return null;
  const uploaded = new Set();

  return {
    kind: 'android',
    info,
    recognizes: true,

    /** Sends the photo once (a page adjusted again reuses it). */
    async upload(id, blob) {
      if (uploaded.has(id)) return;
      if (!android.scanBegin(id)) throw Object.assign(new Error('storage'), { code: 'storage' });
      for (let at = 0; at < blob.size; at += CHUNK) {
        const bytes = new Uint8Array(await blob.slice(at, at + CHUNK).arrayBuffer());
        if (!android.scanAppend(id, base64(bytes))) throw Object.assign(new Error('storage'), { code: 'storage' });
        await pause(); // the page stays responsive while a large photo goes over
      }
      uploaded.add(id);
    },

    /**
     * page: { id, blob, quad (fractions of the photo, [[x, y] × 4]), rotate }. onStage(stage): "upload",
     * "decode", "flatten", "load", "recognize". Resolves with the answer (never rejects on the
     * recognizer's own failures: they come as { ok: false, code }).
     */
    async process(page, { onStage, maxSide = 2400, autoRotate = true } = {}) {
      onStage?.('upload');
      await this.upload(page.id, page.blob);
      return new Promise((resolve) => {
        listeners.set(page.id, (event) => {
          if (!event.done) {
            onStage?.(event.stage);
            return;
          }
          listeners.delete(page.id);
          resolve(event);
        });
        android.scanProcess(page.id, JSON.stringify({ quad: page.quad, rotate: page.rotate ?? 0, maxSide, recognize: true, autoRotate }));
      });
    },

    cancel(id) {
      android.scanCancel(id);
    },

    /** The original photo as it was sent (for "keep the photos"). */
    async original(id) {
      const response = await fetch(`/scan/${id}.src`);
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const type = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : bytes[0] === 0x52 && bytes[1] === 0x49 ? 'image/webp' : 'image/jpeg';
      return new Blob([bytes], { type });
    },

    /** The licenses of the recognizer's parts, shipped in the APK (assets/ocr/NOTICE.txt). */
    async notice() {
      const response = await fetch('/assets/ocr/NOTICE.txt');
      return response.ok ? response.text() : '';
    },

    drop(id) {
      uploaded.delete(id);
      listeners.delete(id);
      android.scanDrop(id);
    },

    close() {
      uploaded.clear();
      listeners.clear();
      android.scanClose();
    },
  };
}

/**
 * Flattening in the page, without text: a stand-in where there is no recognizer. recognize (rgba,
 * width, height) → items may be given (tests, a future desktop recognizer).
 */
export function pageEngine({ recognize = null } = {}) {
  const urls = new Map();
  return {
    kind: 'page',
    info: { ok: true, engine: recognize ? 'page' : 'none' },
    recognizes: Boolean(recognize),

    async process(page, { onStage, maxSide = 2000 } = {}) {
      const t0 = performance.now();
      onStage?.('decode');
      const bitmap = await createImageBitmap(page.blob);
      try {
        const sw = bitmap.width;
        const sh = bitmap.height;
        const canvas = new OffscreenCanvas(sw, sh);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        const src = ctx.getImageData(0, 0, sw, sh).data;
        onStage?.('flatten');
        await pause();
        const quad = (page.quad ?? [[0, 0], [1, 0], [1, 1], [0, 1]]).map(([x, y]) => ({ x: x * sw, y: y * sh }));
        const { width, height } = flatSize(quad, maxSide);
        const flat = warp(src, sw, sh, quad, width, height);
        const turn = (((page.rotate ?? 0) % 360) + 360) % 360;
        const out = new OffscreenCanvas(turn % 180 ? height : width, turn % 180 ? width : height);
        const octx = out.getContext('2d');
        const tmp = new OffscreenCanvas(width, height);
        tmp.getContext('2d').putImageData(new ImageData(flat, width, height), 0, 0);
        octx.translate(out.width / 2, out.height / 2);
        octx.rotate((turn * Math.PI) / 180);
        octx.drawImage(tmp, -width / 2, -height / 2);
        let items = [];
        if (recognize) {
          onStage?.('recognize');
          await pause();
          items = await recognize(octx.getImageData(0, 0, out.width, out.height).data, out.width, out.height);
        }
        const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
        if (urls.has(page.id)) URL.revokeObjectURL(urls.get(page.id));
        const image = URL.createObjectURL(blob);
        urls.set(page.id, image);
        return {
          id: page.id,
          done: true,
          ok: Boolean(recognize),
          code: recognize ? undefined : 'unsupported',
          image,
          blob,
          width: out.width,
          height: out.height,
          items,
          rotation: 0,
          timings: { total: Math.round(performance.now() - t0) },
        };
      } finally {
        bitmap.close();
      }
    },

    cancel() {},
    async original() {
      return null;
    },
    drop(id) {
      if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
      urls.delete(id);
    },
    close() {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}

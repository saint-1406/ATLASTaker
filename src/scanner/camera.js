// The scanner's camera view: the back camera in a <video>, a photo at the camera's full size
// (ImageCapture), the torch where there is one, and the sheet's outline found a few times a second
// on a small copy of the picture (geometry.js findPage), so the frame follows the paper live.
// On Android the app grants the camera to its own page only (MainActivity.onPermissionRequest).

import { findPage, toGray } from './geometry.js';

/** Why there is no camera picture: 'denied', 'missing', 'busy' or 'unsupported'. */
function reason(err) {
  const name = err?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'unsupported';
}

/**
 * Starts the back camera in `video`. Resolves with { capture(), torch, stop() } or rejects with an
 * Error whose `code` says why (see reason()).
 */
export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
  } catch (err) {
    throw Object.assign(new Error(reason(err)), { code: reason(err) });
  }
  const [track] = stream.getVideoTracks();
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => {});

  const imageCapture = typeof window.ImageCapture === 'function' ? new window.ImageCapture(track) : null;
  const caps = track.getCapabilities?.() ?? {};
  let torchOn = false;

  /** A frame of the video as a JPEG: when the camera cannot take a still photo. */
  async function frame() {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) throw Object.assign(new Error('busy'), { code: 'busy' });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('busy'))), 'image/jpeg', 0.92));
  }

  return {
    async capture() {
      if (imageCapture) {
        try {
          const blob = await imageCapture.takePhoto(torchOn ? { fillLightMode: 'flash' } : {});
          if (blob?.size) return blob;
        } catch {
          // some cameras refuse still photos while streaming: the video frame will do
        }
      }
      return frame();
    },
    torch: {
      supported: Boolean(caps.torch),
      get on() {
        return torchOn;
      },
      async set(on) {
        if (!caps.torch) return false;
        try {
          await track.applyConstraints({ advanced: [{ torch: Boolean(on) }] });
          torchOn = Boolean(on);
        } catch {
          torchOn = false;
        }
        return torchOn;
      },
    },
    stop() {
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
    },
  };
}

/** A picture (an <img>, a <video>, an ImageBitmap) small and grey, for findPage. */
export function smallGray(source, sw, sh, maxSide = 240) {
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(8, Math.round(sw * k));
  const h = Math.max(8, Math.round(sh * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return { gray: toGray(ctx.getImageData(0, 0, w, h).data, w, h), w, h };
}

/** Where the sheet is in a picture, as fractions of it: { quad: [[x, y] × 4] | null, confidence }. */
export function findSheet(source, sw, sh, maxSide = 320) {
  const { gray, w, h } = smallGray(source, sw, sh, maxSide);
  const { quad, confidence } = findPage(gray, w, h);
  return { quad: quad ? quad.map((p) => [p.x / w, p.y / h]) : null, confidence };
}

/** Calls onSheet({ quad, confidence }) a few times a second while the video plays; returns stop(). */
export function watchSheet(video, onSheet, every = 280) {
  let timer = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    if (video.videoWidth && !document.hidden) {
      try {
        onSheet(findSheet(video, video.videoWidth, video.videoHeight, 200));
      } catch {
        // a frame not ready yet
      }
    }
    timer = setTimeout(tick, every);
  };
  timer = setTimeout(tick, every);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

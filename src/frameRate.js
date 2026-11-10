// How often the screen redraws while the app is in front, on Android: as fast as the screen can (90,
// 120, 144 Hz), or 60 Hz to spare the battery. Some phones hold an app at 60 Hz unless it asks for more
// (MainActivity.setFrameRate). Kept on this device only: another phone has another screen.

import { android } from './bridge.js';

const KEY = 'atlas.frameRate';
let high = true;
let fastest = 60;

try {
  high = localStorage.getItem(KEY) !== '60';
} catch {
  // only a convenience
}

const supported = () => typeof android?.setFrameRate === 'function';

function apply() {
  if (!supported()) return;
  try {
    fastest = Math.round(Number(android.setFrameRate(high))) || 60;
  } catch {
    // an older app without the call
  }
}

apply();

/** Whether there is a choice: the Android app, on a screen faster than 60 Hz. */
export const frameRateChoice = () => supported() && fastest > 61;
/** The fastest rate the screen has, in Hz. */
export const fastestFrameRate = () => fastest;
export const highFrameRate = () => high;

export function setHighFrameRate(on) {
  high = Boolean(on);
  try {
    if (high) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, '60');
  } catch {
    // only a convenience
  }
  apply();
}

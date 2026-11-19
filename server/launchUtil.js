// What the launcher (launch.js) and the portable app's keeper (keeper.js) both need: where a browser for
// the app's window is, and whether the ATLAS server answers on a port.

import fs from 'node:fs';
import path from 'node:path';

const BROWSERS = () =>
  [
    [process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    [process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    [process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'],
    [process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'],
    [process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'],
  ]
    .filter(([base]) => base)
    .map((parts) => path.join(...parts));

/** Edge or Chrome, for a window without the browser's bars; null where there is neither. */
export const browserPath = () => BROWSERS().find((file) => fs.existsSync(file)) ?? null;

/** The server's answer on a port ({ app, version, build, windows, quietMs }), or null. */
export async function hello(port, ms = 800) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(ms) });
    const body = await res.json();
    return body.app === 'atlas-notetaker' ? body : null;
  } catch {
    return null;
  }
}

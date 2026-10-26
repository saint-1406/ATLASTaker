// Desktop entry point (what the shortcut runs): make sure the ATLAS server is up, then open it in a
// chromeless Edge or Chrome window. The server shuts itself down a few minutes after the window closes.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD, defaultDataDir } from './server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BROWSERS = [
  [process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
  [process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
  [process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'],
  [process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'],
  [process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'],
]
  .filter(([base]) => base)
  .map((parts) => path.join(...parts));

async function hello(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(800) });
    const body = await res.json();
    return body.app === 'atlas-notetaker' ? body : null;
  } catch {
    return null;
  }
}

/** { port, pid, version } of the server that owns this data folder, or null. */
async function runningServer(dataDir) {
  try {
    const info = JSON.parse(await fsp.readFile(path.join(dataDir, 'server.json'), 'utf8'));
    if (!Number.isInteger(info.port)) return null;
    const answer = await hello(info.port);
    return answer ? { ...info, build: answer.build } : null;
  } catch {
    return null;
  }
}

function openWindow(url) {
  const browser = BROWSERS.find((file) => fs.existsSync(file));
  const child = browser
    ? spawn(browser, [`--app=${url}`, '--window-size=1400,900'], { detached: true, stdio: 'ignore' })
    : spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (err) => console.error('ATLAS: не удалось открыть окно:', err.message));
  child.unref();
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'app.js'))) {
    const build = spawnSync(process.execPath, [path.join(ROOT, 'build.mjs')], { cwd: ROOT, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('сборка интерфейса не удалась');
  }
  const dataDir = defaultDataDir();
  await fsp.mkdir(dataDir, { recursive: true });

  let server = await runningServer(dataDir);
  if (server && server.build !== BUILD) {
    // A server from before an update is still running (its code differs from the files on disk):
    // replace it, so page and server match. Writes are atomic, so stopping it mid-way loses nothing.
    try {
      process.kill(server.pid);
    } catch {
      // already gone
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await hello(server.port))) await sleep(150);
    server = null;
  }
  if (!server) {
    const log = fs.openSync(path.join(dataDir, 'server.log'), 'a');
    spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    }).unref();
    const deadline = Date.now() + 10_000;
    while (!server && Date.now() < deadline) {
      await sleep(150);
      server = await runningServer(dataDir);
    }
    if (!server) throw new Error(`сервер не ответил — подробности в ${path.join(dataDir, 'server.log')}`);
  }
  openWindow(`http://127.0.0.1:${server.port}/`);
}

main().catch((err) => {
  console.error('ATLAS:', err.message);
  process.exitCode = 1;
});

// Desktop entry point (what the shortcut runs): make sure the ATLAS server is up, then open it in a
// chromeless Edge or Chrome window. The server shuts itself down a few minutes after the window closes.
//
// --keeper (the portable app's start file): the hidden keeper (keeper.js) runs the server and the window
// instead, and brings the server back if it stops while the window is open.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserPath, hello, whenRunning } from './launchUtil.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KEEPER = process.argv.includes('--keeper');

/** { port, pid, keeper, version, build } of the server that owns this data folder, or null. */
async function runningServer(dataDir) {
  try {
    const info = JSON.parse(await fsp.readFile(path.join(dataDir, 'server.json'), 'utf8'));
    if (!Number.isInteger(info.port)) return null;
    const answer = await hello(info.port);
    return answer ? { ...info, build: answer.build, version: answer.version } : null;
  } catch {
    return null;
  }
}

/** A line in the server's log, marked "launch": which start replaced which server, or left it be. */
function note(dataDir, line) {
  try {
    fs.appendFileSync(path.join(dataDir, 'server.log'), `${new Date().toISOString()} launch: ${line}\n`);
  } catch {
    // nowhere to write: nothing to do about it
  }
}

function openWindow(url, dataDir) {
  const browser = browserPath();
  // under the keeper the window has the app's own profile, as the keeper opens it (keeper.js)
  const profile = KEEPER ? [`--user-data-dir=${path.join(dataDir, 'window')}`, '--no-first-run', '--no-default-browser-check'] : [];
  const child = browser
    ? spawn(browser, [`--app=${url}`, ...profile, '--window-size=1400,900'], { detached: true, stdio: 'ignore' })
    : spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (err) => console.error('ATLAS: не удалось открыть окно:', err.message));
  child.unref();
}

async function main() {
  // the server's code is loaded here, not as a static import: a file missing from an installation then
  // ends in the message below (with the window left open by the portable start file), not in silence
  const { BUILD, VERSION, defaultDataDir, isNewer } = await import('./server.js');
  if (!fs.existsSync(path.join(ROOT, 'dist', 'app.js'))) {
    const build = spawnSync(process.execPath, [path.join(ROOT, 'build.mjs')], { cwd: ROOT, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('сборка интерфейса не удалась');
  }
  const dataDir = defaultDataDir();
  await fsp.mkdir(dataDir, { recursive: true });

  let server = await runningServer(dataDir);
  if (server && server.build !== BUILD && whenRunning(server, { version: VERSION, build: BUILD }, isNewer) === 'open') {
    // A newer ATLAS (another installation, another portable folder) already runs on these notes: it
    // stays, and this start only opens a window to it. Before, an old shortcut ended the newer server
    // and its window lost the connection.
    note(dataDir, `ATLAS ${server.version} is already running, newer than this ${VERSION}: opening a window to it`);
  } else if (server && server.build !== BUILD) {
    // A server from before an update is still running (its code differs from the files on disk):
    // replace it, so page and server match. Writes are atomic, so stopping it mid-way loses nothing.
    // Its keeper goes first, or it would bring the old server straight back.
    note(dataDir, `replacing ATLAS ${server.version ?? '(version unknown)'} (pid ${server.pid}) with ${VERSION} from ${ROOT}`);
    for (const pid of [server.keeper, server.pid]) {
      if (!Number.isInteger(pid)) continue;
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await hello(server.port))) await sleep(150);
    server = null;
  }
  if (!server && KEEPER) {
    // the keeper starts the server and opens the window itself; this start file's work is done once it answers
    spawn(process.execPath, [path.join(ROOT, 'server', 'keeper.js')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    const deadline = Date.now() + 25_000;
    while (!server && Date.now() < deadline) {
      await sleep(200);
      server = await runningServer(dataDir);
    }
    if (!server) throw new Error(`сервер не ответил — подробности в ${path.join(dataDir, 'server.log')}`);
    return;
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
  openWindow(`http://127.0.0.1:${server.port}/`, dataDir);
}

main().catch((err) => {
  console.error(`\nATLAS Notetaker не запустился / did not start:\n  ${err.message}\n`);
  console.error('Журнал сервера / server log: %APPDATA%\\ATLAS Notetaker\\server.log');
  process.exitCode = 1;
});

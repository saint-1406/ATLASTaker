// The portable app's keeper: a hidden process that lives as long as the app's window does. It starts the
// server, opens the window in a browser profile of the app's own (so the browser process that holds the
// window is the one it started, and its end means the window is closed), and brings the server straight
// back — on the same port, with the same token — if it ever stops while the window is open. The window
// then reconnects by itself (src/app.js, reconnect) and nothing typed is lost.
//
// Before: the server ended itself after ten minutes without word from the window, and a window the
// browser put to sleep or unloaded found "Connection to ATLAS lost" when the person came back.
//
//   node server/keeper.js        (server/launch.js --keeper starts it, hidden and detached)
//
// Its log goes into <data>/server.log, next to the server's, every line marked "keeper".

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserPath, hello } from './launchUtil.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The keeper's rules, with what a test changes. */
export const RULES = {
  health: 15_000, // how often the server is asked whether it answers
  unwell: 3, // that many unanswered questions in a row: the server hangs, it is replaced
  restarts: 8, // at most this many restarts…
  restartWindow: 10 * 60_000, // …in this long; past that something is badly wrong and the keeper stops trying
  linger: 30_000, // the window's browser has ended: the server stays this long for any window still holding a line
  quietWithoutBrowser: 10 * 60_000, // no browser of its own to watch: ten minutes with no window, as before
};

/**
 * dataDir: the app's data folder. browser(url, profile) → the child process that holds the window (or
 * null where there is no browser of the app's own: the system's opens it); a test hands in its own.
 */
export function createKeeper({ dataDir, root = ROOT, nodePath = process.execPath, log = () => {}, openWindow = true, rules = RULES, browser: launchBrowser = defaultBrowser, port: firstPort = null }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const infoFile = path.join(dataDir, 'server.json');
  let server = null; // the child process
  let port = null; // once the server has one, every restart takes it again
  let browser = null;
  let browserGone = false;
  let stopping = false;
  let restarts = [];
  let healthTimer = null;
  let unwell = 0;
  let lingerSince = 0;
  let done;
  const finished = new Promise((resolve) => (done = resolve));

  function startServer() {
    const args = [path.join(root, 'server', 'server.js'), '--kept', '--no-idle-exit', '--data', dataDir];
    const wanted = port ?? firstPort; // a test asks for 0: any free port
    if (wanted !== null) args.push('--port', String(wanted));
    const out = fs.openSync(path.join(dataDir, 'server.log'), 'a');
    const child = spawn(nodePath, args, { cwd: root, stdio: ['ignore', out, out], windowsHide: true, env: { ...process.env, ATLAS_TOKEN: token } });
    fs.closeSync(out);
    child.on('exit', (code, signal) => {
      if (server !== child) return;
      server = null;
      if (stopping) return;
      log(`server stopped by itself (code ${code}, signal ${signal ?? '-'})`);
      restart();
    });
    child.on('error', (err) => log(`server did not start: ${err.message}`));
    server = child;
    return child;
  }

  /** The server answers on its port, from this process: { port } once it does, or null. */
  async function waitForServer(child, ms = 15_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && server === child) {
      try {
        const info = JSON.parse(await fsp.readFile(infoFile, 'utf8'));
        if (info.pid === child.pid && (await hello(info.port))) return info;
      } catch {
        // not written yet
      }
      await sleep(150);
    }
    return null;
  }

  async function restart() {
    const now = Date.now();
    restarts = restarts.filter((at) => now - at < rules.restartWindow);
    if (restarts.length >= rules.restarts) {
      log(`server stopped ${restarts.length} times in ${Math.round(rules.restartWindow / 60_000)} minutes: giving up`);
      return stop();
    }
    restarts.push(now);
    await sleep(restarts.length > 2 ? 2000 : 300);
    if (stopping) return;
    const child = startServer();
    const info = await waitForServer(child);
    if (info) log(`server back on port ${info.port}`);
    else log('server did not come back in time');
  }

  async function checkHealth() {
    if (stopping || !server || !port) return;
    const answer = await hello(port, 3000);
    if (answer) {
      unwell = 0;
      // the window's browser is gone: once no window holds a line for a while, the server goes too
      if (browserGone || !browser) {
        const quietEnough = browser ? answer.windows === 0 : answer.windows === 0 && answer.quietMs > rules.quietWithoutBrowser;
        if (!quietEnough) lingerSince = 0;
        else if (!lingerSince) lingerSince = Date.now();
        else if (Date.now() - lingerSince > (browser ? rules.linger : 0)) {
          log(browser ? 'window closed: stopping' : 'no window for 10 minutes: stopping');
          return stop();
        }
      }
      return;
    }
    unwell += 1;
    if (unwell >= rules.unwell) {
      log(`server did not answer ${unwell} times: replacing it`);
      unwell = 0;
      const stuck = server;
      server = null;
      try {
        stuck.kill();
      } catch {
        // already gone
      }
      restart();
    }
  }

  function startBrowser(url) {
    const child = launchBrowser(url, path.join(dataDir, 'window'));
    if (!child) return null;
    const started = Date.now();
    child.on('exit', () => {
      // a browser that ended at once handed the window to one already open with this profile: that one
      // is not ours to watch, so the windows' lines decide
      if (Date.now() - started < 5000) {
        log('the window went to a browser already open: watching the windows instead');
        browser = null;
        return;
      }
      log('window closed');
      browserGone = true;
      checkHealth();
    });
    child.on('error', (err) => log(`the window did not open: ${err.message}`));
    return child;
  }

  async function start() {
    log(`starting (${path.basename(nodePath)}, data in ${dataDir})`);
    const child = startServer();
    const info = await waitForServer(child, 20_000);
    if (!info) {
      log('server did not start');
      await stop();
      throw new Error(`сервер не ответил — подробности в ${path.join(dataDir, 'server.log')}`);
    }
    port = info.port;
    log(`server on port ${port}`);
    if (openWindow) browser = startBrowser(`http://127.0.0.1:${port}/`);
    healthTimer = setInterval(checkHealth, rules.health);
    return { port, token };
  }

  async function stop() {
    if (stopping) return finished;
    stopping = true;
    clearInterval(healthTimer);
    const child = server;
    server = null;
    if (child && child.exitCode === null) {
      // asked first, so it finishes what it was writing and clears its files; ended if it does not go
      const gone = new Promise((resolve) => child.once('exit', resolve));
      try {
        await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST', headers: { 'X-Atlas-Token': token }, signal: AbortSignal.timeout(2000) });
      } catch {
        // no answer: it is ended below
      }
      if ((await Promise.race([gone.then(() => true), sleep(5000).then(() => false)])) === false) {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }
    }
    log('stopped');
    done();
    return finished;
  }

  return {
    start,
    stop,
    finished,
    get port() {
      return port;
    },
    get serverPid() {
      return server?.pid ?? null;
    },
    /** Opens one more window (another start of the app while this keeper runs). */
    openWindow: (url) => startBrowser(url),
    checkHealth,
  };
}

/** Edge or Chrome with the app's own profile; without either, the system's browser (and null). */
function defaultBrowser(url, profile) {
  const file = browserPath();
  if (!file) {
    spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return null;
  }
  return spawn(file, [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1400,900'], {
    detached: true,
    stdio: 'ignore',
  });
}

async function main() {
  const { defaultDataDir } = await import('./server.js');
  const dataDir = defaultDataDir();
  await fsp.mkdir(dataDir, { recursive: true });
  const logFile = path.join(dataDir, 'server.log');
  const log = (line) => {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} keeper: ${line}\n`);
    } catch {
      // nowhere to write: nothing to do about it
    }
  };
  process.on('uncaughtException', (err) => log(`uncaught: ${err?.stack ?? err}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack ?? err}`));
  const keeper = createKeeper({ dataDir, log });
  const stop = () => keeper.stop().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await keeper.start();
  await keeper.finished;
  process.exit(0);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
  main().catch(() => process.exit(1));
}

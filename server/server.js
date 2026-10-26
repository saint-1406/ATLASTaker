// ATLAS local server: serves the UI and keeps notes as .md files under %APPDATA%\ATLAS Notetaker.
// It binds to 127.0.0.1 only, checks the Host header (no DNS rebinding) and answers API calls only
// when they carry this run's token — which is embedded in index.html and readable by our page alone.
//
//   node server/server.js [--port 47813] [--data <folder>] [--no-idle-exit]

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const DEFAULT_PORT = 47813;
const MAX_BODY = 20 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function defaultDataDir() {
  if (process.env.ATLAS_DATA_DIR) return path.resolve(process.env.ATLAS_DATA_DIR);
  return path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'ATLAS Notetaker');
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    ...extra,
  };
  if (status === 204 || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const payload = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { ...headers, 'Content-Type': type, 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'expected JSON');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    throw new HttpError(400, 'bad JSON');
  }
}

function openFolder(dir) {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

export async function createAtlasServer({ dataDir = defaultDataDir(), port = DEFAULT_PORT, portTries = 20, idleExitMs = 0, onIdle } = {}) {
  const notesDir = path.join(dataDir, 'notes');
  const store = createStore(notesDir);
  const token = crypto.randomBytes(24).toString('base64url');
  const tokenBytes = Buffer.from(token);
  const distDir = path.join(ROOT, 'dist') + path.sep;
  const fixedAssets = {
    '/assets/icon.png': path.join(ROOT, 'assets', 'icon.png'),
    '/favicon.ico': path.join(ROOT, 'assets', 'icon.ico'),
  };
  let actualPort = 0;
  let lastSeen = Date.now();

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'bad path');
    }
    if (rel === '/' || rel === '/index.html') {
      const html = await fsp.readFile(path.join(ROOT, 'index.html'), 'utf8');
      send(res, 200, html.replace('__ATLAS_TOKEN__', token), MIME['.html']);
      return;
    }
    let file = fixedAssets[rel];
    if (!file && rel.startsWith('/dist/')) {
      const candidate = path.resolve(ROOT, `.${rel}`);
      if (candidate.startsWith(distDir)) file = candidate;
    }
    if (!file) throw new HttpError(404, 'not found');
    let data;
    try {
      data = await fsp.readFile(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    const hashed = rel.startsWith('/dist/assets/');
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', {
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  }

  async function handleApi(req, res, url) {
    const route = url.pathname.slice('/api/'.length);
    if (route === 'hello' && req.method === 'GET') {
      send(res, 200, { app: 'atlas-notetaker', version: VERSION });
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${actualPort}` && origin !== `http://localhost:${actualPort}`) {
      throw new HttpError(403, 'foreign origin');
    }
    const given = Buffer.from(String(req.headers['x-atlas-token'] ?? ''));
    if (given.length !== tokenBytes.length || !crypto.timingSafeEqual(given, tokenBytes)) throw new HttpError(403, 'bad token');
    lastSeen = Date.now();

    const notesRoute = /^notes(?:\/([^/]+)(?:\/(meta|trash))?)?$/.exec(route);
    if (notesRoute) {
      const [, id, action] = notesRoute;
      if (!id && req.method === 'GET') return send(res, 200, await store.list());
      if (!id && req.method === 'POST') return send(res, 201, await store.create((await readJson(req)).content ?? ''));
      if (id && !action && req.method === 'PUT') return send(res, 200, await store.write(id, (await readJson(req)).content));
      if (id && action === 'meta' && req.method === 'PATCH') {
        await store.setMeta(id, await readJson(req));
        return send(res, 204);
      }
      if (id && action === 'trash' && req.method === 'POST') {
        await store.trash(id);
        return send(res, 204);
      }
      throw new HttpError(405, 'method not allowed');
    }
    if (route === 'state') {
      if (req.method === 'GET') return send(res, 200, store.getState());
      if (req.method === 'PATCH') return send(res, 200, store.setState(await readJson(req)));
      throw new HttpError(405, 'method not allowed');
    }
    if (route === 'flush' && req.method === 'POST') {
      // The page's last words as the window closes: text and cursor in one request.
      const { id, content, meta } = await readJson(req);
      if (typeof content === 'string') await store.write(id, content);
      if (meta) await store.setMeta(id, meta);
      await store.idle();
      store.flush();
      return send(res, 204);
    }
    if (route === 'ping' && req.method === 'POST') return send(res, 204);
    if (route === 'open-folder' && req.method === 'POST') {
      openFolder(notesDir);
      return send(res, 204);
    }
    throw new HttpError(404, 'not found');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) throw new HttpError(421, 'unexpected host');
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await serveStatic(req, res, url);
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) console.error(new Date().toISOString(), err);
      if (res.headersSent) res.end();
      else send(res, status, { error: status >= 500 ? 'internal error' : err.message });
    }
  });

  for (let i = 0; i < Math.max(1, portTries) && !actualPort; i++) {
    const candidate = port === 0 ? 0 : port + i;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(candidate, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      actualPort = server.address().port;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || i === portTries - 1) throw err;
    }
  }

  let idleTimer = null;
  if (idleExitMs > 0) {
    const every = Math.min(5000, idleExitMs / 4);
    let lastTick = Date.now();
    idleTimer = setInterval(() => {
      const now = Date.now();
      // A long gap between ticks means the machine slept. The window slept too and hasn't had a
      // chance to ping yet, so it gets a fresh grace period instead of losing its server.
      if (now - lastTick > every * 3) lastSeen = now;
      lastTick = now;
      if (now - lastSeen > idleExitMs) {
        clearInterval(idleTimer);
        onIdle?.();
      }
    }, every);
  }

  async function close() {
    clearInterval(idleTimer);
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await closed;
    await store.idle();
    store.flush();
  }

  return { server, store, token, notesDir, port: actualPort, url: `http://127.0.0.1:${actualPort}/`, close };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * One server per notes folder: two of them would each think they own the files. The lock names its
 * holder; a lock whose process is gone (or that is old and whose server doesn't answer) is stale.
 */
export async function acquireLock(file, answers = async () => false) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let holder = {};
    try {
      holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // half-written or unreadable lock: treat as stale
    }
    const starting = Date.now() - (holder.at ?? 0) < 30_000;
    if (holder.pid && pidAlive(holder.pid) && (starting || (await answers()))) {
      throw Object.assign(new Error('ATLAS уже запущен для этой папки'), { code: 'ATLAS_RUNNING' });
    }
    fs.rmSync(file, { force: true });
  }
  throw new Error(`не удалось занять ${file}`);
}

function parseArgs(argv) {
  const args = { port: undefined, data: undefined, idleExit: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--data') args.data = argv[++i];
    else if (argv[i] === '--no-idle-exit') args.idleExit = false;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.data ? path.resolve(args.data) : defaultDataDir();
  await fsp.mkdir(dataDir, { recursive: true });
  const infoFile = path.join(dataDir, 'server.json');
  const answers = async () => {
    try {
      const { port } = JSON.parse(await fsp.readFile(infoFile, 'utf8'));
      const res = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(800) });
      return (await res.json()).app === 'atlas-notetaker';
    } catch {
      return false;
    }
  };
  let releaseLock;
  try {
    releaseLock = await acquireLock(path.join(dataDir, 'server.lock'), answers);
  } catch (err) {
    if (err.code !== 'ATLAS_RUNNING') throw err;
    console.log(`${new Date().toISOString()} ${err.message} — этот запуск не нужен`);
    return;
  }
  process.on('exit', () => releaseLock());

  let app = null;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await app?.close();
      const info = JSON.parse(await fsp.readFile(infoFile, 'utf8').catch(() => '{}'));
      if (info.pid === process.pid) await fsp.rm(infoFile, { force: true });
    } catch (err) {
      console.error(err);
    }
    process.exit(0);
  };

  app = await createAtlasServer({
    dataDir,
    port: Number.isInteger(args.port) ? args.port : DEFAULT_PORT,
    portTries: Number.isInteger(args.port) ? 1 : 20,
    // the window pings every 20 s (throttled to about once a minute when hidden);
    // three minutes of silence means it was closed
    idleExitMs: args.idleExit ? 180_000 : 0,
    onIdle: shutdown,
  });
  await fsp.writeFile(infoFile, JSON.stringify({ port: app.port, pid: process.pid, startedAt: Date.now() }));
  console.log(`${new Date().toISOString()} ATLAS: ${app.url} · заметки в ${app.notesDir}`);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
  main().catch((err) => {
    console.error('ATLAS не запустился:', err);
    process.exit(1);
  });
}

// Sync on Windows: signing in with Google and running sync rounds (src/sync/engine.js) against the
// notes and library on disk. Sign-in happens in the system browser: Google sends it back to this
// server (http://127.0.0.1:<port>/oauth/callback), with PKCE. What is kept, in <data>/sync:
//   account.json  { email, refreshToken }  — the key to the app's folder on Drive, nothing else
//   base.json     what both sides had after the last round, and when that was
// Google wants a "client secret" even from a desktop app (it is not secret there, every copy of the
// app carries it). It is not in git: CI writes server/google-client.json; for a local run it can sit
// in %APPDATA%\ATLAS Notetaker\google-client.json or ATLAS_GOOGLE_CLIENT_SECRET.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from './store.js';
import { createDrive } from '../src/sync/drive.js';
import { emptyBase, syncOnce } from '../src/sync/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT_ID = '276842939452-j5549p5rm3v4shg9tckhcs6u5jkkvlbt.apps.googleusercontent.com';
// drive.file: the files this app made on the person's Drive (and only those) — Apocrypha shares them
export const SHARE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SCOPES = `openid email https://www.googleapis.com/auth/drive.appdata ${SHARE_SCOPE}`;
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SIGN_IN_TIMEOUT = 10 * 60 * 1000;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** The desktop client's secret, wherever this copy of the app has it; '' when none. */
export function clientSecret() {
  if (process.env.ATLAS_GOOGLE_CLIENT_SECRET) return process.env.ATLAS_GOOGLE_CLIENT_SECRET.trim();
  const appData = process.env.APPDATA ? path.join(process.env.APPDATA, 'ATLAS Notetaker', 'google-client.json') : null;
  for (const file of [path.join(HERE, 'google-client.json'), appData].filter(Boolean)) {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      // as Google's console downloads it ({ installed: { … } }) or just { client_secret }
      const secret = json?.installed?.client_secret ?? json?.client_secret;
      if (typeof secret === 'string' && secret) return secret;
    } catch {
      // not there or not readable: the next place
    }
  }
  return '';
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

/** The email inside an ID token. It came straight from Google over TLS, so it is read, not verified. */
function emailOf(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email ?? '';
  } catch {
    return '';
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// ---------- the notes and library on disk, as the engine sees them ----------

function diskSide(store, library) {
  const hashes = new Map(); // "<id> <size> <mtime>" → hash: a book is read once per change
  return {
    notes: () => store.list(),
    putNote: ({ id, content, created, updated }) => store.putSynced(id, content, { created, updated }),
    createNote: (content) => store.create(content),
    trashNote: (id) => store.trash(id),
    setNoteFolder: (id, folder) => store.setMeta(id, { folder }),
    setNoteTrashed: (id, trashed) => store.setMeta(id, { trashed }),
    settings: async () => store.settings(),
    putSettings: async (entries) => store.putSettings(entries),
    docs: async () => library.list(),
    async fileHash(doc) {
      const file = library.file(doc.id);
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat) return { hash: '', time: 0 };
      const key = `${doc.id} ${stat.size} ${stat.mtimeMs}`;
      if (!hashes.has(key)) {
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
        hashes.set(key, hash.digest('hex').slice(0, 32));
      }
      return { hash: hashes.get(key), time: Math.round(stat.mtimeMs) };
    },
    docBytes: async (id) => new Uint8Array(await fsp.readFile(library.file(id))),
    putDoc: (id, data, bytes) => library.putSynced(id, data, bytes ? Buffer.from(bytes) : null),
    removeDoc: (id) => library.remove(id),
    assets: () => store.assetNames(),
    assetBytes: async (name) => new Uint8Array(await fsp.readFile(store.assetFile(name))),
    putAsset: (name, bytes) => store.putAsset(name, Buffer.from(bytes)),
  };
}

// ---------- the account and the rounds ----------

export function createSync({ dataDir, store, library, fetchImpl = (...args) => fetch(...args) }) {
  const dir = path.join(dataDir, 'sync');
  const accountFile = path.join(dir, 'account.json');
  const baseFile = path.join(dir, 'base.json');
  let account = readJson(accountFile); // { email, refreshToken }
  let saved = readJson(baseFile) ?? {}; // { base, lastSync, email }
  let access = null; // { token, until }
  let pending = null; // a sign-in waiting for Google to send the browser back
  let running = null;
  let lastError = '';
  let needsLogin = false; // Google no longer takes the refresh token (7 days in testing mode, or revoked)
  const local = diskSide(store, library);

  async function writeJson(file, value) {
    await fsp.mkdir(dir, { recursive: true });
    await atomicWrite(file, JSON.stringify(value, null, 1));
  }

  async function tokenRequest(params) {
    let res;
    try {
      res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: clientSecret(), ...params }),
      });
    } catch (err) {
      throw Object.assign(new Error(`Google: ${err.message}`), { offline: true });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`Google: ${body.error_description || body.error || res.status}`), { code: body.error, status: res.status });
    return body;
  }

  async function getToken(force = false) {
    if (!account?.refreshToken) throw Object.assign(new Error('not signed in'), { auth: true });
    if (!force && access && access.until > Date.now() + 60_000) return access.token;
    try {
      const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refreshToken });
      access = { token: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000, scope: body.scope ?? '' };
      needsLogin = false;
      return access.token;
    } catch (err) {
      if (err.code === 'invalid_grant') {
        needsLogin = true;
        err.auth = true;
      }
      throw err;
    }
  }

  const drive = createDrive({ getToken, fetchImpl });

  function status() {
    return {
      available: Boolean(clientSecret()),
      signedIn: Boolean(account?.refreshToken),
      email: account?.email ?? '',
      lastSync: saved.lastSync ?? 0,
      running: Boolean(running),
      signingIn: Boolean(pending),
      needsLogin,
      error: lastError,
    };
  }

  /** Starts a sign-in: the system browser opens Google's page. Returns the address too. */
  function signIn(port) {
    if (!clientSecret()) throw httpError(503, 'no client secret');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    const redirect = `http://127.0.0.1:${port}/oauth/callback`;
    pending = { verifier, state, redirect, until: Date.now() + SIGN_IN_TIMEOUT };
    const url = `${AUTH_URL}?${new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirect,
      response_type: 'code',
      scope: SCOPES,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent', // so Google hands out a refresh token every time
      ...(account?.email ? { login_hint: account.email } : {}),
    })}`;
    openBrowser(url);
    return { url };
  }

  /** Google sent the browser back. Returns the words for the page the browser shows. */
  async function callback(url) {
    const p = pending;
    if (!p || p.until < Date.now() || url.searchParams.get('state') !== p.state) return { ok: false, reason: 'stale' };
    pending = null;
    const code = url.searchParams.get('code');
    if (!code) return { ok: false, reason: url.searchParams.get('error') || 'denied' };
    try {
      const body = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: p.redirect });
      const email = emailOf(body.id_token);
      if (!body.refresh_token) throw new Error('Google gave no refresh token');
      if (saved.email && saved.email !== email) saved = {}; // another account: start from nothing
      account = { email, refreshToken: body.refresh_token };
      access = { token: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000, scope: body.scope ?? '' };
      needsLogin = false;
      lastError = '';
      await writeJson(accountFile, account);
      return { ok: true, email };
    } catch (err) {
      lastError = err.message;
      return { ok: false, reason: err.message };
    }
  }

  function cancelSignIn() {
    pending = null;
  }

  async function signOut() {
    const token = account?.refreshToken;
    account = null;
    access = null;
    needsLogin = false;
    lastError = '';
    await fsp.rm(accountFile, { force: true });
    // the base stays: signing in again with the same account goes on from where it stopped
    if (token) fetchImpl(`${REVOKE_URL}?${new URLSearchParams({ token })}`, { method: 'POST' }).catch(() => {});
  }

  /** One round; a second call while one runs gets the same round. */
  function run({ skipDocs = [] } = {}) {
    if (!account?.refreshToken) return Promise.reject(httpError(409, 'not signed in'));
    running ??= (async () => {
      try {
        const result = await syncOnce({ local, drive, base: saved.base ?? emptyBase(), skipDocs });
        saved = { base: result.base, lastSync: Date.now(), email: account?.email ?? '' };
        await writeJson(baseFile, saved);
        lastError = '';
        const { base, ...summary } = result;
        return { ...summary, lastSync: saved.lastSync };
      } catch (err) {
        lastError = err.message;
        throw Object.assign(err, { status: err.auth ? 401 : err.offline ? 503 : 502 });
      } finally {
        running = null;
      }
    })();
    return running;
  }

  /**
   * An access token for the page (Apocrypha talks to Drive and to its catalogue itself). An account
   * signed in before drive.file was asked for has to sign in once more: 409 needs-consent.
   */
  async function accessToken({ force = false } = {}) {
    if (!account?.refreshToken) throw httpError(409, 'not signed in');
    let token;
    try {
      token = await getToken(force);
    } catch (err) {
      throw Object.assign(err, { status: err.auth ? 401 : err.offline ? 503 : 502 });
    }
    if (access?.scope && !access.scope.split(' ').includes(SHARE_SCOPE)) throw httpError(409, 'needs-consent');
    return { token, until: access?.until ?? 0 };
  }

  return { status, signIn, callback, cancelSignIn, signOut, run, accessToken };
}

/** The page the browser shows after Google, in both languages (the page has no idea which one is set). */
export function callbackPage({ ok, email, reason }) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const head = ok ? 'Готово · Done' : 'Не получилось · Did not work';
  const text = ok
    ? `Вы вошли как <b>${esc(email)}</b>. Можно закрыть эту вкладку и вернуться в ATLAS Notetaker.<br>Signed in as <b>${esc(email)}</b>. You can close this tab and go back to ATLAS Notetaker.`
    : `Вход не завершён (${esc(reason)}). Попробуйте ещё раз из настроек ATLAS.<br>Sign-in did not finish (${esc(reason)}). Try again from ATLAS settings.`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>ATLAS Notetaker</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:36em;margin:15vh auto;padding:0 1em;color:#222;background:#f6f3ec}h1{font-weight:600}</style></head><body><h1>${head}</h1><p>${text}</p></body></html>`;
}

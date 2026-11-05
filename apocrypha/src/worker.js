// Apocrypha: the catalogue of books and documents that ATLAS users share with each other.
// A Cloudflare Worker over a D1 database (schema.sql). The files stay on the Google Drive of whoever
// shared them, open to anyone with the link; this keeps the list, finds things in it and hands the
// files out (it fetches them from Drive with an API key, so the app needs no key of its own).
//
// Adding to the list takes the person's Google access token: Google says whose it is and that it was
// given to ATLAS, Drive says the file is theirs, the size and SHA-256 match, it is open to anyone, and
// its first bytes are what the format says. No email is kept: the owner is Drive's permissionId.
//
//   GET    /v1/files?q=&lang=&kind=&format=&sort=new|popular&page=   the list, 24 to a page
//   GET    /v1/files/:id                     one file
//   GET    /v1/files/:id/cover               its picture
//   GET    /v1/files/:id/download            the file itself
//   GET    /v1/lookup?sha256=                the file with these bytes, if listed
//   GET    /v1/langs                         the languages in the list, most files first
//   POST   /v1/files                  🔑     share a file
//   DELETE /v1/files/:id              🔑     take it back (its owner, or the app's owner)
//   POST   /v1/files/:id/report              complain about it
//   GET    /v1/mine                   🔑     what this person shared; { admin } for the app's owner
//   GET    /v1/admin/reports          🔑👑   complaints and hidden files
//   POST   /v1/admin/files/:id        🔑👑   { hidden: true | false }
//
// Settings (wrangler.toml [vars] and secrets): GOOGLE_API_KEY (secret, Drive API only),
// GOOGLE_CLIENT_IDS (ATLAS's OAuth clients, comma-separated), ADMIN_EMAIL, IP_SALT (secret).

export const FORMATS = ['pdf', 'epub', 'fb2', 'docx', 'odt', 'rtf', 'cbz', 'txt', 'md', 'html'];
export const KINDS = ['book', 'document', 'comic'];
export const REASONS = ['rights', 'illegal', 'broken', 'spam', 'other'];
export const MAX_SIZE = 50 * 1024 * 1024;
export const PAGE = 24;
const MAX_COVER = 120_000;
const PER_DAY = 30; // files one person may share in a day

const DRIVE = 'https://www.googleapis.com/drive/v3';
const TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo';

// [requests, seconds] per address
export const LIMITS = {
  search: [300, 300],
  publish: [12, 3600],
  remove: [60, 3600],
  report: [20, 3600],
  download: [120, 3600],
  account: [240, 3600],
};

class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Expose-Headers': 'X-Apocrypha-Sha256, Content-Length',
  'Access-Control-Max-Age': '86400',
};

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...headers } });

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function hash(...parts) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\u0000'))));
}

/** What the search looks through: lower case, ё as е, runs of anything else as one space. */
export function searchText(...parts) {
  return parts
    .join(' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const newId = () => {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => abc[b % abc.length]).join('');
};

/** Do the first bytes look like this format? (The device checked the whole file; this is a second look.) */
export function looksLike(format, head) {
  const start = String.fromCharCode(...head.subarray(0, 8));
  const zip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  const binary = head.subarray(0, 1024).includes(0);
  switch (format) {
    case 'pdf':
      return start.startsWith('%PDF');
    case 'epub':
    case 'docx':
    case 'odt':
    case 'cbz':
      return zip;
    case 'rtf':
      return start.startsWith('{\\rtf');
    case 'fb2':
      return zip || !binary;
    default:
      // txt, md, html: text; UTF-16 has zeros, so a byte-order mark lets it through
      return !binary || (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
  }
}

// ---------- the rows as the app sees them ----------

export function publicItem(row) {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    lang: row.lang,
    kind: row.kind,
    format: row.format,
    size: row.size,
    sha256: row.sha256,
    description: row.description,
    created: row.created,
    downloads: row.downloads,
    cover: Boolean(row.cover),
  };
}
const ownItem = (row) => ({ ...publicItem(row), driveId: row.drive_id, hidden: row.hidden, reports: row.reports });

const COLUMNS = 'id, drive_id, sha256, size, format, title, author, lang, kind, description, cover IS NOT NULL AS cover, owner, created, downloads, reports, hidden';

// ---------- checks on what comes in ----------

const text = (value, max, { required = false } = {}) => {
  const out = typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim() : '';
  if (out.length > max || (required && !out)) throw new HttpError(400, 'bad-request', { field: required && !out ? 'missing' : 'long' });
  return out;
};

function readShare(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'bad-request');
  const driveId = text(body.driveId, 200, { required: true });
  if (!/^[\w-]{10,200}$/.test(driveId)) throw new HttpError(400, 'bad-request');
  const sha256 = text(body.sha256, 64, { required: true }).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new HttpError(400, 'bad-request');
  const size = Number(body.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'bad-request');
  if (size > MAX_SIZE) throw new HttpError(413, 'too-big');
  if (!FORMATS.includes(body.format)) throw new HttpError(400, 'bad-format');
  if (!KINDS.includes(body.kind)) throw new HttpError(400, 'bad-request');
  const lang = typeof body.lang === 'string' && /^([a-z]{2,3}|und)$/.test(body.lang) ? body.lang : 'und';
  const cover = body.cover == null || body.cover === '' ? null : String(body.cover);
  if (cover && (cover.length > MAX_COVER || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(cover))) throw new HttpError(400, 'bad-request', { field: 'cover' });
  return {
    driveId,
    sha256,
    size,
    format: body.format,
    kind: body.kind,
    lang,
    title: text(body.title, 300, { required: true }),
    author: text(body.author, 300),
    description: text(body.description, 2000),
    cover,
  };
}

async function readJson(request, limit = 300_000) {
  if (!String(request.headers.get('content-type') ?? '').startsWith('application/json')) throw new HttpError(415, 'bad-request');
  const raw = await request.text();
  if (raw.length > limit) throw new HttpError(413, 'bad-request');
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'bad-request');
  }
}

// ---------- the handler ----------

/** `fetchImpl` and `now` are for the tests. */
export async function handle(request, env, { fetchImpl = (...args) => fetch(...args), now = Date.now() } = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const db = env.DB;
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  const salt = env.IP_SALT || 'apocrypha';

  async function limit(bucket) {
    const [max, span] = LIMITS[bucket];
    const window = Math.floor(now / 1000 / span) * span;
    const key = `${bucket}:${(await hash(salt, ip)).slice(0, 24)}`;
    const row = await db
      .prepare('INSERT INTO hits (key, window, n) VALUES (?, ?, 1) ON CONFLICT (key, window) DO UPDATE SET n = n + 1 RETURNING n')
      .bind(key, window)
      .first();
    // now and then, the old windows go
    if (Math.random() < 0.02) await db.prepare('DELETE FROM hits WHERE window < ?').bind(Math.floor(now / 1000) - 2 * 86400).run();
    if (row && row.n > max) throw new HttpError(429, 'rate');
  }

  const key = () => {
    if (!env.GOOGLE_API_KEY) throw new HttpError(503, 'unconfigured');
    return encodeURIComponent(env.GOOGLE_API_KEY);
  };

  /** Whose token this is: { token, owner, admin }. */
  async function who() {
    const m = /^Bearer\s+([\w.~+/=-]{10,4096})$/.exec(request.headers.get('authorization') ?? '');
    if (!m) throw new HttpError(401, 'auth');
    await limit('account');
    const token = m[1];
    const info = await fetchImpl(`${TOKENINFO}?access_token=${encodeURIComponent(token)}`).catch(() => null);
    if (!info?.ok) throw new HttpError(401, 'auth');
    const about = await info.json();
    const clients = String(env.GOOGLE_CLIENT_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (clients.length && !clients.includes(about.azp) && !clients.includes(about.aud)) {
      console.log('apocrypha: a token of another app', about.azp, about.aud);
      throw new HttpError(403, 'auth');
    }
    const scopes = String(about.scope ?? '').split(' ');
    const me = await fetchImpl(`${DRIVE}/about?fields=user(permissionId)`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    if (!me?.ok) throw new HttpError(401, 'auth');
    const owner = (await me.json())?.user?.permissionId;
    if (!owner) throw new HttpError(401, 'auth');
    const email = String(about.email ?? '').toLowerCase();
    const admin = Boolean(env.ADMIN_EMAIL) && String(about.email_verified) !== 'false' && email === String(env.ADMIN_EMAIL).toLowerCase();
    return { token, owner: String(owner), admin, scopes };
  }

  const one = (id) => db.prepare(`SELECT ${COLUMNS} FROM files WHERE id = ?`).bind(id).first();

  try {
    if (parts[0] !== 'v1') return parts.length ? json(404, { error: 'not-found' }) : json(200, { name: 'apocrypha', ok: true });
    const [, what, id, sub] = parts;
    const get = request.method === 'GET';

    // ---- the list ----
    if (what === 'files' && !id && get) {
      await limit('search');
      const where = ['hidden = 0'];
      const args = [];
      const words = searchText(url.searchParams.get('q') ?? '').split(' ').filter(Boolean).slice(0, 6);
      for (const word of words) {
        where.push("search LIKE ? ESCAPE '\\'");
        args.push(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      }
      const lang = url.searchParams.get('lang');
      if (lang && /^([a-z]{2,3}|und)$/.test(lang)) {
        where.push('lang = ?');
        args.push(lang);
      }
      const kind = url.searchParams.get('kind');
      if (KINDS.includes(kind)) {
        where.push('kind = ?');
        args.push(kind);
      }
      const format = url.searchParams.get('format');
      if (FORMATS.includes(format)) {
        where.push('format = ?');
        args.push(format);
      }
      const page = Math.min(Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1)), 500);
      const order = url.searchParams.get('sort') === 'popular' ? 'downloads DESC, created DESC' : 'created DESC';
      const cond = where.join(' AND ');
      const total = (await db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ${cond}`).bind(...args).first())?.n ?? 0;
      const rows = (
        await db
          .prepare(`SELECT ${COLUMNS} FROM files WHERE ${cond} ORDER BY ${order} LIMIT ? OFFSET ?`)
          .bind(...args, PAGE, (page - 1) * PAGE)
          .all()
      ).results;
      return json(200, { items: rows.map(publicItem), total, page, pages: Math.max(1, Math.ceil(total / PAGE)) });
    }

    if (what === 'langs' && get) {
      await limit('search');
      const rows = (await db.prepare('SELECT lang, COUNT(*) AS n FROM files WHERE hidden = 0 GROUP BY lang ORDER BY n DESC LIMIT 40').all()).results;
      return json(200, { langs: rows.map((r) => ({ lang: r.lang, count: r.n })) });
    }

    if (what === 'lookup' && get) {
      await limit('search');
      const sha = String(url.searchParams.get('sha256') ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, 'bad-request');
      const row = await db.prepare(`SELECT ${COLUMNS} FROM files WHERE sha256 = ?`).bind(sha).first();
      return json(200, { item: row && !row.hidden ? publicItem(row) : null, hidden: Boolean(row?.hidden) });
    }

    // ---- one file ----
    if (what === 'files' && id && !sub && get) {
      const row = await one(id);
      if (!row || row.hidden) throw new HttpError(404, 'not-found');
      return json(200, { item: publicItem(row) });
    }

    if (what === 'files' && id && sub === 'cover' && get) {
      const row = await db.prepare('SELECT cover, hidden FROM files WHERE id = ?').bind(id).first();
      const m = row && !row.hidden && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(row.cover ?? '');
      if (!m) return new Response(null, { status: 404, headers: CORS });
      const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      return new Response(bytes, { headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=86400', ...CORS } });
    }

    if (what === 'files' && id && sub === 'download' && get) {
      const row = await db.prepare('SELECT drive_id, sha256, hidden FROM files WHERE id = ?').bind(id).first();
      if (!row || row.hidden) throw new HttpError(404, 'not-found');
      await limit('download');
      const res = await fetchImpl(`${DRIVE}/files/${encodeURIComponent(row.drive_id)}?alt=media&key=${key()}`).catch(() => null);
      if (!res) throw new HttpError(502, 'drive');
      if (res.status === 404) {
        // its owner deleted it from Drive or closed it: out of the list
        await db.prepare('UPDATE files SET hidden = 2 WHERE id = ? AND hidden = 0').bind(id).run();
        throw new HttpError(410, 'gone');
      }
      if (!res.ok) throw new HttpError(502, 'drive', { status: res.status });
      await db.prepare('UPDATE files SET downloads = downloads + 1 WHERE id = ?').bind(id).run();
      const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Apocrypha-Sha256': row.sha256, ...CORS };
      const length = res.headers.get('content-length');
      if (length) headers['Content-Length'] = length;
      return new Response(res.body, { headers });
    }

    if (what === 'files' && id && sub === 'report' && request.method === 'POST') {
      await limit('report');
      const body = await readJson(request, 4000);
      if (!REASONS.includes(body?.reason)) throw new HttpError(400, 'bad-request');
      const note = text(body.note, 500);
      const row = await db.prepare('SELECT id FROM files WHERE id = ?').bind(id).first();
      if (!row) throw new HttpError(404, 'not-found');
      const reporter = (await hash(salt, 'report', ip)).slice(0, 32);
      const put = await db.prepare('INSERT OR IGNORE INTO reports (file_id, reporter, reason, note, created) VALUES (?, ?, ?, ?, ?)').bind(id, reporter, body.reason, note, now).run();
      if (put.meta?.changes) await db.prepare('UPDATE files SET reports = reports + 1 WHERE id = ?').bind(id).run();
      return json(200, { ok: true });
    }

    // ---- sharing and taking back ----
    if (what === 'files' && !id && request.method === 'POST') {
      await limit('publish');
      const share = readShare(await readJson(request));
      const same = await db.prepare(`SELECT ${COLUMNS} FROM files WHERE sha256 = ? OR drive_id = ?`).bind(share.sha256, share.driveId).first();
      if (same) throw new HttpError(409, 'duplicate', { item: same.hidden ? null : publicItem(same), hidden: Boolean(same.hidden) });
      const me = await who();
      const today = (await db.prepare('SELECT COUNT(*) AS n FROM files WHERE owner = ? AND created > ?').bind(me.owner, now - 86400_000).first())?.n ?? 0;
      if (today >= PER_DAY) throw new HttpError(429, 'day-limit');

      // the file: theirs, whole, these bytes
      const fid = encodeURIComponent(share.driveId);
      const metaRes = await fetchImpl(`${DRIVE}/files/${fid}?fields=id,size,sha256Checksum,ownedByMe,trashed`, { headers: { Authorization: `Bearer ${me.token}` } }).catch(() => null);
      if (!metaRes) throw new HttpError(502, 'drive');
      if (metaRes.status === 404 || metaRes.status === 403) throw new HttpError(400, 'not-owner');
      if (!metaRes.ok) throw new HttpError(502, 'drive', { status: metaRes.status });
      const meta = await metaRes.json();
      if (!meta.ownedByMe || meta.trashed) throw new HttpError(400, 'not-owner');
      if (Number(meta.size) !== share.size) throw new HttpError(400, 'mismatch');
      if (meta.sha256Checksum && meta.sha256Checksum.toLowerCase() !== share.sha256) throw new HttpError(400, 'mismatch');

      // open to anyone: a request with only the key sees it
      const open = await fetchImpl(`${DRIVE}/files/${fid}?fields=id&key=${key()}`).catch(() => null);
      if (!open?.ok) throw new HttpError(400, 'not-public');
      const head = await fetchImpl(`${DRIVE}/files/${fid}?alt=media&key=${key()}`, { headers: { Range: 'bytes=0-1023' } }).catch(() => null);
      if (!head?.ok) throw new HttpError(400, 'not-public');
      const first = new Uint8Array(await head.arrayBuffer()).subarray(0, 1024);
      if (!looksLike(share.format, first)) throw new HttpError(400, 'bad-format');

      const row = {
        id: newId(),
        drive_id: share.driveId,
        sha256: share.sha256,
        size: share.size,
        format: share.format,
        title: share.title,
        author: share.author,
        lang: share.lang,
        kind: share.kind,
        description: share.description,
        cover: share.cover,
        owner: me.owner,
        created: now,
        downloads: 0,
        reports: 0,
        hidden: 0,
      };
      try {
        await db
          .prepare(
            'INSERT INTO files (id, drive_id, sha256, size, format, title, author, lang, kind, description, cover, owner, created, search) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(row.id, row.drive_id, row.sha256, row.size, row.format, row.title, row.author, row.lang, row.kind, row.description, row.cover, row.owner, row.created, searchText(row.title, row.author))
          .run();
      } catch (err) {
        // the same file a moment ago, from another device
        if (/UNIQUE/i.test(String(err?.message))) throw new HttpError(409, 'duplicate', { item: null });
        throw err;
      }
      return json(201, { item: ownItem(row) });
    }

    if (what === 'files' && id && !sub && request.method === 'DELETE') {
      await limit('remove');
      const me = await who();
      const row = await db.prepare('SELECT owner, drive_id FROM files WHERE id = ?').bind(id).first();
      if (!row) throw new HttpError(404, 'not-found');
      if (row.owner !== me.owner && !me.admin) throw new HttpError(403, 'not-owner');
      await db.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
      await db.prepare('DELETE FROM reports WHERE file_id = ?').bind(id).run();
      return json(200, { ok: true, driveId: row.owner === me.owner ? row.drive_id : null });
    }

    if (what === 'mine' && get) {
      const me = await who();
      const rows = (await db.prepare(`SELECT ${COLUMNS} FROM files WHERE owner = ? ORDER BY created DESC LIMIT 500`).bind(me.owner).all()).results;
      return json(200, { items: rows.map(ownItem), admin: me.admin });
    }

    // ---- the app's owner ----
    if (what === 'admin') {
      const me = await who();
      if (!me.admin) throw new HttpError(403, 'not-admin');
      if (id === 'reports' && get) {
        const rows = (await db.prepare(`SELECT ${COLUMNS} FROM files WHERE reports > 0 OR hidden = 1 ORDER BY hidden ASC, reports DESC, created DESC LIMIT 200`).all()).results;
        const reasons = (await db.prepare('SELECT file_id, reason, note, created FROM reports ORDER BY created DESC LIMIT 2000').all()).results;
        return json(200, {
          items: rows.map((row) => ({ ...ownItem(row), complaints: reasons.filter((r) => r.file_id === row.id).map(({ reason, note, created }) => ({ reason, note, created })) })),
        });
      }
      if (id === 'files' && sub && request.method === 'POST') {
        const body = await readJson(request, 1000);
        const row = await one(sub);
        if (!row) throw new HttpError(404, 'not-found');
        await db.prepare('UPDATE files SET hidden = ? WHERE id = ?').bind(body?.hidden ? 1 : 0, sub).run();
        if (!body?.hidden) await db.prepare('UPDATE files SET reports = 0 WHERE id = ?').bind(sub).run();
        if (!body?.hidden) await db.prepare('DELETE FROM reports WHERE file_id = ?').bind(sub).run();
        return json(200, { ok: true });
      }
    }

    return json(404, { error: 'not-found' });
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.code, ...err.extra });
    console.error('apocrypha:', err?.stack ?? err);
    return json(500, { error: 'server' });
  }
}

export default {
  fetch: (request, env) => handle(request, env),
};

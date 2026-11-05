// Talking to Apocrypha: the catalogue (apocrypha/src/worker.js, on Cloudflare) and, to share a file,
// the person's own Google Drive. Sharing puts a copy of the file in a folder "ATLAS Apocrypha" on
// their Drive, opens it to anyone with the link and lists it in the catalogue; taking it back does the
// reverse. Downloads come through the catalogue, which fetches the public file from Drive.

import { createDrive } from '../sync/drive.js';
import { sha256Hex } from './checks.js';

/** The catalogue's address (the Worker "atlastaker" on the app owner's Cloudflare account). */
export const APOCRYPHA_URL = 'https://atlastaker.en-safarov.workers.dev';
export const DRIVE_FOLDER = 'ATLAS Apocrypha';

const MIME = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  fb2: 'application/x-fictionbook+xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  cbz: 'application/vnd.comicbook+zip',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
};

/** code: what the catalogue said ('duplicate', 'not-public', 'rate', …) or 'offline' / 'http-<status>'. */
export class ApocryphaError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * getToken(force): a Google access token with drive.file, or throws ApocryphaError
 * ('needs-consent', 'auth', 'cancelled', 'offline'). Only sharing and the person's own list need it.
 */
export function createApocrypha({ base = APOCRYPHA_URL, getToken, fetchImpl = (...args) => fetch(...args) }) {
  const drive = createDrive({ getToken, fetchImpl });

  async function call(path, { method = 'GET', body, auth = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (auth) headers.Authorization = `Bearer ${await getToken(attempt > 0)}`;
      let res;
      try {
        res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch {
        throw new ApocryphaError('offline');
      }
      if (res.status === 401 && auth && attempt === 0) continue; // the token ran out a moment ago
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const { error, ...extra } = data ?? {};
        throw new ApocryphaError(error || `http-${res.status}`, { status: res.status, ...extra });
      }
      return data;
    }
  }

  const query = (params) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') q.set(key, String(value));
    return q.toString();
  };

  return {
    base,
    /** { items, total, page, pages } */
    search: ({ q = '', lang = '', kind = '', format = '', sort = 'new', page = 1 } = {}) => call(`/v1/files?${query({ q, lang, kind, format, sort, page })}`),
    langs: async () => (await call('/v1/langs')).langs,
    /** { item, hidden }: the listed file with these bytes, if any. */
    lookup: (sha256) => call(`/v1/lookup?${query({ sha256 })}`),
    coverUrl: (id) => `${base}/v1/files/${encodeURIComponent(id)}/cover`,

    /** The file's bytes, checked against the SHA-256 the catalogue has. onBytes(received, total). */
    async download(item, onBytes) {
      let res;
      try {
        res = await fetchImpl(`${base}/v1/files/${encodeURIComponent(item.id)}/download`);
      } catch {
        throw new ApocryphaError('offline');
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new ApocryphaError(data.error || `http-${res.status}`, { status: res.status });
      }
      const total = Number(res.headers.get('content-length')) || item.size || 0;
      const chunks = [];
      let received = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onBytes?.(received, total);
      }
      const bytes = new Uint8Array(received);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      if (item.sha256 && (await sha256Hex(bytes)) !== item.sha256) throw new ApocryphaError('mismatch');
      return bytes;
    },

    report: (id, reason, note = '') => call(`/v1/files/${encodeURIComponent(id)}/report`, { method: 'POST', body: { reason, note } }),

    /** { items, admin }: what this person shared, hidden ones too. */
    mine: () => call('/v1/mine', { auth: true }),

    /**
     * Shares a file: its copy on the person's Drive, open to anyone, then the catalogue's entry.
     * meta: { sha256, size, format, kind, lang, title, author, description, cover }.
     */
    async publish({ name, bytes, meta }) {
      const parent = await drive.folder(DRIVE_FOLDER);
      const driveId = await drive.put(name, bytes, { parents: [parent], type: MIME[meta.format] ?? 'application/octet-stream' });
      try {
        await drive.makePublic(driveId);
        return (await call('/v1/files', { method: 'POST', auth: true, body: { driveId, ...meta } })).item;
      } catch (err) {
        // nothing half-done stays on the Drive
        await drive.remove(driveId).catch(() => {});
        throw err;
      }
    },

    /** Out of the catalogue; for its owner, the copy on Drive goes too. */
    async unpublish(id) {
      const answer = await call(`/v1/files/${encodeURIComponent(id)}`, { method: 'DELETE', auth: true });
      if (answer.driveId) await drive.remove(answer.driveId).catch(() => {});
      return answer;
    },

    // the app's owner
    reports: () => call('/v1/admin/reports', { auth: true }),
    hide: (id, hidden) => call(`/v1/admin/files/${encodeURIComponent(id)}`, { method: 'POST', auth: true, body: { hidden } }),
  };
}

// The app's hidden folder on the user's Google Drive (appDataFolder): only this app sees it, and the
// app sees nothing else of the Drive. Plain REST over fetch, so the same code runs in Node (Windows)
// and in the Android WebView. `getToken(force)` hands over a fresh access token.

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const RESUMABLE_FROM = 5 * 1024 * 1024;

export class DriveError extends Error {
  constructor(message, { status = 0, auth = false, offline = false } = {}) {
    super(message);
    this.status = status;
    this.auth = auth;
    this.offline = offline;
  }
}

export function createDrive({ getToken, fetchImpl = (...args) => fetch(...args) }) {
  async function request(url, init = {}, { retry = true } = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await getToken(attempt > 0 && retry);
      let res;
      try {
        res = await fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
      } catch (err) {
        throw new DriveError(`Google Drive: ${err.message}`, { offline: true });
      }
      if (res.status === 401 && attempt === 0) continue; // the token ran out a moment ago
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        let reason = '';
        try {
          reason = JSON.parse(body)?.error?.message ?? '';
        } catch {
          reason = body.slice(0, 200);
        }
        throw new DriveError(`Google Drive ${res.status}${reason ? `: ${reason}` : ''}`, { status: res.status, auth: res.status === 401 });
      }
      return res;
    }
  }

  /** Every file of the app folder: [{ id, name, modifiedTime, size }]. */
  async function list() {
    const files = [];
    let page = '';
    do {
      const q = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '1000', fields: 'nextPageToken,files(id,name,modifiedTime,size)' });
      if (page) q.set('pageToken', page);
      const body = await (await request(`${API}/files?${q}`)).json();
      files.push(...(body.files ?? []));
      page = body.nextPageToken ?? '';
    } while (page);
    return files;
  }

  async function bytes(id) {
    return new Uint8Array(await (await request(`${API}/files/${id}?alt=media`)).arrayBuffer());
  }

  async function text(id) {
    return (await request(`${API}/files/${id}?alt=media`)).text();
  }

  /** Writes a file: a new one when `id` is empty, else that file's content. Returns its id. */
  async function put(name, data, { id = '', type = 'application/octet-stream' } = {}) {
    const body = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const meta = id ? {} : { name, parents: ['appDataFolder'] };
    if (body.length >= RESUMABLE_FROM) {
      const start = await request(`${UPLOAD}/files${id ? `/${id}` : ''}?uploadType=resumable&fields=id`, {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(body.length) },
        body: JSON.stringify(meta),
      });
      const location = start.headers.get('location');
      if (!location) throw new DriveError('Google Drive: no upload address');
      const done = await request(location, { method: 'PUT', headers: { 'Content-Type': type }, body });
      return (await done.json()).id;
    }
    const boundary = `atlas${Math.random().toString(36).slice(2)}`;
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
    const multipart = new Uint8Array(head.length + body.length + tail.length);
    multipart.set(head, 0);
    multipart.set(body, head.length);
    multipart.set(tail, head.length + body.length);
    const res = await request(`${UPLOAD}/files${id ? `/${id}` : ''}?uploadType=multipart&fields=id`, {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    return (await res.json()).id;
  }

  async function remove(id) {
    try {
      await request(`${API}/files/${id}`, { method: 'DELETE' });
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }

  /** When a file was last written ('' when it is gone): tells whether another device wrote it meanwhile. */
  async function modified(id) {
    try {
      return (await (await request(`${API}/files/${id}?fields=modifiedTime`)).json()).modifiedTime ?? '';
    } catch (err) {
      if (err.status === 404) return '';
      throw err;
    }
  }

  return { list, bytes, text, put, remove, modified };
}

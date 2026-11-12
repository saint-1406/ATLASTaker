// The offline translator from Firefox (Bergamot) as one of src/translate.js's engines: better than ML
// Kit and opus-mt, private (nothing leaves the device), and no allowance. Its files (about 5 MB of
// WebAssembly and 37 MB a direction, src/bergamotFiles.js) are downloaded once, when the person agrees,
// by the local server on Windows or the app's native side on Android, and served back at
// /translate-files/. It translates in a worker (dist/bergamot-worker.js), so the page does not stall.

import { bergamotModel, bergamotPaths, BERGAMOT_FILES, BERGAMOT_WASM } from './bergamotFiles.js';
import { TranslateError } from './translate.js';

/**
 * files: { status(paths) → { missing, sizes }, download(path, onBytes) } — the server's (api.translate)
 * or Android's (androidFiles below). base: where the files are served.
 */
export function bergamotEngine({ files, base = `${location.origin}/translate-files/`, workerUrl = 'dist/bergamot-worker.js' }) {
  let worker = null;
  let next = 1;
  const waiting = new Map();

  async function startWorker() {
    if (worker) return worker;
    // the CSP lets workers start only from blob: URLs (as pdf.js does)
    const res = await fetch(workerUrl);
    if (!res.ok) throw new TranslateError('failed');
    const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = ({ data }) => {
      const entry = waiting.get(data?.id);
      if (!entry) return;
      waiting.delete(data.id);
      if (data.error) entry.reject(Object.assign(new TranslateError('failed'), { detail: data.error }));
      else entry.resolve(data.texts);
    };
    worker.onerror = () => {
      for (const entry of waiting.values()) entry.reject(new TranslateError('failed'));
      waiting.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  }

  return {
    name: 'bergamot',
    async state(pair) {
      if (!bergamotModel(pair)) return 'unavailable';
      try {
        const { missing } = await files.status(bergamotPaths(pair));
        return missing.length ? 'download' : 'ready';
      } catch {
        return 'unavailable';
      }
    },
    async prepare(pair, onProgress) {
      const { missing } = await files.status(bergamotPaths(pair));
      const total = missing.reduce((sum, rel) => sum + (BERGAMOT_FILES[rel]?.size ?? 0), 0);
      let done = 0;
      for (const rel of missing) {
        try {
          await files.download(rel, (bytes) => onProgress?.(total ? Math.min(1, (done + bytes) / total) : 0));
        } catch (err) {
          throw err instanceof TranslateError ? err : new TranslateError('download');
        }
        done += BERGAMOT_FILES[rel]?.size ?? 0;
      }
    },
    async translate(pair, texts) {
      const model = bergamotModel(pair);
      if (!model) throw new TranslateError('failed');
      const w = await startWorker();
      return new Promise((resolve, reject) => {
        const id = next++;
        waiting.set(id, { resolve, reject });
        w.postMessage({ id, base, wasm: BERGAMOT_WASM, pair, files: model, texts });
      });
    },
  };
}

/**
 * Android: the files through the app's native side (TranslateFiles.java). status is asked at once;
 * a download answers through window.__atlas.translate with { id: "f…", done, total } as it goes and
 * { id, ok, code } at the end — receive(event) takes those and says whether it was one of its own.
 */
export function androidFiles(android) {
  const waiting = new Map();
  let next = 1;
  return {
    async status(paths) {
      const answer = JSON.parse(String(android.translateFilesStatus(JSON.stringify(paths))));
      return { missing: Array.isArray(answer?.missing) ? answer.missing : paths, sizes: {} };
    },
    download(path, onBytes) {
      return new Promise((resolve, reject) => {
        const id = `f${next++}`;
        waiting.set(id, { resolve, reject, onBytes });
        android.translateFileDownload(id, path);
      });
    },
    receive(event) {
      const entry = waiting.get(String(event?.id));
      if (!entry) return false;
      if (event.done !== undefined && event.ok === undefined) {
        entry.onBytes?.(Number(event.done) || 0);
        return true;
      }
      waiting.delete(String(event.id));
      if (event.ok) entry.resolve();
      else entry.reject(new TranslateError(event.code || 'download'));
      return true;
    },
  };
}

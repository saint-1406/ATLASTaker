// The files the page's translator needs (src/translate.js, src/translateModel.js): two opus-mt
// models from Hugging Face and the ONNX runtime's WebAssembly from the npm CDN. Each is downloaded
// once, when the person agrees in the page, into <data>/translate, and served from there afterwards.
// Only these exact files can be asked for; the page never talks to those hosts itself.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const MODEL_RE = /^hf\/Xenova\/opus-mt-(ru-en|en-ru)\/(config\.json|generation_config\.json|tokenizer\.json|tokenizer_config\.json|onnx\/encoder_model_quantized\.onnx|onnx\/decoder_model_merged_quantized\.onnx)$/;
const ORT_RE = /^ort\/(\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.-]{1,60})?)\/(ort-wasm-simd-threaded\.asyncify\.(?:mjs|wasm))$/;

/** Where a file the translator may ask for comes from; null for anything else. */
export function upstreamFor(rel) {
  const model = MODEL_RE.exec(String(rel));
  if (model) return `https://huggingface.co/Xenova/opus-mt-${model[1]}/resolve/main/${model[2]}`;
  const ort = ORT_RE.exec(String(rel));
  if (ort) return `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort[1]}/dist/${ort[2]}`;
  return null;
}

export const TRANSLATE_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

export function createTranslateFiles(dataDir, { fetchImpl = globalThis.fetch } = {}) {
  const root = path.join(dataDir, 'translate');
  const downloads = new Map(); // rel → Promise of the finished file

  /** The file on disk for an allowed path (it may not be there yet); null for anything else. */
  const fileFor = (rel) => (upstreamFor(rel) ? path.join(root, ...rel.split('/')) : null);

  async function sizeOf(rel) {
    const file = fileFor(rel);
    const stat = file ? await fsp.stat(file).catch(() => null) : null;
    return stat?.isFile() ? stat.size : 0;
  }

  /** Which of the paths are not here yet, and how big those are (asked of the source, roughly). */
  async function status(paths) {
    const wanted = (Array.isArray(paths) ? paths : []).map(String).filter((p) => upstreamFor(p)).slice(0, 20);
    const missing = [];
    for (const rel of wanted) if (!(await sizeOf(rel))) missing.push(rel);
    const sizes = {};
    await Promise.all(
      missing.map(async (rel) => {
        try {
          const head = await fetchImpl(upstreamFor(rel), { method: 'HEAD', redirect: 'follow' });
          sizes[rel] = Number(head.headers.get('x-linked-size') || head.headers.get('content-length')) || 0;
        } catch {
          sizes[rel] = 0;
        }
      }),
    );
    return { missing, sizes };
  }

  /**
   * Sends one file to `out` (a response), downloading it first if it is not here: then its bytes go
   * to the page as they come, so the page can show how far it got. A file asked for twice at the same
   * time is downloaded once.
   */
  async function download(rel, out) {
    const file = fileFor(rel);
    if (!file) throw Object.assign(new Error('not allowed'), { status: 404 });
    if (!(await sizeOf(rel))) {
      if (!downloads.has(rel)) {
        const job = fetchTo(rel, file, out).finally(() => downloads.delete(rel));
        downloads.set(rel, job);
        return job;
      }
      await downloads.get(rel);
    }
    out.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': await sizeOf(rel), 'Cache-Control': 'no-store' });
    await new Promise((resolve, reject) => fs.createReadStream(file).on('error', reject).pipe(out).on('finish', resolve).on('error', reject));
  }

  async function fetchTo(rel, file, out) {
    const response = await fetchImpl(upstreamFor(rel), { redirect: 'follow' });
    if (!response.ok || !response.body) throw Object.assign(new Error(`download failed: ${response.status}`), { status: 502 });
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const part = `${file}.part`;
    const sink = fs.createWriteStream(part);
    const length = Number(response.headers.get('content-length')) || 0;
    out.writeHead(200, { 'Content-Type': 'application/octet-stream', ...(length ? { 'Content-Length': length } : {}), 'Cache-Control': 'no-store' });
    try {
      for await (const chunk of Readable.fromWeb(response.body)) {
        if (!sink.write(chunk)) await new Promise((resolve) => sink.once('drain', resolve));
        if (!out.destroyed) out.write(chunk); // the page may have gone: the file is finished anyway
      }
      await new Promise((resolve, reject) => sink.end((err) => (err ? reject(err) : resolve())));
      await fsp.rename(part, file);
    } catch (err) {
      sink.destroy();
      await fsp.rm(part, { force: true });
      out.destroy();
      throw err;
    }
    out.end();
  }

  return { root, fileFor, sizeOf, status, download };
}

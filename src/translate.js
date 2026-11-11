// Translation of a selected passage, Russian ↔ English, on the device. Three engines behind one interface:
//   - Android: Google ML Kit in the app's native side (MainActivity.java: translate…), offline once
//     the language models (about 30 MB each) are on the phone; results come back through
//     window.__atlas.translate(event);
//   - a browser with the built-in Translator API (Chrome): the browser's own on-device model;
//   - the Windows app otherwise: Marian opus-mt models run in the page (dist/translate.js, with
//     transformers.js), downloaded once through the local server (server/translate.js) into the data
//     folder — the page itself still talks only to its own server.
// The single-file browser build may not use the network at all: there only the Translator API works.

export const PAIRS = ['ru-en', 'en-ru'];

/** Which way a passage goes: Cyrillic text to English, Latin text to Russian; null with no letters at all. */
export function directionOf(text) {
  const cyrillic = (String(text).match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const latin = (String(text).match(/\p{Script=Latin}/gu) ?? []).length;
  if (!cyrillic && !latin) return null;
  return cyrillic >= latin ? { from: 'ru', to: 'en' } : { from: 'en', to: 'ru' };
}

export const otherWay = ({ from, to }) => ({ from: to, to: from });

/**
 * A passage in pieces a model takes at once: paragraphs (the line breaks between them are kept as
 * they are), a long paragraph cut after its sentences, an endless sentence at a space.
 * Returns [{ text, gap }]: translate each text, then join each translation with its gap.
 */
export function splitText(text, max = 400) {
  const out = [];
  const parts = String(text).replace(/\r\n?/g, '\n').split(/(\n+)/);
  for (let i = 0; i < parts.length; i += 2) {
    const paragraph = parts[i].trim();
    const breaks = parts[i + 1] ?? '';
    if (!paragraph) {
      if (out.length && breaks) out[out.length - 1].gap += breaks;
      continue;
    }
    const pieces = [];
    let current = '';
    for (const sentence of paragraph.split(/(?<=[.!?…;])\s+/u)) {
      for (const bit of cut(sentence, max)) {
        if (current && current.length + 1 + bit.length > max) {
          pieces.push(current);
          current = bit;
        } else current = current ? `${current} ${bit}` : bit;
      }
    }
    if (current) pieces.push(current);
    pieces.forEach((piece, n) => out.push({ text: piece, gap: n < pieces.length - 1 ? ' ' : breaks }));
  }
  if (out.length) out[out.length - 1].gap = out[out.length - 1].gap.replace(/\n+$/, '');
  return out;
}

/** A sentence longer than max, cut at spaces (a word longer than max on its own is cut anyway). */
function cut(sentence, max) {
  if (sentence.length <= max) return [sentence];
  const bits = [];
  let rest = sentence;
  while (rest.length > max) {
    let at = rest.lastIndexOf(' ', max);
    if (at <= 0) at = max;
    bits.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) bits.push(rest);
  return bits;
}

/** The translated pieces put back together with the gaps of the original. */
export const joinPieces = (pieces, translated) => pieces.map((piece, i) => (translated[i] ?? '').trim() + piece.gap).join('');

// ---------- the engines ----------
// Each: { name, state(pair) → 'ready' | 'download' | 'unavailable', prepare(pair, onProgress), translate(pair, texts) → texts }.
// "download": the model is not here yet and comes once the person agrees (prepare fetches it).

/** Android: ML Kit through window.AtlasAndroid. receive(event) takes the native side's answers. */
export function androidEngine(android) {
  const waiting = new Map();
  let next = 1;
  const ask = (start) =>
    new Promise((resolve, reject) => {
      const id = String(next++);
      waiting.set(id, { resolve, reject });
      start(id);
    });
  return {
    name: 'mlkit',
    async state(pair) {
      const [from, to] = pair.split('-');
      const state = String(android.translateState(from, to));
      return ['ready', 'download'].includes(state) ? state : 'unavailable';
    },
    prepare(pair) {
      const [from, to] = pair.split('-');
      return ask((id) => android.translatePrepare(id, from, to));
    },
    translate(pair, texts) {
      const [from, to] = pair.split('-');
      return ask((id) => android.translate(id, from, to, JSON.stringify(texts)));
    },
    /** { id, ok, texts, code } from MainActivity. */
    receive(event) {
      const entry = waiting.get(String(event?.id));
      if (!entry) return;
      waiting.delete(String(event.id));
      if (event.ok) entry.resolve(Array.isArray(event.texts) ? event.texts : []);
      else entry.reject(new TranslateError(event.code || 'failed'));
    },
  };
}

/** A promise that gives up after `ms`: some browsers have the Translator API but never answer it. */
const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new TranslateError('timeout')), ms))]);

/** The browser's Translator API (Chrome 138+; Edge behind a flag). Null where there is none. */
export function browserEngine(Translator = globalThis.Translator, { wait = 3000 } = {}) {
  if (typeof Translator?.availability !== 'function' || typeof Translator?.create !== 'function') return null;
  const made = new Map();
  let silent = false; // it did not answer once: not asked again in this window
  const options = (pair) => {
    const [sourceLanguage, targetLanguage] = pair.split('-');
    return { sourceLanguage, targetLanguage };
  };
  return {
    name: 'browser',
    async state(pair) {
      if (made.has(pair)) return 'ready';
      if (silent) return 'unavailable';
      let state;
      try {
        state = await within(Translator.availability(options(pair)), wait);
      } catch (err) {
        if (err?.code === 'timeout') silent = true;
        return 'unavailable';
      }
      if (state === 'available') return 'ready';
      return state === 'downloadable' || state === 'downloading' ? 'download' : 'unavailable';
    },
    async prepare(pair, onProgress) {
      if (made.has(pair)) return;
      const translator = await Translator.create({
        ...options(pair),
        monitor(m) {
          m.addEventListener?.('downloadprogress', (e) => onProgress?.(e.loaded ?? 0));
        },
      });
      made.set(pair, translator);
    },
    async translate(pair, texts) {
      if (!made.has(pair)) await this.prepare(pair);
      const translator = made.get(pair);
      const out = [];
      for (const text of texts) out.push(await translator.translate(text));
      return out;
    },
  };
}

// the files of an opus-mt model the page needs (8-bit, about 118 MB a direction), and the ONNX runtime
// (server/translate.js lets exactly these through)
export const MODEL_FILES = ['config.json', 'generation_config.json', 'tokenizer_config.json', 'tokenizer.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];
export const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];
export const modelPaths = (pair) => MODEL_FILES.map((file) => `hf/Xenova/opus-mt-${pair}/${file}`);
export const ortPaths = (version) => ORT_FILES.map((file) => `ort/${version}/${file}`);

/**
 * The Windows app: opus-mt in the page. translateApi: the bridge's { status(paths), download(path,
 * onBytes) }; loadModelCode() → window.AtlasTranslate from dist/translate.js ({ ortVersion, load(pair) }).
 */
export function modelEngine({ translateApi, loadModelCode }) {
  const loaded = new Map(); // pair → Promise<translate(texts)>
  const needed = async (pair) => {
    const code = await loadModelCode();
    return [...modelPaths(pair), ...ortPaths(code.ortVersion)];
  };
  return {
    name: 'model',
    async state(pair) {
      if (loaded.has(pair)) return 'ready';
      try {
        const { missing } = await translateApi.status(await needed(pair));
        return missing.length ? 'download' : 'ready';
      } catch {
        return 'unavailable';
      }
    },
    async prepare(pair, onProgress) {
      const paths = await needed(pair);
      const { missing, sizes = {} } = await translateApi.status(paths);
      const total = missing.reduce((sum, p) => sum + (sizes[p] || 0), 0);
      let done = 0;
      for (const path of missing) {
        await translateApi.download(path, (bytes) => onProgress?.(total ? Math.min(1, (done + bytes) / total) : 0));
        done += sizes[path] || 0;
      }
    },
    async translate(pair, texts) {
      if (!loaded.has(pair)) {
        const pending = loadModelCode().then((code) => code.load(pair));
        pending.catch(() => loaded.delete(pair));
        loaded.set(pair, pending);
      }
      const run = await loaded.get(pair);
      const out = [];
      for (const text of texts) out.push(await run(text));
      return out;
    },
  };
}

// Yandex Translate (Yandex Cloud, API v2), with the person's own API key: online, and the text goes to
// Yandex. The key stays on this device (localStorage), never in the synced settings.
export const YANDEX_KEY = 'atlas.yandexTranslateKey';
const YANDEX_BATCH = 9000; // characters a request carries (the API takes up to 10 000)

export function yandexKey() {
  try {
    return (localStorage.getItem(YANDEX_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

export function setYandexKey(key) {
  try {
    const value = String(key ?? '').trim();
    if (value) localStorage.setItem(YANDEX_KEY, value);
    else localStorage.removeItem(YANDEX_KEY);
  } catch {
    // only on this device anyway
  }
}

/** Pieces in batches a request takes: none longer than `max` characters together. */
export function batches(texts, max = YANDEX_BATCH) {
  const out = [];
  let current = [];
  let size = 0;
  for (const text of texts) {
    if (current.length && size + text.length > max) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(text);
    size += text.length;
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * Yandex: send({ key, from, to, texts }) → translated texts, the request made where the page may not
 * (the local server on Windows, the app's native side on Android: the API does not answer a page).
 * getKey() → the key, or '' (then it is not offered).
 */
export function yandexEngine({ send, getKey = yandexKey }) {
  return {
    name: 'yandex',
    online: true,
    async state() {
      return getKey() ? 'ready' : 'unavailable';
    },
    async prepare() {},
    async translate(pair, texts) {
      const [from, to] = pair.split('-');
      const key = getKey();
      if (!key) throw new TranslateError('yandex-key');
      const out = [];
      for (const batch of batches(texts)) {
        const got = await send({ key, from, to, texts: batch });
        if (!Array.isArray(got) || got.length !== batch.length) throw new TranslateError('failed');
        out.push(...got);
      }
      return out;
    },
  };
}

/** Android: Yandex through the app's native side; receive(event) takes its answers (ids start with "y"). */
export function androidYandexSend(android) {
  const waiting = new Map();
  let next = 1;
  const send = ({ key, from, to, texts }) =>
    new Promise((resolve, reject) => {
      const id = `y${next++}`;
      waiting.set(id, { resolve, reject });
      android.yandexTranslate(id, key, from, to, JSON.stringify(texts));
    });
  send.receive = (event) => {
    const entry = waiting.get(String(event?.id));
    if (!entry) return false;
    waiting.delete(String(event.id));
    if (event.ok) entry.resolve(Array.isArray(event.texts) ? event.texts : []);
    else entry.reject(new TranslateError(event.code || 'failed'));
    return true;
  };
  return send;
}

export class TranslateError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Picks the engine for a pair: Android's on a phone; else the browser's where it knows the pair; else
 * the model one where there is a server. Returns { engine, state } or null where nothing translates.
 */
export async function pickEngine(engines, pair) {
  for (const engine of engines.filter(Boolean)) {
    const state = await engine.state(pair);
    if (state !== 'unavailable') return { engine, state };
  }
  return null;
}

/** Translates a passage with an engine that is ready: pieces in, the text with its paragraphs out. */
export async function translateWith(engine, pair, text) {
  const pieces = splitText(text);
  if (!pieces.length) return '';
  const out = await engine.translate(pair, pieces.map((p) => p.text));
  return joinPieces(pieces, out);
}

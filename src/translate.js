// Translation of a selected passage, Russian ↔ English. Engines behind one interface, tried in order:
//   - MyMemory (api.mymemory.translated.net): online, free, no key; a daily allowance per address
//     (more with an e-mail given in the settings). The page asks it itself;
//   - Firefox's own offline translator (Bergamot, src/bergamot.js): about 37 MB a direction, downloaded
//     once; better than the two below, and nothing leaves the device;
//   - Android: Google ML Kit in the app's native side (MainActivity.java: translate…), offline once
//     the language models (about 30 MB each) are on the phone; results come back through
//     window.__atlas.translate(event);
//   - a browser with the built-in Translator API (Chrome): the browser's own on-device model;
//   - the Windows app otherwise: Marian opus-mt models run in the page (dist/translate.js, with
//     transformers.js), downloaded once through the local server (server/translate.js) into the data
//     folder.
// Without the internet, or once MyMemory's allowance for the day is used up, the engines on the device
// take over. The single-file browser build may not use the network at all: there only the Translator
// API works.

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

// ---------- MyMemory: online, free, no key ----------

const MYMEMORY = 'https://api.mymemory.translated.net/get';
export const MYMEMORY_EMAIL = 'atlas.myMemoryEmail';
// a request carries at most 500 bytes of text: a Cyrillic letter is two
const MYMEMORY_PIECE = 200;

/** The e-mail that raises MyMemory's daily allowance (kept on this device only), or ''. */
export function myMemoryEmail() {
  try {
    return (localStorage.getItem(MYMEMORY_EMAIL) ?? '').trim();
  } catch {
    return '';
  }
}

export function setMyMemoryEmail(email) {
  try {
    const value = String(email ?? '').trim();
    if (value) localStorage.setItem(MYMEMORY_EMAIL, value);
    else localStorage.removeItem(MYMEMORY_EMAIL);
  } catch {
    // only on this device anyway
  }
}

/** A plausible e-mail address (MyMemory only needs one to count the allowance by). */
export const isEmail = (value) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(String(value).trim());

// MyMemory answers with a few HTML entities in its text
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
export const unentity = (text) =>
  String(text).replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#(\d{1,6}));/g, (whole, code) => (code ? String.fromCodePoint(Number(code)) : ENTITIES[whole]));

/** Runs task(item) for every item, a few at a time; the answers in the items' order. */
async function inTurns(items, task, width = 3) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return out;
}

/**
 * MyMemory. Errors: quota (the day's allowance is used up), network (out of reach), failed.
 * fetchImpl and getEmail are there for the tests.
 */
export function myMemoryEngine({ fetchImpl = (...args) => globalThis.fetch(...args), getEmail = myMemoryEmail, online = () => globalThis.navigator?.onLine !== false } = {}) {
  async function one(text, from, to) {
    const params = new URLSearchParams({ q: text, langpair: `${from}|${to}` });
    const email = getEmail();
    if (email) params.set('de', email);
    let res;
    try {
      res = await fetchImpl(`${MYMEMORY}?${params}`, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch {
      throw new TranslateError('network');
    }
    if (res.status === 429) throw new TranslateError('quota');
    if (!res.ok) throw new TranslateError('failed');
    const answer = await res.json().catch(() => null);
    const translated = answer?.responseData?.translatedText;
    if (answer?.quotaFinished || Number(answer?.responseStatus) === 429 || /^MYMEMORY WARNING/i.test(translated ?? '')) throw new TranslateError('quota');
    if (Number(answer?.responseStatus) !== 200 || typeof translated !== 'string') throw new TranslateError('failed');
    return unentity(translated);
  }
  return {
    name: 'mymemory',
    online: true,
    maxPiece: MYMEMORY_PIECE,
    async state() {
      return online() ? 'ready' : 'unavailable';
    },
    async prepare() {},
    translate(pair, texts) {
      const [from, to] = pair.split('-');
      return inTurns(texts, (text) => one(text, from, to));
    },
  };
}

export class TranslateError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Picks the engine for a pair, in the order given: the first one ready to translate; when none is,
 * the first that needs a download (the person is asked first). Returns { engine, state } or null where
 * nothing translates.
 */
export async function pickEngine(engines, pair) {
  let later = null;
  for (const engine of engines.filter(Boolean)) {
    const state = await engine.state(pair);
    if (state === 'ready') return { engine, state };
    if (state === 'download' && !later) later = { engine, state };
  }
  return later;
}

/** Translates a passage with an engine that is ready: pieces in, the text with its paragraphs out. */
export async function translateWith(engine, pair, text) {
  const pieces = splitText(text, engine.maxPiece ?? 400);
  if (!pieces.length) return '';
  const out = await engine.translate(pair, pieces.map((p) => p.text));
  return joinPieces(pieces, out);
}

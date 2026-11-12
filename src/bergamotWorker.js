// The offline translator's worker (src/bergamot.js starts it): Firefox's Bergamot, the WebAssembly and a
// model per direction, translating one piece at a time off the page's thread. build.mjs puts the glue
// (src/vendor/bergamot/bergamot-translator.js, which defines loadBergamot) in front of this code.
//
// Messages in: { id, base, wasm, pair, files: { model, lex, vocab }, texts }; base is where the files
// are served (…/translate-files/). Out: { id, texts } or { id, error }.

/* global loadBergamot */

const ALIGN = { model: 256, lex: 64, vocab: 64 };
// Marian's settings as Firefox gives them (translations-engine.worker.js), in its whitespace
const CONFIG = {
  'beam-size': '1',
  normalize: '1.0',
  'word-penalty': '0',
  'max-length-break': '128',
  'mini-batch-words': '1024',
  workspace: '128',
  'max-length-factor': '2.0',
  'skip-cost': 'true',
  'cpu-threads': '0',
  quiet: 'true',
  'quiet-translation': 'true',
  'gemm-precision': 'int8shiftAlphaAll',
  alignment: 'soft',
};
const configText = () => {
  const indent = '            ';
  return `\n${Object.entries(CONFIG).map(([key, value]) => `${indent}${key}: ${value}\n`).join('')}${indent}`;
};

let runtime = null; // Promise of the module
let service = null;
const models = new Map(); // pair → Promise of a TranslationModel

async function bytes(url) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`missing ${url}`);
  return res.arrayBuffer();
}

function start(base, wasm) {
  runtime ??= bytes(base + wasm).then(
    (wasmBinary) =>
      new Promise((resolve, reject) => {
        const module = loadBergamot({
          // it grows when it needs to; a phone should not have to find much at once
          INITIAL_MEMORY: 96 * 1024 * 1024,
          print: () => {},
          printErr: () => {},
          wasmBinary,
          onAbort: () => reject(new Error('Bergamot did not start')),
          onRuntimeInitialized: () => Promise.resolve().then(() => resolve(module)),
        });
      }),
  );
  runtime.catch(() => (runtime = null));
  return runtime;
}

function modelFor(bergamot, base, pair, files) {
  if (!models.has(pair)) {
    const job = Promise.all(['model', 'lex', 'vocab'].map((kind) => bytes(base + files[kind]))).then(([model, lex, vocab]) => {
      const aligned = (buffer, kind) => {
        const memory = new bergamot.AlignedMemory(buffer.byteLength, ALIGN[kind]);
        memory.getByteArrayView().set(new Uint8Array(buffer));
        return memory;
      };
      const vocabs = new bergamot.AlignedMemoryList();
      vocabs.push_back(aligned(vocab, 'vocab'));
      const [from, to] = pair.split('-');
      return new bergamot.TranslationModel(from, to, configText(), aligned(model, 'model'), aligned(lex, 'lex'), vocabs, null);
    });
    job.catch(() => models.delete(pair));
    models.set(pair, job);
  }
  return models.get(pair);
}

function translateOne(bergamot, model, text) {
  if (!text.trim()) return text;
  const messages = new bergamot.VectorString();
  const options = new bergamot.VectorResponseOptions();
  let responses = null;
  try {
    messages.push_back(text);
    options.push_back({ qualityScores: false, alignment: false, html: false });
    responses = service.translate(model, messages, options);
    return responses.get(0).getTranslatedText();
  } finally {
    messages.delete();
    options.delete();
    responses?.delete?.();
  }
}

self.onmessage = async ({ data }) => {
  const { id, base, wasm, pair, files, texts } = data ?? {};
  try {
    const bergamot = await start(base, wasm);
    service ??= new bergamot.BlockingService({ cacheSize: 0 });
    const model = await modelFor(bergamot, base, pair, files);
    self.postMessage({ id, texts: texts.map((text) => translateOne(bergamot, model, String(text))) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};

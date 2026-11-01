// The opus-mt translation models in the page (dist/translate.js, loaded the first time the Windows
// app translates without the browser's own translator). transformers.js runs them on the ONNX
// runtime's WebAssembly; the models and the runtime come from the local server, which downloaded them
// once into the data folder (server/translate.js) — nothing here reaches the network itself.

import { env, pipeline } from '@huggingface/transformers';

const base = (path) => new URL(path, location.href).href;
const onnx = env.backends.onnx;
const ortVersion = onnx.versions?.web ?? '';

env.allowRemoteModels = false;
env.allowLocalModels = true;
// a path, not a URL: transformers.js looks for optional files (the tokenizer's) only at a local path
env.localModelPath = '/translate-files/hf/';
env.useBrowserCache = false; // the files are on this computer already: no second copy in the browser
env.useWasmCache = false; // the runtime's .mjs is imported from the server as it is (no blob: script)
onnx.wasm.wasmPaths = {
  mjs: base(`translate-files/ort/${ortVersion}/ort-wasm-simd-threaded.asyncify.mjs`),
  wasm: base(`translate-files/ort/${ortVersion}/ort-wasm-simd-threaded.asyncify.wasm`),
};
onnx.wasm.numThreads = 1; // the page is not cross-origin isolated: no shared memory for threads
onnx.wasm.proxy = false;

window.AtlasTranslate = {
  ortVersion,
  /** pair: "ru-en" or "en-ru" → translate(text) → the translation. */
  async load(pair) {
    const translator = await pipeline('translation', `Xenova/opus-mt-${pair}`, { dtype: 'q8', device: 'wasm' });
    return async (text) => {
      const [result] = await translator(text, { max_new_tokens: 512 });
      return result?.translation_text ?? '';
    };
  },
};

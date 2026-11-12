// The files of the offline translator from Firefox (Bergamot, src/bergamot.js): its WebAssembly and the
// ru↔en models, as Firefox gets them from Mozilla's Remote Settings. Downloaded once, when the person
// agrees, by the local server (server/translate.js) or the Android app (TranslateFiles.java), each
// checked against its SHA-256. Only these files can be asked for.
//
// Versions: the WebAssembly of major version 2 goes with the glue in src/vendor/bergamot (Firefox
// ESR 140), which takes models of major version 1–2; these are version 2.1.

export const BERGAMOT_CDN = 'https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/';

export const BERGAMOT_FILES = {
  'bergamot/2.0/bergamot-translator.wasm': {
    at: 'translations-wasm/ec4aab08-4e7c-4a62-a7a5-ee6874a5d1a2.wasm',
    size: 4956176,
    sha256: 'e67e2f8be1a3fc0d9b00adce8b641cdf767bf3de90f1b3ccf732c2d711304fa3',
  },
  'bergamot/ru-en/2.1/model.ruen.intgemm.alphas.bin': {
    at: 'translations-models/20260901210056--9781ee2a-d15e-4fe8-893d-687193373fff--37b65106-c6cd-4ed2-a28e-3acd72725429.bin',
    size: 31561787,
    sha256: 'aa0efa194b3dbd2da129ba0b8db8ef139126cb0914e57072f62061294746f1e2',
  },
  'bergamot/ru-en/2.1/lex.50.50.ruen.s2t.bin': {
    at: 'translations-models/20260901210100--fd808a7b-0081-427d-83a5-7043bdd97a87--215ca362-0436-495d-b89d-542187b696cb.bin',
    size: 4397908,
    sha256: 'c944e753f298bbdf6506388de7257fb48cbd12c83e2807e2c284fc323771895b',
  },
  'bergamot/ru-en/2.1/vocab.ruen.spm': {
    at: 'translations-models/20260901210058--222363ca-4a98-48a9-9162-65acdffc2572--ba370dc8-709d-42cd-b68c-83b912bd3e38.spm',
    size: 952371,
    sha256: 'de8af5f87e231ee4016cec4bb482e6b584cb1ca34dcb624fc7b8398f25bb35df',
  },
  'bergamot/en-ru/2.1/model.enru.intgemm.alphas.bin': {
    at: 'translations-models/db6b48bb-b563-4ea1-bbf4-b033fa9cc482.bin',
    size: 31561787,
    sha256: '184cb5cda528eeefc0f75f5d0035d787b71d74af135e3c5608d01ae02ecfb920',
  },
  'bergamot/en-ru/2.1/lex.50.50.enru.s2t.bin': {
    at: 'translations-models/e88cc45c-0e0b-45d3-a957-8d1ba3a9b5aa.bin',
    size: 2774540,
    sha256: '4d91839726b960e70b6d05c53d0cffd16262832b1c0e1ea99d66f412dcc6a239',
  },
  'bergamot/en-ru/2.1/vocab.enru.spm': {
    at: 'translations-models/568807dd-9620-4c4d-a0b5-d651d64c0ab0.spm',
    size: 904455,
    sha256: '56ee63e14e8cb926c394242adc3ed7cc602644c3d33058cff2ce2959d52a6258',
  },
};

export const BERGAMOT_WASM = 'bergamot/2.0/bergamot-translator.wasm';

/** The model files of a direction ("en-ru"): { model, lex, vocab } → their paths. */
export function bergamotModel(pair) {
  const files = {};
  for (const rel of Object.keys(BERGAMOT_FILES)) {
    if (!rel.startsWith(`bergamot/${pair}/`)) continue;
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    files[name.startsWith('model.') ? 'model' : name.startsWith('lex.') ? 'lex' : 'vocab'] = rel;
  }
  return files.model && files.lex && files.vocab ? files : null;
}

/** Everything a direction needs: the WebAssembly and its model. */
export const bergamotPaths = (pair) => {
  const model = bergamotModel(pair);
  return model ? [BERGAMOT_WASM, model.model, model.lex, model.vocab] : [];
};

/** Where an allowed file comes from; null for anything else. */
export const bergamotUpstream = (rel) => (Object.hasOwn(BERGAMOT_FILES, rel) ? BERGAMOT_CDN + BERGAMOT_FILES[rel].at : null);

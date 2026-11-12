The translator Firefox uses (Bergamot: Marian compiled to WebAssembly), for translating without the
internet (src/bergamot.js).

- `bergamot-translator.js` — the Emscripten glue, unchanged, from Firefox ESR 140:
  `toolkit/components/translations/bergamot-translator/bergamot-translator.js`
  (https://github.com/mozilla-firefox/firefox, branch `esr140`; it says `v0.5.0+b475d25`).
  MPL-2.0, see `LICENSE-MPL-2.0.txt`.
- Its WebAssembly (major version 2, the one this glue goes with) and the ru↔en models (version 2.1)
  are not kept here: the app downloads them once from Mozilla's CDN, the same files Firefox gets from
  Remote Settings, and checks each against its SHA-256 (src/bergamotFiles.js).

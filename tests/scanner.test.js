import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const ANDROID = 'android/app/src/main';

const { scanNote } = await import('../src/scanner/note.js');
const { androidEngine, dispatch } = await import('../src/scanner/engine.js');

test('the scanner never goes to the network: no addresses, no network calls (page, Java, C++)', () => {
  const js = readdirSync(path.join(ROOT, 'src/scanner')).filter((f) => f.endsWith('.js')).map((f) => [`src/scanner/${f}`, read(`src/scanner/${f}`)]);
  for (const [file, code] of js) {
    // the SVG namespace is a name, not a place anything is fetched from
    assert.doesNotMatch(code.replaceAll("'http://www.w3.org/2000/svg'", ''), /https?:\/\//, `${file}: an address`);
    assert.doesNotMatch(code, /XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection/, `${file}: a network API`);
    // fetch only for the app's own files: pages from /scan/ and the licenses in the APK
    for (const call of code.matchAll(/fetch\(([^)]*)\)/g)) {
      assert.match(call[1], /^(?:url|result\.image|`\/scan\/\$\{id\}\.src`|'\/assets\/ocr\/NOTICE\.txt')$/, `${file}: fetch(${call[1]})`);
    }
  }
  for (const file of ['Scanner.java', 'OcrEngine.java']) {
    const code = read(`${ANDROID}/java/io/github/saint1406/atlastaker/${file}`);
    assert.doesNotMatch(code, /java\.net|HttpURLConnection|okhttp|Socket|https?:\/\//i, file);
  }
  for (const file of ['atlas_ocr.cpp', 'atlas_ocr_jni.cpp', 'atlas_ocr.h']) {
    const code = read(`${ANDROID}/cpp/${file}`);
    assert.doesNotMatch(code, /socket|curl|https?:\/\/(?!opensource\.org)/i, file);
  }
});

test('the models the scanner needs are all in the APK, and the native side asks for the same files', () => {
  const engine = read(`${ANDROID}/java/io/github/saint1406/atlastaker/OcrEngine.java`);
  const native = read(`${ANDROID}/cpp/atlas_ocr.cpp`);
  const shipped = readdirSync(path.join(ROOT, ANDROID, 'assets', 'ocr'));
  for (const name of ['PP_OCRv5_mobile_det.ncnn.param', 'PP_OCRv5_mobile_det.ncnn.bin', 'eslav_ppocrv5_rec.ncnn.param', 'eslav_ppocrv5_rec.ncnn.bin', 'ppocrv5_eslav_dict.txt']) {
    assert.ok(shipped.includes(name), `${name} is in assets/ocr`);
    assert.ok(engine.includes(`"${name}"`), `OcrEngine copies ${name}`);
    assert.ok(native.includes(name), `atlas_ocr.cpp loads ${name}`);
  }
  assert.ok(shipped.includes('NOTICE.txt'), 'the licenses travel with the models');
  // the recognizer has 519 classes: blank, the 517 letters of the dictionary, and the space
  const dict = read(`${ANDROID}/assets/ocr/ppocrv5_eslav_dict.txt`).split('\n').filter((l) => l.replace(/\r$/, ''));
  // the last layer before the softmax gives one score per class
  const gemms = [...read(`${ANDROID}/assets/ocr/eslav_ppocrv5_rec.ncnn.param`).matchAll(/^Gemm[^\n]* 8=(\d+)/gm)];
  const classes = Number(gemms.at(-1)[1]);
  assert.equal(classes, dict.length + 2);
});

test('the bridge: Java methods the page calls exist, and answers come back by id', () => {
  const activity = read(`${ANDROID}/java/io/github/saint1406/atlastaker/MainActivity.java`);
  const engine = read('src/scanner/engine.js');
  for (const method of new Set([...engine.matchAll(/android\.(scan\w+)\(/g)].map((m) => m[1]))) {
    assert.match(activity, new RegExp(`@JavascriptInterface\\s+public \\w+ ${method}\\(`), `MainActivity.${method}`);
  }
  assert.match(activity, /addPathHandler\("\/scan\/"/, 'pages are served from /scan/');
  assert.equal(androidEngine(null), null, 'no app, no engine');
  assert.equal(androidEngine({ scanInfo: () => '{"ok":false,"reason":"unsupported"}' }), null, 'a phone without the library');

  const calls = [];
  const bridge = {
    scanInfo: () => '{"ok":true,"engine":"test"}',
    scanBegin: (id) => calls.push(['begin', id]) && true,
    scanAppend: (id, b64) => calls.push(['append', id, b64.length]) && true,
    scanProcess: (id, options) => {
      calls.push(['process', id, JSON.parse(options)]);
      setTimeout(() => {
        dispatch({ id, stage: 'recognize' });
        dispatch({ id: 'someone-else', done: true, ok: false });
        dispatch({ id, done: true, ok: true, items: [], image: `/scan/${id}-1.jpg` });
      }, 0);
    },
  };
  const engineObj = androidEngine(bridge);
  assert.equal(engineObj.kind, 'android');
  const stages = [];
  const blob = new Blob([new Uint8Array(1000)], { type: 'image/jpeg' });
  return engineObj.process({ id: 'p1', blob, quad: [[0, 0], [1, 0], [1, 1], [0, 1]], rotate: 90 }, { onStage: (s) => stages.push(s) }).then((answer) => {
    assert.equal(answer.ok, true);
    assert.equal(answer.image, '/scan/p1-1.jpg');
    assert.deepEqual(stages, ['upload', 'recognize']);
    assert.deepEqual(calls[0], ['begin', 'p1']);
    assert.equal(calls[2][2].rotate, 90);
    assert.equal(calls[2][2].recognize, true);
  });
});

test('a scan as a note: a heading, the text with Markdown marks made harmless, the pictures', () => {
  const md = scanNote('Отчёт  за\nмарт', '# не заголовок\n> не цитата\nобычная строка', ['a-1.jpg', 'a-2.jpg'], ['Страница 1', 'Страница [2]']);
  assert.equal(md, '# Отчёт за март\n\n\\# не заголовок\n\\> не цитата\nобычная строка\n\n![Страница 1](assets/a-1.jpg)\n\n![Страница  2 ](assets/a-2.jpg)\n');
  assert.equal(scanNote('Пусто', '', []), '# Пусто\n');
});

test('the scanner is wired in: a button on the notes screen where it can run, the back button, styles built', () => {
  const app = read('src/app.js');
  assert.match(app, /onScan: scanEngine \? \(folder\) => openScanner\(folder\) : null/);
  assert.match(app, /if \(scanner\?\.back\(\)\) return true;/);
  assert.match(app, /scan: \(event\) => scanDispatch\(event\)/);
  assert.match(read('build.mjs'), /scanner: 'src\/scanner\/scanner\.css'/);
  const manifest = read(`${ANDROID}/AndroidManifest.xml`);
  assert.match(manifest, /android\.permission\.CAMERA/);
  assert.match(manifest, /android\.hardware\.camera" android:required="false"/);
  // the motion of the scanner gives way like the rest of the app
  const css = read('src/scanner/scanner.css');
  assert.match(css, /:root\[data-motion="off"\] \.scan/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /var\(--ease-emph/);
});

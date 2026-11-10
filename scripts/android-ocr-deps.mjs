// The scanner's native libraries for the Android build: ncnn (runs the models) and opencv-mobile
// (cuts lines out), prebuilt for Android by their authors. Downloaded once into
// android/app/src/main/cpp/third_party/ and checked against the SHA-256 written here, so a build never
// takes a changed file. Also checks the OCR models that ship in the APK (android/app/src/main/assets/ocr).
// CI runs it before Gradle; locally: node scripts/android-ocr-deps.mjs.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPS = path.join(ROOT, 'android', 'app', 'src', 'main', 'cpp', 'third_party');
const MODELS = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'ocr');

// ncnn 20261020 is the version the models were checked with (docs/scanner-ocr.md): the recognizer's
// 1-D convolutions use a path newer ncnn may drop, so a newer one must be checked before it goes here.
const LIBRARIES = [
  {
    name: 'ncnn',
    url: 'https://github.com/Tencent/ncnn/releases/download/20261020/ncnn-20261020-android.zip',
    sha256: '62a9edb493ceb42a5c9cbf2d3a79b3f44bff06c625134ffb64d183dcc42c25fc',
    folder: 'ncnn-20261020-android',
  },
  {
    name: 'opencv-mobile',
    url: 'https://github.com/nihui/opencv-mobile/releases/download/v34/opencv-mobile-4.12.0-android.zip',
    sha256: 'd2561021f763ec45b81ebf20681460f9bbcde5c97ac0af9a367c1e3c82caf56a',
    folder: 'opencv-mobile-4.12.0-android',
  },
];

// PaddleOCR v5 mobile detector and East Slavic recognizer, converted to ncnn (from DroidOCR,
// commit 3e29dfcb183345a8761bb97be67c35dec077e66c); Apache-2.0
export const MODEL_FILES = {
  'PP_OCRv5_mobile_det.ncnn.param': '358f459680ae0e7a73e477469e529ce116f68c629019ec7a0b6457d2d9117934',
  'PP_OCRv5_mobile_det.ncnn.bin': '857a96bc963725105b78a178dfcc3c0c3db1a7b9eef32244367b2cb105ccf60b',
  'eslav_ppocrv5_rec.ncnn.param': 'b97bcb996eeb27971bad8c7e7fcfc142cb3b50e6623fc522a41fe81cd2ab04fe',
  'eslav_ppocrv5_rec.ncnn.bin': 'b530de10b75d051a688e160f09b209a968a59352fa2dd9d21133abeb4689edf9',
  'ppocrv5_eslav_dict.txt': '3e95f1581557162870cacdba5af91a4c6be2890710d395b0c3c7578e7ee5e6eb',
};

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function checkModels() {
  for (const [name, want] of Object.entries(MODEL_FILES)) {
    const file = path.join(MODELS, name);
    if (!fs.existsSync(file)) throw new Error(`нет модели ${name} в ${MODELS}`);
    const got = sha256(file);
    if (got !== want) throw new Error(`модель ${name} изменилась: ${got}, ожидался ${want}`);
  }
}

async function fetchLibrary({ name, url, sha256: want, folder }) {
  const target = path.join(DEPS, name);
  const stamp = path.join(target, '.sha256');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === want) return false;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ocr-'));
  try {
    const zip = path.join(tmp, `${name}.zip`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    fs.writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
    const got = sha256(zip);
    if (got !== want) throw new Error(`${name}: SHA-256 ${got}, ожидался ${want}`);
    // unzip on Linux and macOS; Windows 10+ has bsdtar, which reads zip (Git's GNU tar, often first
    // on PATH, does not: hence the full path)
    if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', tmp]);
    else execFileSync('unzip', ['-q', zip, '-d', tmp]);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(DEPS, { recursive: true });
    fs.renameSync(path.join(tmp, folder), target);
    fs.writeFileSync(stamp, want);
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkModels();
    for (const lib of LIBRARIES) console.log(`${lib.name}: ${(await fetchLibrary(lib)) ? 'загружена и проверена' : 'уже на месте'}`);
    console.log(`модели OCR проверены (${Object.keys(MODEL_FILES).length} файлов)`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

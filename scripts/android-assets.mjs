// Puts the page into the Android app: android/app/src/main/assets/www gets the same files the local
// server serves (index.html, dist/ and the icon). Run after `npm run build`; CI then runs Gradle.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www');

for (const built of ['app.js', 'reader.js', 'styles.css']) {
  if (!fs.existsSync(path.join(ROOT, 'dist', built))) {
    console.error(`Нет dist/${built}: сначала npm run build`);
    process.exit(1);
  }
}

fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(path.join(WWW, 'assets'), { recursive: true });
// the app talks to Google Drive from the page (sync, src/sync/android.js); the desktop page does not
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const androidHtml = html.replace("connect-src 'self'", "connect-src 'self' https://www.googleapis.com");
if (androidHtml === html) {
  console.error('index.html: connect-src не найден, синхронизация на Android не сможет достучаться до Google Диска');
  process.exit(1);
}
fs.writeFileSync(path.join(WWW, 'index.html'), androidHtml);
// dist/translate.js (the opus-mt translator of the Windows app) stays out: the phone translates with ML Kit
const translatorCode = path.join(ROOT, 'dist', 'translate.js');
fs.cpSync(path.join(ROOT, 'dist'), path.join(WWW, 'dist'), { recursive: true, filter: (src) => path.resolve(src) !== translatorCode });
fs.copyFileSync(path.join(ROOT, 'assets', 'icon.png'), path.join(WWW, 'assets', 'icon.png'));

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`страница для Android в ${WWW} — ${(size(WWW) / 1024 / 1024).toFixed(1)} МБ`);

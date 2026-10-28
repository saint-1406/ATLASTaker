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
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(WWW, 'index.html'));
fs.cpSync(path.join(ROOT, 'dist'), path.join(WWW, 'dist'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'assets', 'icon.png'), path.join(WWW, 'assets', 'icon.png'));

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`страница для Android в ${WWW} — ${(size(WWW) / 1024 / 1024).toFixed(1)} МБ`);

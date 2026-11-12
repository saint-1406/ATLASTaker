// Lays out what the installer ships: the built app (no node_modules — the server needs only Node's
// own modules) and the Node runtime it runs on. Output: out/stage/app and out/stage/node.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appFiles, serverSources } from './appFiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.env.ATLAS_STAGE ? path.resolve(process.env.ATLAS_STAGE) : path.join(ROOT, 'out', 'stage');
// the interface, the server, and the src/ modules the server imports (found by following its imports)
const APP_FILES = appFiles(ROOT);

if (!fs.existsSync(path.join(ROOT, 'dist', 'app.js'))) {
  console.error('Нет сборки интерфейса: сначала npm run build');
  process.exit(1);
}
const { missing } = serverSources(ROOT);
if (missing.length) {
  console.error(`Сервер импортирует файлы, которых нет:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

fs.rmSync(STAGE, { recursive: true, force: true });
for (const entry of APP_FILES) {
  fs.cpSync(path.join(ROOT, entry), path.join(STAGE, 'app', entry), { recursive: true });
}

const nodeDir = path.join(STAGE, 'node');
fs.mkdirSync(nodeDir, { recursive: true });
fs.copyFileSync(process.execPath, path.join(nodeDir, path.basename(process.execPath)));
const license = path.join(path.dirname(process.execPath), 'LICENSE');
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(nodeDir, 'LICENSE'));

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
console.log(`ATLAS ${version} разложен в ${STAGE} (Node ${process.version})`);

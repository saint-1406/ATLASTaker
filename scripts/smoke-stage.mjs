// Starts the staged app (out/stage, or ATLAS_STAGE) the way an installed one starts: its own server
// from its own files, on an empty folder of its own, and asks it who it is. A module left out of the
// stage, or anything else that stops the server at start, fails the build here instead of on the
// person's computer. Run it with the staged Node: out/stage/node/node.exe scripts/smoke-stage.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.env.ATLAS_STAGE ? path.resolve(process.env.ATLAS_STAGE) : path.join(ROOT, 'out', 'stage');
const { version } = JSON.parse(fs.readFileSync(path.join(STAGE, 'app', 'package.json'), 'utf8'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-stage-'));

try {
  // the launcher loads server.js first, and through it every module the server has
  const { createAtlasServer } = await import(pathToFileURL(path.join(STAGE, 'app', 'server', 'server.js')).href);
  const app = await createAtlasServer({ dataDir, port: 0 });
  try {
    const hello = await (await fetch(`${app.url}api/hello`)).json();
    if (hello.version !== version) throw new Error(`the staged server says ${hello.version}, the stage holds ${version}`);
    const page = await fetch(app.url);
    if (!page.ok) throw new Error(`the page answers ${page.status}`);
    console.log(`the staged app ${version} starts and answers`);
  } finally {
    await app.close();
  }
} catch (err) {
  console.error(`The staged app does not start: ${err.stack ?? err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

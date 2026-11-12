import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appFiles, importsOf, serverSources } from '../scripts/appFiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the installer holds every module of src/ the server imports, and those they import', () => {
  const { files, missing } = serverSources(ROOT);
  assert.deepEqual(missing, [], 'no import points at a file that is not there');
  // src/versionRules.js was left out of 0.17.0 to 0.19.8: the installed app stopped at its start
  for (const needed of ['src/versionRules.js', 'src/marks.js', 'src/sync/merge.js', 'src/sync/engine.js', 'src/sync/drive.js', 'src/bergamotFiles.js']) {
    assert.ok(files.includes(needed), `${needed} goes into the installer`);
  }
  assert.ok(!files.includes('src/sync/client.js'), 'what only the page uses stays out (it is in the built bundle)');
  for (const file of files) assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
  assert.deepEqual(appFiles(ROOT).slice(0, 5), ['index.html', 'package.json', 'dist', 'assets', 'server']);
});

test('every relative import of a staged module is staged too', () => {
  const staged = new Set(serverSources(ROOT).files.map((f) => path.join(ROOT, f)));
  const inServer = (file) => file.startsWith(path.join(ROOT, 'server') + path.sep);
  for (const file of staged) {
    for (const target of importsOf(file)) assert.ok(staged.has(target) || inServer(target), `${path.relative(ROOT, file)} imports ${path.relative(ROOT, target)}`);
  }
});

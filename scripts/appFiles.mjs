// What the installed app (MSI and portable) holds besides Node: the built interface, the server, and
// every module of src/ the server imports, followed through their own imports. The list of src files
// is found, not written by hand: 0.17.0 added an import to server/store.js that a hand-made list did
// not have, and the app stopped at its first line on every computer.

import fs from 'node:fs';
import path from 'node:path';

export const BASE_FILES = ['index.html', 'package.json', 'dist', 'assets', 'server'];

// import … from './x.js', export … from './x.js', import './x.js', import('./x.js'): relative ones only
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)['"](\.{1,2}\/[^'"]+)['"]/gm;

/** The relative modules a file imports, as absolute paths. */
export function importsOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(IMPORT_RE)].map((m) => path.resolve(path.dirname(file), m[1]));
}

function serverFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return serverFiles(full);
    return /\.(m?js)$/.test(entry.name) ? [full] : [];
  });
}

/**
 * The files of src/ the server needs, relative to the root ("src/marks.js", …), sorted; and any
 * import that points at a file that does not exist (`missing`), so a build can stop on it.
 */
export function serverSources(root) {
  const src = path.join(root, 'src') + path.sep;
  const seen = new Set();
  const missing = [];
  const queue = serverFiles(path.join(root, 'server'));
  while (queue.length) {
    const file = queue.pop();
    for (const target of importsOf(file)) {
      if (!fs.existsSync(target)) {
        missing.push(`${path.relative(root, file)} → ${path.relative(root, target)}`);
        continue;
      }
      if (!target.startsWith(src) || seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  const files = [...seen].map((file) => path.relative(root, file).split(path.sep).join('/')).sort();
  return { files, missing };
}

/** Everything the installed app holds, relative to the root. */
export function appFiles(root) {
  return [...BASE_FILES, ...serverSources(root).files];
}

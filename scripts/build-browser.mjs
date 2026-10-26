// The browser build: the whole app in one HTML file — script, styles, icon and fonts inlined — that
// opens with a double click, with no server and no Node. Its notes live in the browser (IndexedDB).
//
//   node scripts/build-browser.mjs            → out/browser/ATLAS-Notetaker.html
//   node scripts/build-browser.mjs --install  → and a copy in %LOCALAPPDATA%\ATLAS Notetaker\browser

import * as esbuild from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out', 'browser', 'ATLAS-Notetaker.html');
export const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ATLAS Notetaker', 'browser');

// Fonts become data: URLs. Only the alphabets the notes use (Latin and Cyrillic) are embedded; other
// subsets and the .woff fallbacks (every current browser reads .woff2) are left empty.
const trimFonts = {
  name: 'trim-fonts',
  setup(build) {
    build.onLoad({ filter: /\.woff2?$/ }, async (args) => {
      const wanted = args.path.endsWith('.woff2') && /-(latin|latin-ext|cyrillic|cyrillic-ext)-/.test(path.basename(args.path));
      return { contents: wanted ? await fs.promises.readFile(args.path) : new Uint8Array(0), loader: 'dataurl' };
    });
  },
};

const common = {
  bundle: true,
  write: false,
  minify: true,
  legalComments: 'none',
  target: ['chrome120'],
  outdir: path.join(ROOT, 'out', 'browser', 'parts'),
};
const [js, css] = await Promise.all([
  esbuild.build({ ...common, entryPoints: [path.join(ROOT, 'src', 'app.js')], format: 'iife', loader: { '.md': 'text' } }),
  esbuild.build({ ...common, entryPoints: [path.join(ROOT, 'src', 'styles.css')], plugins: [trimFonts] }),
]);

// An inline script must not contain "</script", or the HTML parser would end it early.
const script = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const style = css.outputFiles[0].text.replace(/<\/style/gi, '<\\/style');
const scriptHash = crypto.createHash('sha256').update(script, 'utf8').digest('base64');
const icon = fs.readFileSync(path.join(ROOT, 'assets', 'icon.png')).toString('base64');

// Only this exact script may run, and the page may not talk to the network at all.
const csp = [
  "default-src 'none'",
  `script-src 'sha256-${scriptHash}'`,
  "style-src 'unsafe-inline'",
  'font-src data:',
  'img-src data: blob:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const swap = (pattern, replacement) => {
  if (!pattern.test(html)) throw new Error(`index.html has no ${pattern}`);
  html = html.replace(pattern, () => replacement);
};
swap(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
swap(/<link rel="icon"[^>]*>/, `<link rel="icon" href="data:image/png;base64,${icon}">`);
swap(/<link rel="stylesheet" href="dist\/styles\.css">/, `<style>${style}</style>`);
swap(/<script src="dist\/app\.js"><\/script>/, `<script>${script}</script>`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`${OUT} — ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} МБ`);

if (process.argv.includes('--install')) {
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.copyFileSync(OUT, path.join(INSTALL_DIR, 'ATLAS-Notetaker.html'));
  fs.copyFileSync(path.join(ROOT, 'assets', 'icon.ico'), path.join(INSTALL_DIR, 'icon.ico'));
  console.log(`установлено в ${INSTALL_DIR}`);
}

// Bundles the renderer into dist/: app.js (the notes: app code, CodeMirror with its languages),
// reader.js (the library's reader with pdf.js, loaded only when a document is opened), styles.css
// with the fonts. Served by the local server and packed into the Android app.
import * as esbuild from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');

// pdf.js parses in a worker; its code goes into reader.js as text and starts from a blob: URL.
// A classic script, not a module: a page opened from a file (the browser build) may not start a
// module worker from a blob. (scripts/build-browser.mjs has the same plugin.)
const workerAsText = {
  name: 'pdf-worker-as-text',
  setup(build) {
    build.onLoad({ filter: /pdf\.worker(\.min)?\.mjs$/ }, async (args) => {
      const worker = await esbuild.build({ entryPoints: [args.path], bundle: true, format: 'iife', minify: true, write: false, target: ['chrome120'], legalComments: 'none', logLevel: 'error' });
      return { contents: worker.outputFiles[0].text, loader: 'text' };
    });
  },
};

const options = {
  entryPoints: { app: 'src/app.js', reader: 'src/reader/index.js', styles: 'src/styles.css' },
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  target: ['chrome120'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  loader: { '.woff2': 'file', '.woff': 'file', '.md': 'text' },
  assetNames: 'assets/[name]-[hash]',
  plugins: [workerAsText],
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}

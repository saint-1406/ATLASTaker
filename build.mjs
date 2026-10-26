// Bundles the renderer (app code, CodeMirror with its languages, fonts) into dist/
// for both the Electron window and the browser preview.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: { app: 'src/app.js', styles: 'src/styles.css' },
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  target: ['chrome120'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  loader: { '.woff2': 'file', '.woff': 'file', '.md': 'text' },
  assetNames: 'assets/[name]-[hash]',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}

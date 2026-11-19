import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LOGO_PATHS, LOGO_VIEWBOX } from '../src/logo.js';

test('the emblem on the screens is the one the icons are drawn from (assets/logo.svg)', () => {
  const svg = fs.readFileSync(new URL('../assets/logo.svg', import.meta.url), 'utf8');
  assert.equal(svg.match(/viewBox="([^"]+)"/)[1], LOGO_VIEWBOX);
  assert.deepEqual([...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]), LOGO_PATHS);
});

test('the emblem uses only what scripts/make-icon.mjs can draw: M, L, C and Z', () => {
  for (const d of LOGO_PATHS) assert.match(d, /^M[\d. LCZM-]+Z$/);
});

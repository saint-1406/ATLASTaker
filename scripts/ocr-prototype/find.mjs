import fs from 'node:fs';
import { findPage, scaleQuad } from '../../src/scanner/geometry.js';
const pages = process.argv[2];
for (const f of fs.readdirSync(pages).filter((f) => f.endsWith('.gray'))) {
  const name = f.slice(0, -5);
  const meta = JSON.parse(fs.readFileSync(`${pages}/${name}.gray.json`));
  const gray = new Uint8Array(fs.readFileSync(`${pages}/${f}`));
  const t0 = performance.now();
  const found = findPage(gray, meta.w, meta.h);
  const ms = performance.now() - t0;
  const quad = found.quad && scaleQuad(found.quad, 1 / meta.k);
  const truth = JSON.parse(fs.readFileSync(`${pages}/${name}.quad.json`)).quad;
  const err = quad ? Math.max(...quad.map((p, i) => Math.hypot(p.x - truth[i][0], p.y - truth[i][1]))) : NaN;
  console.log(name, 'confidence', found.confidence, 'max corner error px (of 3000x4000)', err.toFixed(1), `${ms.toFixed(0)}ms`);
  fs.writeFileSync(`${pages}/${name}.found.json`, JSON.stringify(quad.map((p) => [p.x, p.y])));
}

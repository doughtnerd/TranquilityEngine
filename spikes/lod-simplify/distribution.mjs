// Item 1: distribution facts for the npm `meshoptimizer` package: version, licence, sizes (minified + gzip), Node 22 + Chromium smoke.
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { startServer } from './lib/serve.mjs';
import { launchChromium } from './lib/browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(here, 'node_modules', 'meshoptimizer');
const pkg = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8'));

async function sizes(file) {
  const src = await readFile(path.join(pkgDir, file));
  const out = await build({ entryPoints: [path.join(pkgDir, file)], bundle: true, minify: true, format: 'esm', write: false, legalComments: 'none' });
  const min = out.outputFiles[0].contents;
  return { file, raw: src.length, minified: min.length, minGzip: gzipSync(min, { level: 9 }).length, minBrotliEst: null };
}

// size of the *decoded* wasm payload: capture what the module hands to WebAssembly.instantiate
async function wasmBytes(file) {
  const orig = WebAssembly.instantiate; let size = 0;
  WebAssembly.instantiate = function (src, ...rest) { size = src.byteLength ?? src.length; return orig.call(this, src, ...rest); };
  try { await import(path.join(pkgDir, file) + '?w=' + Math.random()); await new Promise((r) => setTimeout(r, 200)); } finally { WebAssembly.instantiate = orig; }
  return size;
}

const files = ['meshopt_simplifier.js', 'meshopt_encoder.js', 'meshopt_decoder.mjs'];
const modules = [];
for (const f of files) { const s = await sizes(f); s.wasmDecoded = await wasmBytes(f); modules.push(s); }
const both = await build({ stdin: { contents: `export * from '${path.join(pkgDir, 'meshopt_simplifier.js')}'; export * from '${path.join(pkgDir, 'meshopt_encoder.js')}';`, resolveDir: here }, bundle: true, minify: true, format: 'esm', write: false, legalComments: 'none' });
const combined = { files: 'simplifier + encoder', minified: both.outputFiles[0].contents.length, minGzip: gzipSync(both.outputFiles[0].contents, { level: 9 }).length };

// Node 22: ESM import and require(esm), run unchanged
const nodeSmoke = (code, esm) => execFileSync('node', esm ? ['--input-type=module', '-e', code] : ['-e', code], { cwd: here, encoding: 'utf8' }).trim();
const smokeBody = `const S = m.MeshoptSimplifier; await_ready; `;
const esmCode = `import { MeshoptSimplifier as S, MeshoptEncoder as E } from 'meshoptimizer'; await S.ready; await E.ready;
const idx = new Uint32Array([0,1,2,2,1,3]); const pos = new Float32Array([0,0,0,1,0,0,0,1,0,1,1,0]);
const r = S.simplify(idx, pos, 3, 3, 1); console.log(JSON.stringify({ node: process.version, supported: S.supported && E.supported, outTris: r[0].length / 3 }));`;
const cjsCode = `const m = require('meshoptimizer'); const S = m.MeshoptSimplifier; S.ready.then(() => console.log(JSON.stringify({ node: process.version, requireEsm: true, supported: S.supported })));`;
let nodeEsm, nodeCjs;
try { nodeEsm = JSON.parse(nodeSmoke(esmCode, true)); } catch (e) { nodeEsm = { error: String(e.message).slice(0, 200) }; }
try { nodeCjs = JSON.parse(nodeSmoke(cjsCode, false)); } catch (e) { nodeCjs = { error: String(e.message).slice(0, 200) }; }

// Chromium via Playwright
let chromium;
{
  const { server, port } = await startServer();
  try {
    const { browser, playwrightVersion } = await launchChromium();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/bench.html`);
    chromium = await page.evaluate(async () => {
      const { MeshoptSimplifier: S } = await import('./node_modules/meshoptimizer/meshopt_simplifier.js');
      const { MeshoptEncoder: E } = await import('./node_modules/meshoptimizer/meshopt_encoder.js');
      await S.ready; await E.ready;
      const r = S.simplify(new Uint32Array([0, 1, 2, 2, 1, 3]), new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3, 3, 1);
      return { ua: navigator.userAgent, supported: S.supported && E.supported, outTris: r[0].length / 3 };
    });
    chromium.playwrightVersion = playwrightVersion; await browser.close();
  } catch (e) { chromium = { error: String(e.message).slice(0, 300) }; }
  server.close();
}

export const distribution = { npm: { name: pkg.name, version: pkg.version, license: pkg.license }, modules, combined, nodeEsm, nodeCjs, chromium };
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(distribution, null, 1));

// Runs the Rust `meshopt` 0.7.0 -> wasm32 build (see Cargo.toml/src/lib.rs, build.sh) against the npm build on the same mesh.
import { readFile } from 'node:fs/promises';
import { MeshoptSimplifier as S } from '../node_modules/meshoptimizer/meshopt_simplifier.js';
import { makeRock } from '../lib/gen.mjs';
import { weld } from '../lib/mesh.mjs';

const wasmPath = process.argv[2] || '/tmp/claude-0/cargo-target/wasm32-unknown-unknown/release/mw.wasm';
const bytes = await readFile(wasmPath);
const mod = await WebAssembly.compile(bytes);
const imports = WebAssembly.Module.imports(mod);
const instance = await WebAssembly.instantiate(mod, Object.fromEntries([...new Set(imports.map((i) => i.module))].map((m) => [m, Object.fromEntries(imports.filter((i) => i.module === m).map((i) => [i.name, () => { throw new Error('unexpected import ' + i.name); }]))])));
const ex = instance.exports;
await S.ready;
const m = weld(makeRock());
const target = m.indices.length / 8 / 3 * 3 | 0;
const t = target - (target % 3);

const nv = m.positions.length / 3;
const mem = () => new Uint8Array(ex.memory.buffer);
const run = () => {
  const pIdx = ex.walloc(m.indices.length * 4), pPos = ex.walloc(m.positions.length * 4), pOut = ex.walloc(m.indices.length * 4);
  mem().set(new Uint8Array(m.indices.buffer), pIdx); mem().set(new Uint8Array(m.positions.buffer), pPos);
  const n = ex.simp(pIdx, m.indices.length, pPos, nv, t, 1.0, pOut);
  return n;
};
const times = [];
let n = 0;
for (let i = 0; i < 8; i++) { const t0 = performance.now(); n = run(); times.push(performance.now() - t0); }
const times2 = [];
let r;
for (let i = 0; i < 8; i++) { const t0 = performance.now(); r = S.simplify(m.indices, m.positions, 3, t, 1.0, []); times2.push(performance.now() - t0); }
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
console.log(JSON.stringify({ wasmBytes: bytes.length, imports: imports.map((i) => `${i.module}.${i.name}`), rustTris: n / 3, npmTris: r[0].length / 3, target: t / 3, rustMedianMs: +med(times).toFixed(2), npmMedianMs: +med(times2).toFixed(2) }));

// Builds the scenes and stand-ins, measures import cost and error, writes out/scenes.bin (an f32 stream read by the Rust
// harness) and out/meta.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildScenes, FRAMES } from './lib/scenes.mjs';
import { ready, makeStandins, TYPES } from './lib/standins.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });
const quick = process.argv.includes('--quick');

await ready();
const scenes = buildScenes();
const words = [];
const push = (...a) => { for (const x of a) words.push(x); };
const pushArr = (arr) => { for (let i = 0; i < arr.length; i++) words.push(arr[i]); };
const meta = { frames: FRAMES, types: TYPES, scenes: [], occluders: [] };

push(scenes.length);
for (const sc of scenes) {
  push(sc.occluders.length, sc.occludees.length, sc.paths.length);
  meta.scenes.push({ name: sc.name, occludees: sc.occludees.length, paths: sc.paths.map((p) => p.name) });
  sc.occluders.forEach((o) => {
    const st = makeStandins(o, quick ? 3000 : 15000);
    meta.occluders.push({
      scene: sc.name, name: o.name, kind: o.kind, verts: o.positions.length / 3, tris: st.nOrig, diag: st.diag, exempt: st.exempt, simplifyMs: st.simplifyMs,
      types: Object.fromEntries(TYPES.map((k) => { const t = st.types[k]; return [k, { tris: t.tris, errFrac: t.errFrac, fwdFrac: t.fwdFrac, revFrac: t.revFrac, errWorld: t.err, hausMs: t.hausMs, triErrMs: t.triErrMs, triSamples: t.triSamples, denseFrac: t.denseFrac, denseMs: t.denseMs }]; })),
    });
    // bounds of the original
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < o.positions.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], o.positions[i + k]); mx[k] = Math.max(mx[k], o.positions[i + k]); }
    push(o.positions.length / 3, st.diag, ...mn, ...mx);
    pushArr(o.positions);
    for (const k of TYPES) { const t = st.types[k]; push(t.tris, t.err); pushArr(t.indices); pushArr(t.triErr); }
  });
  pushArr(sc.occludees.flat());
  for (const p of sc.paths) { push(p.frames.length); for (const f of p.frames) push(...f.eye, ...f.target); }
}
writeFileSync(join(outDir, 'scenes.bin'), Buffer.from(new Float32Array(words).buffer));
writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 1));
console.log(`scenes.bin: ${(words.length * 4 / 1e6).toFixed(1)} MB, ${meta.occluders.length} occluders`);
for (const o of meta.occluders) {
  console.log(`${o.scene}/${o.name} ${o.tris} tris${o.exempt ? ' (exempt)' : ''}: ` + TYPES.slice(1).map((k) => `${k} ${o.types[k].tris}t err ${(o.types[k].errFrac * 100).toFixed(2)}% ${o.types[k].hausMs.toFixed(0)}ms (dense ${(o.types[k].denseFrac * 100).toFixed(2)}%) tri-err ${o.types[k].triErrMs.toFixed(0)}ms`).join(' | '));
}

// Speed benchmark. Environment-agnostic ES module: runs unchanged in Node 22 and in Chromium (imported by bench.html).
import { MeshoptSimplifier as S } from './node_modules/meshoptimizer/meshopt_simplifier.js';
import { MeshoptEncoder as E } from './node_modules/meshoptimizer/meshopt_encoder.js';
import { weld, triCount, vertCount, checkMesh } from './lib/mesh.mjs';
import { buildChain, simplifyLevel, attributeBuffer } from './lib/lod.mjs';
import { optimizeLevel } from './lib/optimize.mjs';

export const RATIOS = [0.5, 0.25, 0.125];
export const SLOPPY_RATIOS = [0.05, 0.02];

function stats(a) {
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { runs: s.length, min: s[0], p50: q(0.5), p99: q(0.99), max: s[s.length - 1] };
}

function fnv(levels) {
  let h = 2166136261;
  for (const lv of levels) for (let i = 0; i < lv.indices.length; i++) { h ^= lv.indices[i]; h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

function validateLevels(m, levels, label) {
  const n = vertCount(m);
  for (const lv of levels) {
    for (let i = 0; i < lv.indices.length; i++) if (lv.indices[i] >= n) throw new Error(`${label}: index out of range`);
    if (lv.indices.length % 3) throw new Error(`${label}: index count not multiple of 3`);
    let c = 0; for (const g of lv.groups) c += g.count; if (c !== lv.indices.length) throw new Error(`${label}: groups`);
  }
}

const tasks = {
  weld: (ctx) => { weld(ctx.raw); },
  chainPos: (ctx) => { ctx.out.pos = buildChain(S, ctx.m, RATIOS, { mode: 'pos' }); },
  chainAttr: (ctx) => { ctx.out.attr = buildChain(S, ctx.m, RATIOS, { mode: 'attr' }); },
  chainAttrSkin: (ctx) => { buildChain(S, ctx.m, RATIOS, { mode: 'attr', useSkin: true }); },
  sloppy: (ctx) => {
    const lod0 = { indices: ctx.m.indices, groups: [{ start: 0, count: ctx.m.indices.length }] };
    ctx.out.sloppy = SLOPPY_RATIOS.map((r) => simplifyLevel(S, ctx.m, lod0, r, { mode: 'sloppy', perGroup: false, errorLimit: 1 }));
  },
  optimize: (ctx) => { for (const lv of ctx.out.attr) optimizeLevel(E, ctx.m, lv.indices, lv.groups); },
  total: (ctx) => {
    const w = weld(ctx.raw);
    const chain = buildChain(S, w, RATIOS, { mode: 'attr' });
    const lod0 = { indices: w.indices, groups: [{ start: 0, count: w.indices.length }] };
    SLOPPY_RATIOS.map((r) => simplifyLevel(S, w, lod0, r, { mode: 'sloppy', perGroup: false, errorLimit: 1 }));
    for (const lv of chain) optimizeLevel(E, w, lv.indices, lv.groups);
  },
};

/** models: [{name, kind, mesh, skinned}] -> results. now(): high resolution ms clock. */
export async function runSpeed(models, { runs = 7, now = () => performance.now(), log = () => {} } = {}) {
  await Promise.all([S.ready, E.ready]);
  const out = [];
  for (const e of models) {
    const raw = e.mesh; checkMesh(raw);
    const m = weld(raw); checkMesh(m);
    const ctx = { raw, m, out: {} };
    const row = { name: e.name, kind: e.kind, tris: triCount(m), verts: vertCount(m), rawVerts: vertCount(raw), groups: m.groups.length, skinned: !!m.joints, timings: {} };
    const names = Object.keys(tasks).filter((t) => t !== 'chainAttrSkin' || m.joints);
    // prerequisites for 'optimize'
    tasks.chainAttr(ctx);
    for (const t of names) {
      tasks[t](ctx); // warm-up (JIT, wasm tier-up, heap growth)
      const ts = [];
      for (let i = 0; i < runs; i++) { const t0 = now(); tasks[t](ctx); ts.push(now() - t0); }
      row.timings[t] = stats(ts);
      row.timings[t].trisPerSec = row.tris / (row.timings[t].p50 / 1000);
    }
    validateLevels(m, ctx.out.attr, e.name + ' attr'); validateLevels(m, ctx.out.pos, e.name + ' pos'); validateLevels(m, ctx.out.sloppy, e.name + ' sloppy');
    row.hash = { attr: fnv(ctx.out.attr), pos: fnv(ctx.out.pos), sloppy: fnv(ctx.out.sloppy) };
    row.levels = { attr: ctx.out.attr.map((l) => l.indices.length / 3), pos: ctx.out.pos.map((l) => l.indices.length / 3), sloppy: ctx.out.sloppy.map((l) => l.indices.length / 3) };
    log(`${e.name}: total p50 ${row.timings.total.p50.toFixed(1)} ms`);
    out.push(row);
  }
  return out;
}

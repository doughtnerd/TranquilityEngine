// Quality / size / skinning experiments (deterministic; run once, in Node). Everything is measured here, nothing estimated.
import { MeshoptSimplifier as S } from './node_modules/meshoptimizer/meshopt_simplifier.js';
import { MeshoptEncoder as E } from './node_modules/meshoptimizer/meshopt_encoder.js';
import { weld, deindex, weldPositions, triCount, vertCount, bboxOf } from './lib/mesh.mjs';
import { buildChain, simplifyLevel } from './lib/lod.mjs';
import { Bvh, hausdorff, attributeDeviation, edgeTopology, borderSegments, borderDeviation, acmr, fetchLines, fetchMisses } from './lib/metrics.mjs';
import { optimizeLevel, cacheOnly, indexBytes, BYTES_F32, BYTES_QUANT } from './lib/optimize.mjs';
import { makeRock2Mat, makeBuilding } from './lib/gen.mjs';
import { jointOrigins, makePose } from './lib/skin.mjs';
import { RATIOS, SLOPPY_RATIOS } from './bench.mjs';

const r4 = (x) => (Number.isFinite(x) ? +x.toPrecision(4) : x);
const sub = (m, indices) => ({ ...m, indices });
const targetTris = (m, ratio) => m.groups.reduce((s, g) => s + Math.round(ratio * g.count / 3), 0);

function hq(m, bvh, indices, withAttr = true) {
  const sm = sub(m, indices);
  const h = hausdorff(m, sm, bvh);
  const out = { fwdMean: r4(h.fwdMean), fwdMax: r4(h.fwdMax), revMean: r4(h.revMean), revMax: r4(h.revMax), max: r4(h.max), mean: r4(h.mean) };
  if (withAttr && indices.length) { const a = attributeDeviation(m, sm, bvh); out.nAngMean = r4(a.nMean); out.nAngP95 = r4(a.nP95); out.uvMean = r4(a.uvMean); out.uvP95 = r4(a.uvP95); }
  return out;
}
const openDelta = (m, base, indices) => edgeTopology(m.positions, indices).open - base.open;

/** Q1: three-level chain (pos and attr) + sloppy proxies, measured against LOD0. */
function q1(models, log) {
  const rows = [];
  for (const e of models) {
    const m = e.base, bvh = e.bvh, base = e.topo; log('q1 ' + e.name); const k = e.bbox.maxExt / e.bbox.diag;
    for (const mode of ['pos', 'attr']) {
      const chain = buildChain(S, m, RATIOS, { mode });
      let cum = 0;
      chain.forEach((lv, i) => {
        if (i === 0) return;
        const step = Math.max(...lv.errors); cum += step;
        rows.push({ model: e.name, mode, level: i, ratio: lv.ratio, targetTris: targetTris(m, lv.ratio), tris: lv.indices.length / 3, reached: r4(lv.indices.length / 3 / targetTris(m, lv.ratio)),
          meshoptErrStep: r4(step), meshoptErrCum: r4(cum), meshoptErrCumDiag: r4(cum * k), ...hq(m, bvh, lv.indices), openDelta: openDelta(m, base, lv.indices) });
      });
    }
    const lod0 = { indices: m.indices, groups: [{ start: 0, count: m.indices.length }] };
    for (const r of SLOPPY_RATIOS) {
      const lv = simplifyLevel(S, m, lod0, r, { mode: 'sloppy', perGroup: false });
      const tgt = Math.round(r * triCount(m));
      rows.push({ model: e.name, mode: 'sloppy', level: r, ratio: r, targetTris: tgt, tris: lv.indices.length / 3, reached: r4(lv.indices.length / 3 / tgt), meshoptErrStep: r4(lv.errors[0]), meshoptErrCum: r4(lv.errors[0]), meshoptErrCumDiag: r4(lv.errors[0] * k),
        ...hq(m, bvh, lv.indices), openDelta: openDelta(m, base, lv.indices) });
    }
  }
  return rows;
}

/** Q1b: chained vs each level from LOD0 (rock, tree, DamagedHelmet, terrain). */
function q1b(models, log) {
  const rows = [];
  for (const e of models.filter((x) => ['rock', 'tree', 'DamagedHelmet', 'terrain'].includes(x.name))) {
    log('q1b ' + e.name);
    for (const fromLod0 of [false, true]) {
      const chain = buildChain(S, e.base, RATIOS, { mode: 'attr', fromLod0 });
      const lv = chain[3];
      rows.push({ model: e.name, build: fromLod0 ? 'each level from LOD0' : 'chained', tris: lv.indices.length / 3, ...hq(e.base, e.bvh, lv.indices, false) });
    }
  }
  return rows;
}

/** Q2: error limit vs reach at ratio 0.125 (single step from LOD0, positions only, absolute error = limit * whole-mesh extent). */
function q2(models, log) {
  const rows = [];
  const limits = [1, 0.02, 0.01, 0.005, 0.002, 0.001];
  for (const e of models) {
    log('q2 ' + e.name);
    for (const lim of limits) {
      const lv = buildChain(S, e.base, [0.125], { mode: 'pos', errorLimit: lim })[1];
      const tgt = targetTris(e.base, 0.125);
      rows.push({ model: e.name, errorLimit: lim, targetTris: tgt, tris: lv.indices.length / 3, reached: r4(lv.indices.length / 3 / tgt), meshoptErr: r4(Math.max(...lv.errors)) });
    }
  }
  return rows;
}

/** Q3: flags (LockBorder, Permissive, Prune, Regularize) at ratio 0.125, error limit 2%. */
function q3(models, log) {
  const rows = [];
  const sets = [[], ['LockBorder'], ['Permissive'], ['Prune'], ['Regularize'], ['Permissive', 'Prune']];
  for (const e of models.filter((x) => ['rock', 'tree', 'building', 'terrain', 'ship'].includes(x.name))) {
    const m = e.base; const segO = borderSegments(m.positions, m.indices);
    for (const mode of ['pos', 'attr']) for (const flags of sets) {
      log(`q3 ${e.name} ${mode} ${flags}`);
      const lv = buildChain(S, m, [0.125], { mode, flags, errorLimit: 0.02 })[1];
      const tgt = targetTris(m, 0.125);
      const row = { model: e.name, mode, flags: flags.join('+') || 'none', targetTris: tgt, tris: lv.indices.length / 3, reached: r4(lv.indices.length / 3 / tgt), meshoptErr: r4(Math.max(...lv.errors)), ...hq(m, e.bvh, lv.indices, false), openDelta: openDelta(m, e.topo, lv.indices) };
      if (segO.length && segO.length < 3000) { const bd = borderDeviation(segO, borderSegments(m.positions, lv.indices)); row.borderMeanFrac = r4(bd.mean / e.bbox.diag); row.borderMaxFrac = r4(bd.max / e.bbox.diag); row.borderEdges = borderSegments(m.positions, lv.indices).length; row.borderEdges0 = segO.length; }
      rows.push(row);
    }
  }
  return rows;
}

/** Q4: material groups (submeshes) at ratio 0.25. */
function q4(models, log) {
  const rows = [];
  const rock = models.find((x) => x.name === 'rock2mat');
  for (const e of models.filter((x) => ['rock2mat', 'tree', 'ship', 'Lantern', 'FlightHelmet'].includes(x.name))) {
    const m = e.base; const tgt = targetTris(m, 0.25);
    const strategies = [
      ['whole mesh, one index range (materials lost)', { perGroup: false }],
      ['per submesh, no lock', { groupBorder: 'none' }],
      ['per submesh + LockBorder flag', { groupBorder: 'lockBorder' }],
      ['per submesh + vertex_lock on shared vertices', { groupBorder: 'vertexLock' }],
    ];
    for (const [name, o] of strategies) {
      log(`q4 ${e.name} ${name}`);
      const lv = buildChain(S, m, [0.25], { mode: 'attr', ...o })[1];
      const per = o.perGroup === false ? null : lv.groups.map((g, i) => g.count / 3 / Math.max(1, m.groups[i].count / 3));
      rows.push({ model: e.name, strategy: name, groups: m.groups.length, targetTris: tgt, tris: lv.indices.length / 3, reached: r4(lv.indices.length / 3 / tgt),
        groupRatioMin: per ? r4(Math.min(...per)) : null, groupRatioMax: per ? r4(Math.max(...per)) : null,
        sharedVertices: m.groups.length > 1 ? sharedCount(m) : 0, ...hq(m, e.bvh, lv.indices, false), openDelta: openDelta(m, e.topo, lv.indices) });
    }
  }
  void rock;
  return rows;
}
function sharedCount(m) { const first = new Int32Array(vertCount(m)).fill(-1); let c = 0; m.groups.forEach((g, gi) => { for (let k = g.start; k < g.start + g.count; k++) { const v = m.indices[k]; if (first[v] < 0) first[v] = gi; else if (first[v] !== gi && first[v] !== -2) { first[v] = -2; c++; } } }); return c; }

/** Q5: seams, split normals and welding at ratio 0.125 (positions only unless noted). */
function q5(models, log) {
  const rows = [];
  const bT = weld(makeBuilding({ conforming: false })); bT.name = 'building (T-junctions)';
  const set = models.filter((x) => ['building', 'rock', 'DamagedHelmet', 'Fox'].includes(x.name)).map((x) => ({ name: x.name, raw: x.raw, base: x.base, bvh: x.bvh, topo: x.topo }));
  set.push({ name: bT.name, raw: bT, base: bT, bvh: new Bvh(bT.positions, bT.indices), topo: edgeTopology(bT.positions, bT.indices) });
  for (const e of set) {
    const m = e.base; const tgt = targetTris(m, 0.125);
    const pw = weldPositions(m.positions, m.indices);
    const variants = [
      ['never welded (de-indexed soup)', deindex(m), {}],
      ['as imported (raw)', e.raw, {}],
      ['welded, seams kept (default)', m, {}],
      ['welded + Permissive', m, { flags: ['Permissive'] }],
      ['welded + Permissive, normals+uv weighted (attr mode)', m, { flags: ['Permissive'], mode: 'attr' }],
      ['welded, attributes ignored by position weld (no remap back)', { ...m, positions: pw.positions, indices: pw.indices, normals: new Float32Array(pw.unique * 3), uvs: new Float32Array(pw.unique * 2), groups: [{ start: 0, count: pw.indices.length }] }, {}],
    ];
    for (const [vname, vm, o] of variants) {
      log(`q5 ${e.name} ${vname}`);
      const mm = { ...vm, groups: [{ start: 0, count: vm.indices.length }] };
      const lv = buildChain(S, mm, [0.125], { mode: 'pos', ...o })[1];
      const h = hausdorff(m, { positions: vm.positions, indices: lv.indices }, e.bvh);
      const row = { model: e.name, variant: vname, verts: vertCount(vm), inTris: triCount(vm), targetTris: targetTris(mm, 0.125), tris: lv.indices.length / 3, reached: r4(lv.indices.length / 3 / (triCount(vm) * 0.125)), meshoptErr: r4(lv.errors[0]),
        haus: r4(h.max), openDelta: edgeTopology(vm.positions, lv.indices).open - e.topo.open };
      if (vm === m && lv.indices.length) { const a = attributeDeviation(m, sub(m, lv.indices), e.bvh); row.nAngMean = r4(a.nMean); row.uvMean = r4(a.uvMean); row.uvP95 = r4(a.uvP95); }
      rows.push(row);
    }
    void tgt;
  }
  return rows;
}

/** Q6: vertex cache/fetch optimisation, and buffer sizes of all levels vs LOD0 for separate and shared vertex buffers. */
function q6(models, log) {
  const rows = [];
  for (const e of models) {
    log('q6 ' + e.name);
    const m = e.base; const chain = buildChain(S, m, RATIOS, { mode: 'attr' });
    const bpv = BYTES_F32(m), bpq = BYTES_QUANT(m);
    const opt = chain.map((lv) => optimizeLevel(E, m, lv.indices, lv.groups));
    const size = (verts, idxCount, b) => verts * b + indexBytes(idxCount, verts);
    const sepBytes = (b) => opt.reduce((s, o) => s + size(o.unique, o.indices.length, b), 0);
    const lod0 = (b) => size(opt[0].unique, opt[0].indices.length, b);
    const sharedBytes = (b) => opt[0].unique * b + chain.reduce((s, lv) => s + indexBytes(lv.indices.length, opt[0].unique), 0);
    // shared vertex buffer in LOD0 order
    const sharedIdx = chain.map((lv) => { const re = new Uint32Array(lv.indices.length); for (let k = 0; k < re.length; k++) re[k] = opt[0].remap[lv.indices[k]]; return { indices: re, groups: lv.groups }; });
    const cachedShared = sharedIdx.map((s) => { const out = new Uint32Array(s.indices.length); for (const g of s.groups) { const part = s.indices.subarray(g.start, g.start + g.count); let mx = 0; for (let i = 0; i < part.length; i++) if (part[i] > mx) mx = part[i]; out.set(cacheOnly(E, part, mx + 1), g.start); } return out; });
    // shared vertex buffer ordered coarsest-first (vertices used by the coarsest level form a prefix)
    const nv = opt[0].unique; const last = new Int8Array(nv).fill(-1);
    sharedIdx.forEach((s, li) => { for (const v of s.indices) if (li > last[v]) last[v] = li; });
    const order = Array.from({ length: nv }, (_, i) => i).sort((a, b) => last[b] - last[a] || a - b);
    const perm = new Uint32Array(nv); order.forEach((old, nw) => { perm[old] = nw; });
    const prefixIdx = cachedShared.map((idx) => idx.map((v) => perm[v]));
    const lvlInfo = chain.map((lv, i) => {
      const own = opt[i].indices; const used = opt[i].unique;
      const sh = cachedShared[i]; const px = prefixIdx[i];
      const lines = (idx, b) => fetchLines(idx, b);
      return { level: i, tris: lv.indices.length / 3, usedVerts: used,
        acmrOwn: r4(acmr(own)), acmrShared: r4(acmr(sh)), acmrBefore: r4(acmr(lv.indices)),
        lines64Own: lines(own, bpv), lines64Shared: lines(sh, bpv), lines64Prefix: lines(px, bpv), minLines64: Math.ceil(used * bpv / 64),
        missOwn: fetchMisses(own, bpv), missShared: fetchMisses(sh, bpv), missPrefix: fetchMisses(px, bpv) };
    });
    rows.push({ model: e.name, tris0: triCount(m), verts0: nv, groups: m.groups.length, bytesPerVertexF32: bpv, bytesPerVertexQuant: bpq,
      lod0Bytes: lod0(bpv), separateBytes: sepBytes(bpv), sharedBytes: sharedBytes(bpv),
      separateOverLod0: r4(sepBytes(bpv) / lod0(bpv)), sharedOverLod0: r4(sharedBytes(bpv) / lod0(bpv)),
      separateOverLod0Quant: r4(sepBytes(bpq) / lod0(bpq)), sharedOverLod0Quant: r4(sharedBytes(bpq) / lod0(bpq)),
      levelVerts: opt.map((o) => o.unique), levels: lvlInfo });
  }
  return rows;
}

/** Q7: skinned meshes. */
function q7(models, log) {
  const rows = [];
  for (const e of models.filter((x) => x.skinned)) {
    log('q7 ' + e.name);
    const m = e.base; const origins = jointOrigins(e.doc); const nj = origins.length / 3;
    const bvh = e.bvh;
    const poses = [11, 22, 33].map((s) => makePose(origins, s));
    const posedO = poses.map((p) => { const pm = { positions: p(m.positions, m.joints, m.weights), indices: m.indices }; return { pm, bvh: new Bvh(pm.positions, pm.indices) }; });
    const variants = [
      ['positions only (carry joints/weights through the index buffer)', { mode: 'pos' }],
      ['normals+uv attributes (carry skin data)', { mode: 'attr' }],
      ['normals+uv+skin weights as attributes', { mode: 'attr', useSkin: true }],
      ['normals+uv+skin weights, Regularize', { mode: 'attr', useSkin: true, flags: ['Regularize'] }],
    ];
    for (const ratio of [0.25, 0.125]) for (const [vname, o] of variants) {
      const lv = buildChain(S, m, [ratio], o)[1];
      const sm = sub(m, lv.indices);
      let badJoint = 0, badWeightSum = 0, used = new Set(lv.indices);
      for (const v of used) { let ws = 0; for (let k = 0; k < 4; k++) { ws += m.weights[v * 4 + k]; if (m.weights[v * 4 + k] > 0 && m.joints[v * 4 + k] >= nj) badJoint++; } if (Math.abs(ws - 1) > 0.01) badWeightSum++; }
      const bind = hausdorff(m, sm, bvh);
      const posed = poses.map((p, i) => { const sp = { positions: p(m.positions, m.joints, m.weights), indices: lv.indices }; return hausdorff(posedO[i].pm, sp, posedO[i].bvh); });
      rows.push({ model: e.name, joints: nj, ratio, variant: vname, tris: lv.indices.length / 3, usedVerts: used.size, badJointIndices: badJoint, badWeightSums: badWeightSum,
        bindMax: r4(bind.max), bindMean: r4(bind.mean), posedMaxMean: r4(posed.reduce((s, h) => s + h.max, 0) / posed.length), posedMeanMean: r4(posed.reduce((s, h) => s + h.mean, 0) / posed.length) });
    }
  }
  return rows;
}


/** Q9: sidecar-style config: levels {ratio, errorLimit}; each level built from LOD0 (exact error semantics) vs chained. */
function q9(models, log) {
  const rows = [];
  const cfg = [{ ratio: 0.5, err: 0.005 }, { ratio: 0.25, err: 0.01 }, { ratio: 0.125, err: 0.02 }];
  for (const e of models.filter((x) => ['rock', 'tree', 'DamagedHelmet', 'FlightHelmet', 'Lantern', 'terrain', 'Sponza'].includes(x.name))) {
    log('q9 ' + e.name);
    for (const fromLod0 of [true, false]) {
      const t0 = performance.now();
      const lod0 = { indices: e.base.indices, groups: e.base.groups.map((g) => ({ ...g })) };
      const lod0Groups = lod0.groups.map((g) => g.count / 3);
      let prev = lod0; const levels = [];
      for (const c of cfg) { const lv = simplifyLevel(S, e.base, fromLod0 ? lod0 : prev, c.ratio, { mode: 'pos', errorLimit: c.err, lod0Groups }); levels.push(lv); prev = lv; }
      const ms = performance.now() - t0;
      cfg.forEach((c, i) => {
        const lv = levels[i]; const tgt = targetTris(e.base, c.ratio);
        rows.push({ model: e.name, build: fromLod0 ? 'each level from LOD0' : 'chained', level: i + 1, ratio: c.ratio, errorLimit: c.err, limitOfDiag: r4(c.err * e.bbox.maxExt / e.bbox.diag), targetTris: tgt, tris: lv.indices.length / 3, reached: r4(lv.indices.length / 3 / tgt), ...hq(e.base, e.bvh, lv.indices, false), ms: r4(ms) });
      });
    }
  }
  return rows;
}

/** Q8: screen-space meaning of an error (see README for the formula). */
export function screenTable() {
  const px = 1080;
  return [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05].map((e) => ({ errorFrac: e, h1px: r4(Math.min(1, 1 / (px * e))), h2px: r4(Math.min(1, 2 / (px * e))), px_at_full_height: r4(e * px) }));
}

export async function runQuality(models, { log = () => {} } = {}) {
  await Promise.all([S.ready, E.ready]);
  const prepared = models.map((e) => {
    const base = weld(e.mesh); const bbox = bboxOf(base.positions, base.indices);
    return { ...e, raw: e.mesh, base, bbox, bvh: new Bvh(base.positions, base.indices), topo: edgeTopology(base.positions, base.indices) };
  });
  const rockE = prepared.find((p) => p.name === 'rock');
  if (rockE) {
    const r2 = makeRock2Mat(rockE.base);
    prepared.push({ name: 'rock2mat', kind: 'procedural', raw: r2, base: r2, bbox: rockE.bbox, bvh: rockE.bvh, topo: rockE.topo });
  }
  const names = new Set(prepared.map((p) => p.name));
  const only = (list) => prepared.filter((p) => list.includes(p.name));
  const out = {
    inputs: prepared.map((p) => ({ model: p.name, kind: p.kind, tris: triCount(p.base), rawVerts: vertCount(p.raw), weldedVerts: vertCount(p.base), positionWeldedVerts: weldPositions(p.base.positions, p.base.indices).unique, groups: p.base.groups.length,
      bboxDiag: r4(p.bbox.diag), bboxMaxExtent: r4(p.bbox.maxExt), openEdges: p.topo.open, nonManifoldEdges: p.topo.nonManifold, skinned: !!p.base.joints })),
  };
  const main = prepared.filter((p) => p.name !== 'rock2mat');
  out.q1 = q1(main, log); out.q1b = q1b(main, log); out.q2 = q2(main, log); out.q3 = q3(main, log);
  out.q4 = q4(prepared, log); out.q5 = q5(prepared, log); out.q6 = q6(main, log); out.q7 = q7(main, log); out.q9 = q9(main, log);
  out.screen = screenTable();
  // transition heights derived from measured max Hausdorff of the attr chain
  out.transitions = out.q1.filter((r) => r.mode === 'attr').map((r) => ({ model: r.model, level: r.level, hausMax: r.max, h1px: r4(Math.min(1, 1 / (1080 * r.max))), h2px: r4(Math.min(1, 2 / (1080 * r.max))) }));
  void names; void only;
  return out;
}

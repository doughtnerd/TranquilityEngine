// LOD chain generation on top of meshoptimizer's simplifier (works in Node and the browser: no node imports).
import { sharedVertexFlags, vertCount } from './mesh.mjs';

export const DEFAULT_ATTR_WEIGHTS = { normal: 1.0, uv: 0.5, joints: 0.0, skinWeights: 1.0 };

/** Interleaved attribute buffer for simplifyWithAttributes: [nx ny nz][u v][w0..w3 when skinned and weighted]. */
export function attributeBuffer(m, { weights = DEFAULT_ATTR_WEIGHTS, useSkin = false } = {}) {
  const n = vertCount(m);
  const stride = 3 + 2 + (useSkin && m.weights ? 4 : 0);
  const buf = new Float32Array(n * stride);
  for (let i = 0; i < n; i++) {
    let o = i * stride;
    buf[o++] = m.normals[i * 3]; buf[o++] = m.normals[i * 3 + 1]; buf[o++] = m.normals[i * 3 + 2];
    buf[o++] = m.uvs[i * 2]; buf[o++] = m.uvs[i * 2 + 1];
    if (useSkin && m.weights) for (let k = 0; k < 4; k++) buf[o++] = m.weights[i * 4 + k];
  }
  const w = [weights.normal, weights.normal, weights.normal, weights.uv, weights.uv];
  if (useSkin && m.weights) w.push(weights.skinWeights, weights.skinWeights, weights.skinWeights, weights.skinWeights);
  return { buf, stride, w };
}

/**
 * Simplify every group of `m` (indices taken from `src` = {indices, groups}) to ratio*LOD0 triangles.
 * opts: mode 'pos' | 'attr' | 'sloppy', errorLimit (relative, 1 = none), flags, groupBorder 'none'|'lockBorder'|'vertexLock',
 *       perGroup (default true), attr (precomputed attributeBuffer), lod0Groups (triangle counts of LOD0 per group)
 * Returns {indices, groups:[{start,count}], errors:[per group relative error]}.
 */
export function simplifyLevel(S, m, src, ratio, opts) {
  const { mode = 'attr', errorLimit = 1, flags = [], groupBorder = 'vertexLock', perGroup = true, attr = null, lod0Groups = null, sparse = false } = opts;
  const groups = perGroup ? src.groups : [{ start: 0, count: src.indices.length }];
  const multi = perGroup && src.groups.length > 1;
  const lock = multi && groupBorder === 'vertexLock' ? sharedVertexFlags({ ...m, indices: src.indices, groups: src.groups }) : null;
  const outParts = []; const outGroups = []; const errors = []; let total = 0;
  // Error limits are given relative to the WHOLE mesh extent (S.getScale) and passed as absolute so every group shares one scale.
  const scale = opts.scale || S.getScale(m.positions, 3);
  const absErr = errorLimit >= 1 ? 1e30 : errorLimit * scale;
  groups.forEach((g, gi) => {
    const gi_idx = src.indices.subarray(g.start, g.start + g.count);
    const lod0Tris = lod0Groups ? (perGroup ? lod0Groups[gi] : lod0Groups.reduce((a, b) => a + b, 0)) : g.count / 3;
    let target = Math.max(0, Math.round(ratio * lod0Tris)) * 3;
    target = Math.min(target, gi_idx.length);
    let res;
    const f = [...flags, 'ErrorAbsolute'];
    if (multi && groupBorder === 'lockBorder') f.push('LockBorder');
    if (sparse || multi) f.push('Sparse');
    if (mode === 'sloppy') res = S.simplifySloppy(gi_idx, m.positions, 3, lock, target, Math.min(errorLimit, 1));
    else if (mode === 'pos' && !lock) res = S.simplify(gi_idx, m.positions, 3, target, absErr, f);
    else if (mode === 'pos') res = S.simplifyWithAttributes(gi_idx, m.positions, 3, new Float32Array(vertCount(m) * 0), 0, [], lock, target, absErr, f);
    else res = S.simplifyWithAttributes(gi_idx, m.positions, 3, attr.buf, attr.stride, attr.w, lock, target, absErr, f);
    outParts.push(res[0]); errors.push(mode === 'sloppy' ? res[1] : res[1] / scale); outGroups.push({ start: total, count: res[0].length, name: g.name }); total += res[0].length;
  });
  const indices = new Uint32Array(total); let o = 0;
  for (const p of outParts) { indices.set(p, o); o += p.length; }
  return { indices, groups: outGroups, errors };
}

/** Chain: each level simplified from the previous one, target = ratio * LOD0. Returns levels incl. LOD0. */
export function buildChain(S, m, ratios, opts = {}) {
  const lod0 = { indices: m.indices, groups: m.groups.map((g) => ({ ...g })) };
  const lod0Groups = lod0.groups.map((g) => g.count / 3);
  const attr = opts.mode === 'attr' ? (opts.attr || attributeBuffer(m, opts)) : null;
  const levels = [{ ...lod0, errors: [0], ratio: 1 }];
  let prev = lod0;
  for (const r of ratios) {
    const lv = simplifyLevel(S, m, opts.fromLod0 ? lod0 : prev, r, { ...opts, attr, lod0Groups });
    lv.ratio = r; levels.push(lv); prev = lv;
  }
  return levels;
}

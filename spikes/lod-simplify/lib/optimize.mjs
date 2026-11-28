// Vertex cache / fetch optimisation and buffer-size accounting (E = MeshoptEncoder).
import { vertCount } from './mesh.mjs';

export const BYTES_F32 = (m) => 32 + (m.joints ? 8 + 16 : 0); // pos 12 + normal 12 + uv 8 (+ joints u16x4 + weights f32x4)
export const BYTES_QUANT = (m) => 16 + (m.joints ? 4 + 4 : 0); // pos 3xu16(+pad) 8 + normal snorm8x4 4 + uv u16x2 4 (+ joints u8x4 + weights unorm8x4)

/**
 * Vertex cache + vertex fetch optimisation, keeping material groups contiguous.
 * Single group: meshopt reorderMesh (cache optimise + fetch remap). Several groups: cache-optimise each group's triangles
 * (reorderMesh on the group, vertex ids restored) then one fetch remap in first-use order over the whole index buffer.
 */
export function optimizeLevel(E, m, indices, groups) {
  const n = vertCount(m);
  let idx, remap, unique;
  if (!groups || groups.length <= 1) {
    idx = indices.slice();
    [remap, unique] = E.reorderMesh(idx, true, false);
  } else {
    idx = new Uint32Array(indices.length);
    for (const g of groups) {
      const sub = indices.subarray(g.start, g.start + g.count);
      let mx = 0; for (let i = 0; i < sub.length; i++) if (sub[i] > mx) mx = sub[i];
      idx.set(cacheOnly(E, sub, mx + 1), g.start);
    }
    remap = new Uint32Array(n).fill(0xffffffff); unique = 0;
    for (let k = 0; k < idx.length; k++) { const v = idx[k]; if (remap[v] === 0xffffffff) remap[v] = unique++; idx[k] = remap[v]; }
  }
  const out = { positions: new Float32Array(unique * 3), normals: new Float32Array(unique * 3), uvs: new Float32Array(unique * 2), indices: idx, name: m.name, groups: groups || [] };
  if (m.joints) { out.joints = new Uint16Array(unique * 4); out.weights = new Float32Array(unique * 4); }
  for (let i = 0; i < n; i++) {
    const r = remap[i]; if (r === 0xffffffff) continue;
    out.positions.set(m.positions.subarray(i * 3, i * 3 + 3), r * 3);
    out.normals.set(m.normals.subarray(i * 3, i * 3 + 3), r * 3);
    out.uvs.set(m.uvs.subarray(i * 2, i * 2 + 2), r * 2);
    if (m.joints) { out.joints.set(m.joints.subarray(i * 4, i * 4 + 4), r * 4); out.weights.set(m.weights.subarray(i * 4, i * 4 + 4), r * 4); }
  }
  out.remap = remap; out.unique = unique;
  return out;
}

/** Vertex-cache-only reorder of triangles, keeping the original vertex ids. */
export function cacheOnly(E, indices, vertexCount) {
  const idx = indices.slice();
  const [remap] = E.reorderMesh(idx, true, false);
  const inv = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) if (remap[i] !== 0xffffffff) inv[remap[i]] = i;
  for (let i = 0; i < idx.length; i++) idx[i] = inv[idx[i]];
  return idx;
}

export const indexBytes = (indexCount, vertexCount) => indexCount * (vertexCount <= 65535 ? 2 : 4);

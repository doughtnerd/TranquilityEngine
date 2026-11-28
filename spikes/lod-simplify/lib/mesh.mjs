// Canonical mesh used by the spike: one shared vertex buffer + index buffer with material groups.
// { name, positions:Float32Array(3n), normals:Float32Array(3n), uvs:Float32Array(2n), indices:Uint32Array,
//   groups:[{start,count,name}] (index ranges, contiguous), joints?:Uint16Array(4n), weights?:Float32Array(4n) }

export function triCount(m) { return m.indices.length / 3; }
export function vertCount(m) { return m.positions.length / 3; }

export function bboxOf(positions, indices) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const n = indices ? indices.length : positions.length / 3;
  for (let i = 0; i < n; i++) {
    const v = indices ? indices[i] : i;
    for (let k = 0; k < 3; k++) {
      const x = positions[v * 3 + k];
      if (x < mn[k]) mn[k] = x;
      if (x > mx[k]) mx[k] = x;
    }
  }
  const ext = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
  return { min: mn, max: mx, ext, diag: Math.hypot(ext[0], ext[1], ext[2]), maxExt: Math.max(...ext) };
}

/** Interleave all attributes into 32-bit words (floats normalised so -0 === 0). */
function words(m) {
  const n = vertCount(m);
  const stride = 3 + 3 + 2 + (m.joints ? 2 : 0) + (m.weights ? 4 : 0);
  const buf = new ArrayBuffer(n * stride * 4);
  const f = new Float32Array(buf), u = new Uint32Array(buf);
  for (let i = 0; i < n; i++) {
    let o = i * stride;
    for (let k = 0; k < 3; k++) f[o++] = m.positions[i * 3 + k] + 0;
    for (let k = 0; k < 3; k++) f[o++] = m.normals[i * 3 + k] + 0;
    for (let k = 0; k < 2; k++) f[o++] = m.uvs[i * 2 + k] + 0;
    if (m.joints) { u[o++] = m.joints[i * 4] | (m.joints[i * 4 + 1] << 16); u[o++] = m.joints[i * 4 + 2] | (m.joints[i * 4 + 3] << 16); }
    if (m.weights) for (let k = 0; k < 4; k++) f[o++] = m.weights[i * 4 + k] + 0;
  }
  return { u, stride, n };
}

/** Merge bit-identical vertices (all attributes). Returns a new mesh with compacted vertices (only referenced ones). */
export function weld(m) {
  const { u, stride, n } = words(m);
  let cap = 1; while (cap < n * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1);
  const remap = new Uint32Array(n);
  let unique = 0;
  const reps = [];
  for (let i = 0; i < n; i++) {
    let h = 2166136261;
    for (let k = 0; k < stride; k++) { h ^= u[i * stride + k]; h = Math.imul(h, 16777619); }
    let s = h & (cap - 1);
    for (;;) {
      const t = table[s];
      if (t < 0) { table[s] = i; remap[i] = unique++; reps.push(i); break; }
      let same = true;
      for (let k = 0; k < stride; k++) if (u[t * stride + k] !== u[i * stride + k]) { same = false; break; }
      if (same) { remap[i] = remap[t]; break; }
      s = (s + 1) & (cap - 1);
    }
  }
  return compact(m, remap, unique, reps);
}

function compact(m, remap, unique, reps) {
  const out = {
    name: m.name,
    positions: new Float32Array(unique * 3), normals: new Float32Array(unique * 3), uvs: new Float32Array(unique * 2),
    indices: new Uint32Array(m.indices.length), groups: m.groups.map((g) => ({ ...g })),
  };
  if (m.joints) out.joints = new Uint16Array(unique * 4);
  if (m.weights) out.weights = new Float32Array(unique * 4);
  for (let j = 0; j < unique; j++) {
    const i = reps[j];
    out.positions.set(m.positions.subarray(i * 3, i * 3 + 3), j * 3);
    out.normals.set(m.normals.subarray(i * 3, i * 3 + 3), j * 3);
    out.uvs.set(m.uvs.subarray(i * 2, i * 2 + 2), j * 2);
    if (m.joints) out.joints.set(m.joints.subarray(i * 4, i * 4 + 4), j * 4);
    if (m.weights) out.weights.set(m.weights.subarray(i * 4, i * 4 + 4), j * 4);
  }
  for (let k = 0; k < m.indices.length; k++) out.indices[k] = remap[m.indices[k]];
  return out;
}

/** Fully de-indexed triangle soup (worst case "never welded" input). */
export function deindex(m) {
  const n = m.indices.length;
  const ident = new Uint32Array(n).map((_, i) => i);
  return compact({ ...m, indices: ident }, ident, n, Array.from(m.indices));
}

/** Position-only weld: returns {remap (old vertex -> welded position id), positions, indices}. */
export function weldPositions(positions, indices) {
  const n = positions.length / 3;
  let cap = 1; while (cap < n * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1);
  const remap = new Uint32Array(n);
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  const key = (i, k) => { f[0] = positions[i * 3 + k] + 0; return u[0]; };
  let unique = 0; const reps = [];
  for (let i = 0; i < n; i++) {
    const a = key(i, 0), b = key(i, 1), c = key(i, 2);
    let h = Math.imul(Math.imul(Math.imul(2166136261 ^ a, 16777619) ^ b, 16777619) ^ c, 16777619);
    let s = h & (cap - 1);
    for (;;) {
      const t = table[s];
      if (t < 0) { table[s] = i; remap[i] = unique++; reps.push(i); break; }
      if (key(t, 0) === a && key(t, 1) === b && key(t, 2) === c) { remap[i] = remap[t]; break; }
      s = (s + 1) & (cap - 1);
    }
  }
  const pos = new Float32Array(unique * 3);
  for (let j = 0; j < unique; j++) pos.set(positions.subarray(reps[j] * 3, reps[j] * 3 + 3), j * 3);
  const idx = new Uint32Array(indices.length);
  for (let k = 0; k < indices.length; k++) idx[k] = remap[indices[k]];
  return { remap, positions: pos, indices: idx, unique };
}

/** Smooth normals (area weighted) over position-welded topology. */
export function computeNormals(positions, indices) {
  const w = weldPositions(positions, indices);
  const acc = new Float64Array(w.unique * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const a = w.indices[t], b = w.indices[t + 1], c = w.indices[t + 2];
    const ax = w.positions[a * 3], ay = w.positions[a * 3 + 1], az = w.positions[a * 3 + 2];
    const e1 = [w.positions[b * 3] - ax, w.positions[b * 3 + 1] - ay, w.positions[b * 3 + 2] - az];
    const e2 = [w.positions[c * 3] - ax, w.positions[c * 3 + 1] - ay, w.positions[c * 3 + 2] - az];
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    for (const v of [a, b, c]) { acc[v * 3] += nx; acc[v * 3 + 1] += ny; acc[v * 3 + 2] += nz; }
  }
  const n = positions.length / 3;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = w.remap[i]; const x = acc[p * 3], y = acc[p * 3 + 1], z = acc[p * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l;
  }
  return out;
}

/** Concatenate meshes (vertex buffers appended, one group per input group). */
export function mergeMeshes(name, parts) {
  let nv = 0, ni = 0;
  for (const p of parts) { nv += vertCount(p); ni += p.indices.length; }
  const out = {
    name, positions: new Float32Array(nv * 3), normals: new Float32Array(nv * 3), uvs: new Float32Array(nv * 2),
    indices: new Uint32Array(ni), groups: [],
  };
  const skinned = parts.some((p) => p.joints);
  if (skinned) { out.joints = new Uint16Array(nv * 4); out.weights = new Float32Array(nv * 4); }
  let vo = 0, io = 0;
  for (const p of parts) {
    const n = vertCount(p);
    out.positions.set(p.positions, vo * 3); out.normals.set(p.normals, vo * 3); out.uvs.set(p.uvs, vo * 2);
    if (p.joints) { out.joints.set(p.joints, vo * 4); out.weights.set(p.weights, vo * 4); }
    for (let k = 0; k < p.indices.length; k++) out.indices[io + k] = p.indices[k] + vo;
    for (const g of p.groups) out.groups.push({ start: io + g.start, count: g.count, name: g.name });
    vo += n; io += p.indices.length;
  }
  return out;
}

/** Reorder triangles so that groups are contiguous in the order given by groupOf(triIndex). */
export function regroup(m, groupOf, names) {
  const nt = triCount(m);
  const buckets = names.map(() => []);
  for (let t = 0; t < nt; t++) buckets[groupOf(t)].push(t);
  const idx = new Uint32Array(m.indices.length); const groups = []; let o = 0;
  buckets.forEach((b, gi) => {
    const start = o;
    for (const t of b) { idx.set(m.indices.subarray(t * 3, t * 3 + 3), o); o += 3; }
    groups.push({ start, count: o - start, name: names[gi] });
  });
  return { ...m, indices: idx, groups };
}

/** Per-vertex flag: referenced by more than one group. */
export function sharedVertexFlags(m) {
  const first = new Int32Array(vertCount(m)).fill(-1);
  const shared = new Uint8Array(vertCount(m));
  m.groups.forEach((g, gi) => {
    for (let k = g.start; k < g.start + g.count; k++) {
      const v = m.indices[k];
      if (first[v] < 0) first[v] = gi; else if (first[v] !== gi) shared[v] = 1;
    }
  });
  return shared;
}

export function checkMesh(m, label = m.name) {
  const n = vertCount(m);
  for (const arr of [m.positions, m.normals, m.uvs]) for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) throw new Error(`${label}: non-finite attribute`);
  for (let i = 0; i < m.indices.length; i++) if (m.indices[i] >= n) throw new Error(`${label}: index out of range`);
  let c = 0; for (const g of m.groups) c += g.count;
  if (c !== m.indices.length) throw new Error(`${label}: groups do not cover indices`);
  return true;
}

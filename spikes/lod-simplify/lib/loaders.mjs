// Minimal OBJ and glTF/GLB readers (spike only). Environment-agnostic: take bytes, no fs.
import { computeNormals, mergeMeshes } from './mesh.mjs';

const dec = new TextDecoder();

export function parseObj(bytes, name) {
  const text = dec.decode(bytes);
  const vp = [], vt = [], vn = [];
  const map = new Map(); const pos = [], uv = [], nrm = [];
  const groups = []; let cur = null; const indices = [];
  let hadNormals = false;
  for (const line of text.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'v') vp.push([+t[1], +t[2], +t[3]]);
    else if (t[0] === 'vt') vt.push([+t[1], +t[2]]);
    else if (t[0] === 'vn') vn.push([+t[1], +t[2], +t[3]]);
    else if (t[0] === 'usemtl' || t[0] === 'g' || t[0] === 'o') {
      if (t[0] !== 'usemtl') continue;
      if (cur) cur.count = indices.length - cur.start;
      cur = { start: indices.length, count: 0, name: t[1] }; groups.push(cur);
    } else if (t[0] === 'f') {
      if (!cur) { cur = { start: 0, count: 0, name: 'default' }; groups.push(cur); }
      const verts = t.slice(1).map((s) => {
        let v = map.get(s);
        if (v === undefined) {
          const [a, b, c] = s.split('/');
          const ia = (+a < 0 ? vp.length + +a : +a - 1);
          v = pos.length; map.set(s, v); pos.push(vp[ia]);
          uv.push(b ? vt[+b < 0 ? vt.length + +b : +b - 1] : [0, 0]);
          if (c) { hadNormals = true; nrm.push(vn[+c < 0 ? vn.length + +c : +c - 1]); } else nrm.push([0, 0, 0]);
        }
        return v;
      });
      for (let i = 1; i + 1 < verts.length; i++) indices.push(verts[0], verts[i], verts[i + 1]);
    }
  }
  if (cur) cur.count = indices.length - cur.start;
  const positions = new Float32Array(pos.flat()), idx = new Uint32Array(indices);
  const normals = hadNormals ? new Float32Array(nrm.flat()) : computeNormals(positions, idx);
  return { name, positions, normals, uvs: new Float32Array(uv.flat()), indices: idx, groups: groups.filter((g) => g.count > 0), hadNormals };
}

const CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function parseGlb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  let o = 12, json = null, bin = null;
  while (o < bytes.byteLength) {
    const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(dec.decode(data)); else if (type === 0x004e4942) bin = data;
    o += 8 + len;
  }
  return { json, buffers: [bin] };
}

/** Read an accessor as a typed array (de-interleaved, optionally normalised to float). */
export function readAccessor(gltf, index, { float = false } = {}) {
  const { json, buffers } = gltf;
  const acc = json.accessors[index];
  const n = NC[acc.type], T = CT[acc.componentType], count = acc.count;
  const out = new T(count * n);
  if (acc.bufferView !== undefined) {
    const bv = json.bufferViews[acc.bufferView]; const buf = buffers[bv.buffer];
    const es = T.BYTES_PER_ELEMENT, stride = bv.byteStride || n * es;
    const base = buf.byteOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const dv = new DataView(buf.buffer);
    const getter = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[acc.componentType];
    for (let i = 0; i < count; i++) for (let k = 0; k < n; k++) out[i * n + k] = dv[getter](base + i * stride + k * es, true);
  }
  if (!float) return out;
  const f = new Float32Array(out.length);
  const div = acc.normalized ? { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[acc.componentType] || 1 : 1;
  for (let i = 0; i < out.length; i++) f[i] = Math.max(-1, out[i] / div);
  return f;
}

/** All triangle primitives of the glTF merged into one mesh with one group per primitive (node transforms ignored). */
export function gltfToMesh(gltf, name) {
  const { json } = gltf; const parts = [];
  let skinJointCount = 0;
  json.meshes.forEach((mesh, mi) => mesh.primitives.forEach((p, pi) => {
    if ((p.mode ?? 4) !== 4) return;
    const a = p.attributes;
    const positions = readAccessor(gltf, a.POSITION, { float: true });
    const n = positions.length / 3;
    let indices;
    if (p.indices !== undefined) indices = Uint32Array.from(readAccessor(gltf, p.indices));
    else indices = Uint32Array.from({ length: n }, (_, i) => i);
    const normals = a.NORMAL !== undefined ? readAccessor(gltf, a.NORMAL, { float: true }) : computeNormals(positions, indices);
    const uvs = a.TEXCOORD_0 !== undefined ? readAccessor(gltf, a.TEXCOORD_0, { float: true }) : new Float32Array(n * 2);
    const part = { name: `${mi}.${pi}`, positions, normals, uvs, indices, groups: [{ start: 0, count: indices.length, name: `${mesh.name ?? mi}#${pi}` }] };
    if (a.JOINTS_0 !== undefined) {
      part.joints = Uint16Array.from(readAccessor(gltf, a.JOINTS_0));
      part.weights = readAccessor(gltf, a.WEIGHTS_0, { float: true });
      part.skin = json.skins ? json.skins[0] : null; part.skinIndex = 0;
      skinJointCount = json.skins ? json.skins[0].joints.length : 0;
    }
    parts.push(part);
  }));
  const anySkin = parts.some((p) => p.joints);
  if (anySkin) for (const p of parts) if (!p.joints) { p.joints = new Uint16Array(vertCountOf(p) * 4); p.weights = new Float32Array(vertCountOf(p) * 4); }
  const m = parts.length === 1 ? { ...parts[0], name } : mergeMeshes(name, parts);
  m.name = name;
  if (anySkin) m.skinJointCount = skinJointCount;
  return m;
}
const vertCountOf = (p) => p.positions.length / 3;

export function loadGltfSeparate(jsonBytes, binBytes) {
  return { json: JSON.parse(dec.decode(jsonBytes)), buffers: [binBytes] };
}

/** Inverse bind matrices of the first skin (16 floats per joint, column-major) or null. */
export function skinInverseBind(gltf) {
  const skin = gltf.json.skins?.[0];
  if (!skin || skin.inverseBindMatrices === undefined) return null;
  return readAccessor(gltf, skin.inverseBindMatrices, { float: true });
}

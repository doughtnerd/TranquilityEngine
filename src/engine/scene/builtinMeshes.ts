/**
 * Built-in meshes, Unity's sizes: a 1 m cube and sphere, a 2 m tall capsule and cylinder, a 10 m ground plane, a 1 m quad facing +Z.
 * Generated without three.js so it stays out of the start-up bundle (ADR 0082). The algorithms are ported from three.js r187's
 * geometry generators (MIT, © three.js authors) and produce the same vertices, normals, uvs, indices and groups.
 */
import type { MeshData } from "./models";

export const BUILTIN_MESHES = ["cube", "sphere", "capsule", "cylinder", "plane", "quad"] as const;
export type BuiltinMesh = (typeof BUILTIN_MESHES)[number];

type Group = MeshData["groups"][number];

/** Growing buffers; `finish` packs them the way a three.js Float32BufferAttribute does. */
class Builder {
  readonly p: number[] = [];
  readonly n: number[] = [];
  readonly uv: number[] = [];
  readonly i: number[] = [];
  readonly groups: Group[] = [];
  finish(): MeshData {
    return { positions: new Float32Array(this.p), normals: new Float32Array(this.n), uvs: new Float32Array(this.uv), indices: Uint32Array.from(this.i), groups: this.groups };
  }
}

/** three.js `Vector3.normalize`: multiplies by the reciprocal of the length. */
function normalize(x: number, y: number, z: number): [number, number, number] {
  const k = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
  return [x * k, y * k, z * k];
}

function box(w: number, h: number, d: number): MeshData {
  const b = new Builder();
  let vertices = 0;
  let start = 0;
  // u, v, w are the axes (0 x, 1 y, 2 z) of a face's grid and normal.
  const side = (u: number, v: number, wAxis: number, udir: number, vdir: number, width: number, height: number, depth: number, material: number): void => {
    const segW = width, segH = height; // one segment per side
    const vec = [0, 0, 0];
    for (let iy = 0; iy < 2; iy++) {
      const y = iy * segH - height / 2;
      for (let ix = 0; ix < 2; ix++) {
        const x = ix * segW - width / 2;
        vec[u] = x * udir;
        vec[v] = y * vdir;
        vec[wAxis] = depth / 2;
        b.p.push(vec[0], vec[1], vec[2]);
        vec[u] = 0;
        vec[v] = 0;
        vec[wAxis] = depth > 0 ? 1 : -1;
        b.n.push(vec[0], vec[1], vec[2]);
        b.uv.push(ix / 1, 1 - iy / 1);
      }
    }
    const a = vertices, bb = vertices + 2, c = vertices + 3, dd = vertices + 1;
    b.i.push(a, bb, dd, bb, c, dd);
    b.groups.push({ start, count: 6, materialIndex: material });
    start += 6;
    vertices += 4;
  };
  side(2, 1, 0, -1, -1, d, h, w, 0);
  side(2, 1, 0, 1, -1, d, h, -w, 1);
  side(0, 2, 1, 1, 1, w, d, h, 2);
  side(0, 2, 1, 1, -1, w, d, -h, 3);
  side(0, 1, 2, 1, -1, w, h, d, 4);
  side(0, 1, 2, -1, -1, w, h, -d, 5);
  return b.finish();
}

function sphere(radius: number, wSeg: number, hSeg: number): MeshData {
  const b = new Builder();
  for (let iy = 0; iy <= hSeg; iy++) {
    const v = iy / hSeg;
    const theta = v * Math.PI;
    const y = radius * Math.cos(theta);
    const ring = Math.sqrt(radius * radius - y * y);
    const uOffset = iy === 0 ? 0.5 / wSeg : iy === hSeg ? -0.5 / wSeg : 0;
    for (let ix = 0; ix <= wSeg; ix++) {
      const u = ix / wSeg;
      const phi = u * Math.PI * 2;
      const x = -ring * Math.cos(phi);
      const z = ring * Math.sin(phi);
      b.p.push(x, y, z);
      b.n.push(...normalize(x, y, z));
      b.uv.push(u + uOffset, 1 - v);
    }
  }
  const row = wSeg + 1;
  for (let iy = 0; iy < hSeg; iy++) {
    for (let ix = 0; ix < wSeg; ix++) {
      const a = iy * row + ix + 1, bb = iy * row + ix, c = (iy + 1) * row + ix, d = (iy + 1) * row + ix + 1;
      if (iy !== 0) b.i.push(a, bb, d);
      if (iy !== hSeg - 1) b.i.push(bb, c, d);
    }
  }
  return b.finish();
}

function capsule(radius: number, height: number, capSeg: number, radial: number): MeshData {
  const b = new Builder();
  const halfHeight = height / 2;
  const capArc = (Math.PI / 2) * radius;
  const totalArc = 2 * capArc + height;
  const rows = capSeg * 2 + 1; // one height segment
  const perRow = radial + 1;
  for (let iy = 0; iy <= rows; iy++) {
    let arc: number, py: number, pr: number, ny: number;
    if (iy <= capSeg) {
      const t = iy / capSeg;
      const angle = (t * Math.PI) / 2;
      py = -halfHeight - radius * Math.cos(angle);
      pr = radius * Math.sin(angle);
      ny = -radius * Math.cos(angle);
      arc = t * capArc;
    } else if (iy <= capSeg + 1) {
      const t = iy - capSeg;
      py = -halfHeight + t * height;
      pr = radius;
      ny = 0;
      arc = capArc + t * height;
    } else {
      const t = (iy - capSeg - 1) / capSeg;
      const angle = (t * Math.PI) / 2;
      py = halfHeight + radius * Math.sin(angle);
      pr = radius * Math.cos(angle);
      ny = radius * Math.sin(angle);
      arc = capArc + height + t * capArc;
    }
    const v = Math.max(0, Math.min(1, arc / totalArc));
    const uOffset = iy === 0 ? 0.5 / radial : iy === rows ? -0.5 / radial : 0;
    for (let ix = 0; ix <= radial; ix++) {
      const u = ix / radial;
      const theta = u * Math.PI * 2;
      const sin = Math.sin(theta), cos = Math.cos(theta);
      b.p.push(-pr * cos, py, pr * sin);
      b.n.push(...normalize(-pr * cos, ny, pr * sin));
      b.uv.push(u + uOffset, v);
    }
    if (iy > 0) {
      const prev = (iy - 1) * perRow;
      for (let ix = 0; ix < radial; ix++) {
        const i1 = prev + ix, i2 = prev + ix + 1, i3 = iy * perRow + ix, i4 = iy * perRow + ix + 1;
        b.i.push(i1, i2, i3, i2, i4, i3);
      }
    }
  }
  return b.finish();
}

function cylinder(radius: number, height: number, radial: number): MeshData {
  const b = new Builder();
  const half = height / 2;
  // torso: two rings, one height segment
  for (let y = 0; y <= 1; y++) {
    for (let x = 0; x <= radial; x++) {
      const u = x / radial;
      const theta = u * Math.PI * 2;
      const sin = Math.sin(theta), cos = Math.cos(theta);
      b.p.push(radius * sin, -y * height + half, radius * cos);
      b.n.push(...normalize(sin, 0, cos));
      b.uv.push(u, 1 - y);
    }
  }
  const row = radial + 1;
  for (let x = 0; x < radial; x++) b.i.push(x, row + x, x + 1, row + x, row + x + 1, x + 1);
  b.groups.push({ start: 0, count: radial * 6, materialIndex: 0 });
  let start = radial * 6;
  let index = row * 2;
  for (const top of [true, false]) {
    const sign = top ? 1 : -1;
    const centerStart = index;
    for (let x = 1; x <= radial; x++) {
      b.p.push(0, half * sign, 0);
      b.n.push(0, sign, 0);
      b.uv.push(0.5, 0.5);
      index++;
    }
    const ringStart = index;
    for (let x = 0; x <= radial; x++) {
      const theta = (x / radial) * Math.PI * 2;
      const cos = Math.cos(theta), sin = Math.sin(theta);
      b.p.push(radius * sin, half * sign, radius * cos);
      b.n.push(0, sign, 0);
      b.uv.push(cos * 0.5 + 0.5, sin * 0.5 * sign + 0.5);
      index++;
    }
    for (let x = 0; x < radial; x++) {
      const c = centerStart + x, i = ringStart + x;
      if (top) b.i.push(i, i + 1, c);
      else b.i.push(i + 1, i, c);
    }
    b.groups.push({ start, count: radial * 3, materialIndex: top ? 1 : 2 });
    start += radial * 3;
  }
  return b.finish();
}

/** A one-segment plane in XY facing +Z, optionally rotated about X (three.js `rotateX`: positions by the matrix, normals by its normal matrix, then normalized). */
function plane(size: number, rotateX: number): MeshData {
  const b = new Builder();
  const half = size / 2;
  for (let iy = 0; iy < 2; iy++) {
    const y = iy * size - half;
    for (let ix = 0; ix < 2; ix++) {
      b.p.push(ix * size - half, -y, 0);
      b.n.push(0, 0, 1);
      b.uv.push(ix, 1 - iy);
    }
  }
  b.i.push(0, 2, 1, 2, 3, 1);
  const data = b.finish();
  if (rotateX === 0) return data;
  const c = Math.cos(rotateX), s = Math.sin(rotateX);
  const p = data.positions, n = data.normals!;
  // Normal matrix = inverse transpose of the rotation, inverted the way three.js's Matrix3 does.
  const inv = 1 / (c * c - -s * s);
  const e4 = c * inv, e5 = s * inv, e7 = -s * inv, e8 = c * inv;
  for (let k = 0; k < p.length; k += 3) {
    const y = p[k + 1], z = p[k + 2];
    p[k + 1] = c * y + -s * z;
    p[k + 2] = s * y + c * z;
    const ny = n[k + 1], nz = n[k + 2];
    [n[k], n[k + 1], n[k + 2]] = normalize(n[k], e4 * ny + e7 * nz, e5 * ny + e8 * nz);
  }
  return data;
}

/** The mesh data of a built-in mesh (a fresh copy each call). */
export function builtinMeshData(name: BuiltinMesh): MeshData {
  switch (name) {
    case "cube": return box(1, 1, 1);
    case "sphere": return sphere(0.5, 32, 16);
    case "capsule": return capsule(0.5, 1, 8, 24);
    case "cylinder": return cylinder(0.5, 2, 32);
    case "plane": return plane(10, -Math.PI / 2);
    case "quad": return plane(1, 0);
  }
}

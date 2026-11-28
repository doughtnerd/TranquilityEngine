// Procedural geometry for the render benchmark (promoted from spikes/render-bench/gen). Everything is deterministic (seeded PRNG, value noise).
// A "part" is { positions: number[], indices: number[], material: string }: welded, indexed triangles.

/** Welded, indexed triangles. */
export interface Geom { positions: number[]; indices: number[] }
/** A geometry with the material it is drawn with. */
export interface Part extends Geom { material: string }
type Displace = (x: number, y: number, z: number) => number;

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Trilinear value noise in [0,1). */
export function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(xf), v = s(yf), w = s(zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

/** A welded UV sphere (poles are single vertices, no seam duplicates), `2*lon*(lat-1)` triangles. Radii are per axis. */
export function sphere(lon: number, lat: number, rx: number, ry: number, rz: number, cx = 0, cy = 0, cz = 0, displace: Displace | null = null): Geom {
  const positions: number[] = [], indices: number[] = [];
  const p = (x: number, y: number, z: number) => {
    let k = 1;
    if (displace) k = displace(x, y, z);
    positions.push(cx + x * rx * k, cy + y * ry * k, cz + z * rz * k);
  };
  p(0, 1, 0); // north pole
  for (let i = 1; i < lat; i++) {
    const th = (i / lat) * Math.PI;
    for (let j = 0; j < lon; j++) {
      const ph = (j / lon) * Math.PI * 2;
      p(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
    }
  }
  p(0, -1, 0);
  const south = positions.length / 3 - 1;
  const ring = (i: number, j: number) => 1 + (i - 1) * lon + (j % lon);
  for (let j = 0; j < lon; j++) indices.push(0, ring(1, j + 1), ring(1, j));
  for (let i = 1; i < lat - 1; i++) {
    for (let j = 0; j < lon; j++) {
      const a = ring(i, j), b = ring(i, j + 1), c = ring(i + 1, j), d = ring(i + 1, j + 1);
      indices.push(a, b, c, b, d, c);
    }
  }
  for (let j = 0; j < lon; j++) indices.push(south, ring(lat - 1, j), ring(lat - 1, j + 1));
  return { positions, indices };
}

/** lon x lat sphere sized for roughly `tris` triangles. */
export function sphereForTris(tris: number, ...rest: [rx: number, ry: number, rz: number, cx?: number, cy?: number, cz?: number, displace?: Displace | null]): Geom {
  const lat = Math.max(4, Math.round(Math.sqrt(tris / 4)));
  return sphere(2 * lat, lat, ...rest);
}

/** A tapered cylinder along +y from y0 to y1 (closed with caps): `sides * rings * 2 + 2 * sides` triangles. */
export function cylinder(sides: number, rings: number, r0: number, r1: number, y0: number, y1: number, cx = 0, cz = 0, wobble: ((a: number, t: number) => number) | null = null): Geom {
  const positions: number[] = [], indices: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings, r = r0 + (r1 - r0) * t, y = y0 + (y1 - y0) * t;
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const k = wobble ? wobble(a, t) : 1;
      positions.push(cx + Math.cos(a) * r * k, y, cz + Math.sin(a) * r * k);
    }
  }
  const at = (i: number, j: number) => i * sides + (j % sides);
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < sides; j++) {
      indices.push(at(i, j), at(i + 1, j), at(i, j + 1), at(i, j + 1), at(i + 1, j), at(i + 1, j + 1));
    }
  }
  positions.push(cx, y0, cz, cx, y1, cz);
  const bot = positions.length / 3 - 2, top = bot + 1;
  for (let j = 0; j < sides; j++) {
    indices.push(bot, at(0, j + 1), at(0, j));
    indices.push(top, at(rings, j), at(rings, j + 1));
  }
  return { positions, indices };
}

/** A box with each face an n x n grid (welded across faces by position), centred on (cx, cy, cz). */
export function gridBox(w: number, h: number, d: number, n: number, cx = 0, cy = 0, cz = 0): Geom {
  const parts: Geom[] = [];
  const face = (ax: number, sign: number): Geom => {
    // ax: 0 = x, 1 = y, 2 = z normal
    const u = (ax + 1) % 3, v = (ax + 2) % 3;
    const dims = [w, h, d] as [number, number, number];
    const positions: number[] = [], indices: number[] = [];
    for (let a = 0; a <= n; a++) {
      for (let b = 0; b <= n; b++) {
        const p = [0, 0, 0];
        p[ax] = (sign * dims[ax]) / 2;
        p[u] = (a / n - 0.5) * dims[u];
        p[v] = (b / n - 0.5) * dims[v];
        positions.push(cx + p[0], cy + p[1], cz + p[2]);
      }
    }
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        const i = a * (n + 1) + b;
        const q = [i, i + 1, i + n + 1, i + 1, i + n + 2, i + n + 1];
        if (sign < 0) q.reverse();
        indices.push(...q);
      }
    }
    return { positions, indices };
  };
  for (let ax = 0; ax < 3; ax++) for (const s of [-1, 1]) parts.push(face(ax, s));
  return weld(merge(parts));
}

/** Concatenate parts' geometry into one (no material). */
export function merge(parts: readonly Geom[]): Geom {
  const positions: number[] = [], indices: number[] = [];
  for (const p of parts) {
    const base = positions.length / 3;
    for (const v of p.positions) positions.push(v);
    for (const i of p.indices) indices.push(i + base);
  }
  return { positions, indices };
}

/** Weld vertices that share a position (1e-5), drop degenerate triangles. */
export function weld(g: Geom): Geom {
  const map = new Map<string, number>(), positions: number[] = [], remap = new Uint32Array(g.positions.length / 3);
  for (let i = 0; i < remap.length; i++) {
    const x = g.positions[i * 3], y = g.positions[i * 3 + 1], z = g.positions[i * 3 + 2];
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      map.set(key, id);
      positions.push(x, y, z);
    }
    remap[i] = id;
  }
  const indices: number[] = [];
  for (let i = 0; i < g.indices.length; i += 3) {
    const a = remap[g.indices[i]], b = remap[g.indices[i + 1]], c = remap[g.indices[i + 2]];
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  }
  return { positions, indices };
}

/** Apply a transform to positions: scale then translate. */
export function xform(g: Geom, sx: number, sy: number, sz: number, tx: number, ty: number, tz: number): Geom {
  const positions = g.positions.slice();
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i] * sx + tx;
    positions[i + 1] = positions[i + 1] * sy + ty;
    positions[i + 2] = positions[i + 2] * sz + tz;
  }
  return { positions, indices: g.indices.slice() };
}

/** Smooth, area-weighted vertex normals. */
export function normals(positions: readonly number[], indices: readonly number[]): Float32Array {
  const n = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { n[o] += nx; n[o + 1] += ny; n[o + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

/**
 * Orient triangles outward for a closed mesh around `centre` (by the sign of the triangle normal against the
 * direction from the centre), so the OBJ's winding is consistent whatever the primitive generators did.
 */
export function orientOutward(g: Geom, cx: number, cy: number, cz: number): Geom {
  const idx = g.indices.slice();
  const P = g.positions;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = (P[a] + P[b] + P[c]) / 3 - cx, my = (P[a + 1] + P[b + 1] + P[c + 1]) / 3 - cy, mz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3 - cz;
    if (nx * mx + ny * my + nz * mz < 0) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
  }
  return { positions: g.positions, indices: idx };
}

/**
 * A model: parts (each its own material group). Written as OBJ + MTL text. `mtlName` is the .mtl file name.
 * Parts' vertices are concatenated; one `usemtl` run per part.
 */
export function toObj(name: string, parts: readonly Part[], mtlName: string): string {
  const out = [`mtllib ${mtlName}`, `o ${name}`];
  const vOut: string[] = [], nOut: string[] = [], fOut: string[] = [];
  let base = 0;
  for (const part of parts) {
    const P = part.positions, nrm = normals(P, part.indices);
    for (let i = 0; i < P.length; i += 3) vOut.push(`v ${+P[i].toFixed(4)} ${+P[i + 1].toFixed(4)} ${+P[i + 2].toFixed(4)}`);
    for (let i = 0; i < nrm.length; i += 3) nOut.push(`vn ${+nrm[i].toFixed(3)} ${+nrm[i + 1].toFixed(3)} ${+nrm[i + 2].toFixed(3)}`);
    fOut.push(`usemtl ${part.material}`);
    const I = part.indices;
    for (let i = 0; i < I.length; i += 3) {
      const a = I[i] + base + 1, b = I[i + 1] + base + 1, c = I[i + 2] + base + 1;
      fOut.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
    }
    base += P.length / 3;
  }
  return [...out, ...vOut, ...nOut, ...fOut].join("\n") + "\n";
}

export function triCount(parts: readonly Geom[]): number {
  return parts.reduce((s, p) => s + p.indices.length / 3, 0);
}

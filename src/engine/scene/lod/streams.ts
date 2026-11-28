/**
 * A model mesh's per-vertex streams as the LOD pipeline carries them (ADR 0446 §1): welding vertices whose every stream
 * is bit-identical, and remapping every stream with one table. Internal: not public API.
 *
 * Welding and reordering permute the vertices, so every stream (positions, normals, UVs, second UVs, colours, tangents,
 * skin joints and weights, and each morph target's deltas) goes through the same remap, once.
 */

/** One morph target's deltas (any may be absent). */
export interface MorphStreams {
  readonly positions: Float32Array | null;
  readonly normals: Float32Array | null;
  readonly tangents: Float32Array | null;
}

/** Every per-vertex stream of a mesh. Absent streams are null. */
export interface VertexStreams {
  /** x, y, z per vertex. */
  readonly positions: Float32Array;
  /** x, y, z. */
  readonly normals: Float32Array | null;
  /** u, v. */
  readonly uvs: Float32Array | null;
  /** u, v. */
  readonly uvs2: Float32Array | null;
  /** r, g, b, a. */
  readonly colors: Float32Array | null;
  /** x, y, z, w. */
  readonly tangents: Float32Array | null;
  /** `influences` joint indices per vertex, or null. */
  readonly joints: Uint16Array | null;
  /** `influences` weights per vertex, or null. */
  readonly weights: Float32Array | null;
  /** Influences per vertex of `joints` and `weights` (0 when not skinned). */
  readonly influences: number;
  readonly morphs: readonly MorphStreams[];
}

/** A remap table: `remap[old] = new`, or `UNUSED` for a vertex dropped. */
export const UNUSED = 0xffffffff;

/** The vertex count of `streams`. */
export const vertexCount = (streams: VertexStreams): number => streams.positions.length / 3;

/** Each stream with its component count, in one fixed order (the weld compares them in this order). */
function streamList(s: VertexStreams): { array: Float32Array | Uint16Array; size: number }[] {
  const out: { array: Float32Array | Uint16Array; size: number }[] = [{ array: s.positions, size: 3 }];
  const add = (array: Float32Array | Uint16Array | null, size: number) => {
    if (array && size > 0) out.push({ array, size });
  };
  add(s.normals, 3);
  add(s.uvs, 2);
  add(s.uvs2, 2);
  add(s.colors, 4);
  add(s.tangents, 4);
  add(s.joints, s.influences);
  add(s.weights, s.influences);
  for (const m of s.morphs) {
    add(m.positions, 3);
    add(m.normals, 3);
    add(m.tangents, 3);
  }
  return out;
}

/**
 * Every vertex's streams as 32-bit words, interleaved: floats by their bits (with -0 as 0, so a sign the file stored on
 * a zero doesn't split a vertex), joints by value.
 */
function words(s: VertexStreams): { words: Uint32Array; stride: number; count: number } {
  const count = vertexCount(s);
  const list = streamList(s);
  const stride = list.reduce((n, l) => n + l.size, 0);
  const out = new Uint32Array(count * stride);
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  let at = 0;
  for (const { array, size } of list) {
    if (array instanceof Float32Array) {
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < size; k++) {
          f[0] = array[i * size + k] + 0;
          out[i * stride + at + k] = u[0];
        }
      }
    } else {
      for (let i = 0; i < count; i++) for (let k = 0; k < size; k++) out[i * stride + at + k] = array[i * size + k];
    }
    at += size;
  }
  return { words: out, stride, count };
}

/**
 * The weld of `streams`: vertices whose every stream is bit-identical share one new index, numbered in order of first
 * appearance. Every vertex is kept (`remap` has no `UNUSED`).
 */
export function weldRemap(streams: VertexStreams): { remap: Uint32Array; unique: number } {
  const { words: w, stride, count } = words(streams);
  let cap = 1;
  while (cap < count * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1);
  const remap = new Uint32Array(count);
  let unique = 0;
  for (let i = 0; i < count; i++) {
    let h = 2166136261;
    const o = i * stride;
    for (let k = 0; k < stride; k++) h = Math.imul(h ^ w[o + k], 16777619);
    let slot = (h >>> 0) & (cap - 1);
    for (;;) {
      const t = table[slot];
      if (t < 0) {
        table[slot] = i;
        remap[i] = unique++;
        break;
      }
      let same = true;
      const p = t * stride;
      for (let k = 0; k < stride; k++) {
        if (w[p + k] !== w[o + k]) {
          same = false;
          break;
        }
      }
      if (same) {
        remap[i] = remap[t];
        break;
      }
      slot = (slot + 1) & (cap - 1);
    }
  }
  return { remap, unique };
}

/** `array` (`size` per vertex) remapped into `unique` vertices; `UNUSED` entries are dropped. */
function remapArray<T extends Float32Array | Uint16Array>(array: T, size: number, remap: Uint32Array, unique: number): T {
  const out = new (array.constructor as new (n: number) => T)(unique * size);
  for (let i = 0; i < remap.length; i++) {
    const r = remap[i];
    if (r === UNUSED) continue;
    for (let k = 0; k < size; k++) out[r * size + k] = array[i * size + k];
  }
  return out;
}

/** Every stream of `streams` remapped with the one table (`remap[old] = new`, `UNUSED` drops a vertex). */
export function remapStreams(streams: VertexStreams, remap: Uint32Array, unique: number): VertexStreams {
  const opt = <T extends Float32Array | Uint16Array>(a: T | null, size: number): T | null => (a && size > 0 ? remapArray(a, size, remap, unique) : null);
  return {
    positions: remapArray(streams.positions, 3, remap, unique),
    normals: opt(streams.normals, 3),
    uvs: opt(streams.uvs, 2),
    uvs2: opt(streams.uvs2, 2),
    colors: opt(streams.colors, 4),
    tangents: opt(streams.tangents, 4),
    joints: opt(streams.joints, streams.influences),
    weights: opt(streams.weights, streams.influences),
    influences: streams.influences,
    morphs: streams.morphs.map((m) => ({ positions: opt(m.positions, 3), normals: opt(m.normals, 3), tangents: opt(m.tangents, 3) })),
  };
}

/** `indices` through `remap`. */
export function remapIndices(indices: Uint32Array, remap: Uint32Array): Uint32Array {
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = remap[indices[i]];
  return out;
}

/** Every typed array of `streams` (for a worker's transfer list or a hash). */
export function streamArrays(streams: VertexStreams): (Float32Array | Uint16Array)[] {
  return streamList(streams).map((l) => l.array);
}

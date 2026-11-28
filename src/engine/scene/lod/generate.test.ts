// ADR 0446 §1: LOD generation (weld, per-submesh simplification, measured error, occluder, reorder), its cache and its
// worker protocol, driven through `generateLods`, `cachedLods` and the two ends of the worker port.
import { describe, expect, it } from "vitest";
import { DEFAULT_LOD_SETTINGS, type LodSettings, type OccluderStandIn } from "./types";
import { generateLods, type GeneratedLods, type LodSource } from "./generate";
import { cachedLods, memoryLodCache, type LodHost } from "./cache";
import { lodGeneratorOver, serveLodGeneration, type LodPort } from "./workerGenerator";
import type { VertexStreams } from "./streams";

// --- Fixtures -------------------------------------------------------------------------------------------------------

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise, a few octaves. */
function noise(seed: number): (x: number, y: number, z: number) => number {
  const r = random(seed);
  const perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const grad = Array.from({ length: 256 }, () => r() * 2 - 1);
  const lat = (x: number, y: number, z: number) => grad[perm[(perm[(perm[x & 255] + y) & 255] + z) & 255]];
  const sm = (t: number) => t * t * (3 - 2 * t);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const value = (x: number, y: number, z: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = sm(x - xi), yf = sm(y - yi), zf = sm(z - zi);
    return lerp(
      lerp(lerp(lat(xi, yi, zi), lat(xi + 1, yi, zi), xf), lerp(lat(xi, yi + 1, zi), lat(xi + 1, yi + 1, zi), xf), yf),
      lerp(lerp(lat(xi, yi, zi + 1), lat(xi + 1, yi, zi + 1), xf), lerp(lat(xi, yi + 1, zi + 1), lat(xi + 1, yi + 1, zi + 1), xf), yf),
      zf,
    );
  };
  return (x, y, z) => {
    let s = 0, a = 1, f = 1;
    for (let o = 0; o < 5; o++) (s += a * value(x * f, y * f, z * f)), (a *= 0.5), (f *= 2);
    return s;
  };
}

/** A noisy icosphere: shared vertices, smooth normals, spherical UVs with a split seam (the spike's rock, `lod-simplify/lib/gen.mjs`). */
function rock(subdivisions = 5): { positions: number[]; normals: number[]; uvs: number[]; indices: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const pos: number[][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  });
  let tris = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let l = 0; l < subdivisions; l++) {
    const mids = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let m = mids.get(key);
      if (m === undefined) {
        const x = pos[a][0] + pos[b][0], y = pos[a][1] + pos[b][1], z = pos[a][2] + pos[b][2];
        const len = Math.hypot(x, y, z);
        mids.set(key, (m = pos.length));
        pos.push([x / len, y / len, z / len]);
      }
      return m;
    };
    tris = tris.flatMap(([a, b, c]) => {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
    });
  }
  const n = noise(1234);
  const displaced = pos.map(([x, y, z]) => {
    const k = 1.4 + 0.5 * n(x * 1.7 + 10, y * 1.7 + 10, z * 1.7 + 10);
    return [x * k, y * k * 0.8, z * k];
  });
  // Smooth normals (area weighted).
  const acc = displaced.map(() => [0, 0, 0]);
  for (const [a, b, c] of tris) {
    const [ax, ay, az] = displaced[a], [bx, by, bz] = displaced[b], [cx, cy, cz] = displaced[c];
    const e1 = [bx - ax, by - ay, bz - az], e2 = [cx - ax, cy - ay, cz - az];
    const nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) acc[v][k] += nn[k];
  }
  const nrm = acc.map((v) => {
    const l = Math.hypot(...v) || 1;
    return v.map((x) => x / l);
  });
  const uv0 = pos.map(([x, y, z]) => [Math.atan2(z, x) / (2 * Math.PI) + 0.5, Math.acos(Math.max(-1, Math.min(1, y))) / Math.PI]);
  const outPos = [...displaced], outNrm = [...nrm], outUv = [...uv0];
  const dup = new Map<number, number>();
  const indices: number[] = [];
  for (const tri of tris) {
    const us = tri.map((v) => uv0[v][0]);
    const wrap = Math.max(...us) - Math.min(...us) > 0.5;
    for (const v of tri) {
      if (wrap && uv0[v][0] < 0.5) {
        let d = dup.get(v);
        if (d === undefined) {
          dup.set(v, (d = outPos.length));
          outPos.push(displaced[v]);
          outNrm.push(nrm[v]);
          outUv.push([uv0[v][0] + 1, uv0[v][1]]);
        }
        indices.push(d);
      } else indices.push(v);
    }
  }
  return { positions: outPos.flat(), normals: outNrm.flat(), uvs: outUv.flat(), indices };
}

const streamsOf = (r: { positions: number[]; normals: number[]; uvs: number[] }, extra: Partial<VertexStreams> = {}): VertexStreams => ({
  positions: new Float32Array(r.positions),
  normals: new Float32Array(r.normals),
  uvs: new Float32Array(r.uvs),
  uvs2: null,
  colors: null,
  tangents: null,
  joints: null,
  weights: null,
  influences: 0,
  morphs: [],
  ...extra,
});

/** A rock's triangles split into two groups by a plane (x < 0.1 first), sharing their boundary vertices. */
function twoGroups(r: ReturnType<typeof rock>): LodSource {
  const a: number[] = [], b: number[] = [];
  for (let t = 0; t < r.indices.length; t += 3) {
    const tri = r.indices.slice(t, t + 3);
    const cx = tri.reduce((s, v) => s + r.positions[v * 3], 0) / 3;
    (cx < 0.1 ? a : b).push(...tri);
  }
  return { streams: streamsOf(r), indices: new Uint32Array([...a, ...b]), groups: [{ start: 0, count: a.length, materialIndex: 0 }, { start: a.length, count: b.length, materialIndex: 1 }] };
}

/** Every stream of vertex `v` as one string: what a vertex "is", whatever its index. */
function vertexKey(s: VertexStreams, v: number): string {
  const parts: number[] = [];
  const add = (a: ArrayLike<number> | null, size: number) => {
    if (a) for (let k = 0; k < size; k++) parts.push(a[v * size + k] + 0);
  };
  add(s.positions, 3);
  add(s.normals, 3);
  add(s.uvs, 2);
  add(s.uvs2, 2);
  add(s.colors, 4);
  add(s.tangents, 4);
  add(s.joints, s.influences);
  add(s.weights, s.influences);
  for (const m of s.morphs) add(m.positions, 3), add(m.normals, 3), add(m.tangents, 3);
  return parts.join(",");
}

/** The triangles of `indices` as a sorted list of vertex-key triples, each rotated to start at its smallest key (winding kept). */
function triangleSet(s: VertexStreams, indices: Uint32Array, keyOf: (s: VertexStreams, v: number) => string = vertexKey): string[] {
  const out: string[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const k = [keyOf(s, indices[t]), keyOf(s, indices[t + 1]), keyOf(s, indices[t + 2])];
    let m = 0;
    for (let i = 1; i < 3; i++) if (k[i] < k[m]) m = i;
    out.push([k[m], k[(m + 1) % 3], k[(m + 2) % 3]].join(" | "));
  }
  return out.sort();
}

const positionKey = (s: VertexStreams, v: number) => `${s.positions[v * 3] + 0},${s.positions[v * 3 + 1] + 0},${s.positions[v * 3 + 2] + 0}`;

/** Edges used by exactly one triangle, with vertices merged by position. */
function openEdges(s: VertexStreams, indices: Uint32Array): number {
  const counts = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = positionKey(s, indices[t + e]), b = positionKey(s, indices[t + ((e + 1) % 3)]);
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.values()].filter((c) => c === 1).length;
}

const ROCK = rock(5); // 20,480 triangles
/** The default ratios with no error limit: for fixtures the limits would stop early (coarse rocks, random attributes). */
const UNLIMITED: LodSettings = { ...DEFAULT_LOD_SETTINGS, levels: DEFAULT_LOD_SETTINGS.levels.map((l) => ({ ratio: l.ratio, error: 1 })) };

/** A trimmed stand-in's per-triangle arrays: one error (at most 0.5 % of the diagonal) and 3 neighbours per triangle, every neighbour pointing back. */
function expectTrimmed(occluder: OccluderStandIn): void {
  const kept = occluder.indices.length / 3;
  expect(occluder.triangleErrors).toBeInstanceOf(Float32Array);
  expect(occluder.triangleErrors.length).toBe(kept);
  for (const e of occluder.triangleErrors) {
    expect(e).toBeGreaterThanOrEqual(0);
    expect(e).toBeLessThanOrEqual(0.005);
  }
  expect(occluder.neighbors).toBeInstanceOf(Uint32Array);
  expect(occluder.neighbors.length).toBe(kept * 3);
  for (let t = 0; t < kept; t++) {
    for (let k = 0; k < 3; k++) {
      const n = occluder.neighbors[t * 3 + k];
      if (n === 0xffffffff) continue;
      expect(n).toBeLessThan(kept);
      expect(Array.from(occluder.neighbors.subarray(n * 3, n * 3 + 3))).toContain(t);
    }
  }
}

// --- Tests ----------------------------------------------------------------------------------------------------------

describe("LOD generation (ADR 0446 §1)", () => {
  it("brings a rock to its level targets, with measured errors that grow level by level", async () => {
    const source: LodSource = { streams: streamsOf(ROCK), indices: new Uint32Array(ROCK.indices), groups: [] };
    const lods = await generateLods(source, DEFAULT_LOD_SETTINGS, "auto");
    expect(lods.levels.map((l) => l.triangles)[0]).toBe(20480);
    DEFAULT_LOD_SETTINGS.levels.forEach((target, i) => {
      const level = lods.levels[i + 1];
      // Within 5 % of the target (the spike's rock reaches every ratio).
      expect(Math.abs(level.triangles - target.ratio * 20480) / (target.ratio * 20480)).toBeLessThan(0.05);
      expect(level.indices.length).toBe(level.triangles * 3);
      expect(level.groups).toEqual([]); // a mesh with one surface keeps none
    });
    const errors = lods.levels.map((l) => l.error);
    expect(errors[0]).toBe(0);
    // Plausible: the spike measured 0.62 / 1.00 / 1.65 % of the diagonal on its rock.
    expect(errors[1]).toBeGreaterThan(0.001);
    expect(errors[1]).toBeLessThan(0.015);
    expect(errors[2]).toBeGreaterThan(errors[1]);
    expect(errors[3]).toBeGreaterThan(errors[2]);
    expect(errors[3]).toBeLessThan(0.04);
    // Bounds of LOD0, every index in range of the shared streams.
    const p = source.streams.positions;
    for (let k = 0; k < 3; k++) {
      const axis = p.filter((_, i) => i % 3 === k);
      expect(lods.bounds[k]).toBe(Math.min(...axis));
      expect(lods.bounds[k + 3]).toBe(Math.max(...axis));
    }
    const vertices = lods.streams.positions.length / 3;
    for (const l of lods.levels) expect(Math.max(...l.indices)).toBeLessThan(vertices);
  }, 60_000);

  it("keeps LOD0 output-equivalent: the same triangles, welded and reordered", async () => {
    // De-indexed (every triangle its own three vertices): welding must find the shared ones again.
    const r = rock(3);
    const soup = { positions: r.indices.flatMap((v) => r.positions.slice(v * 3, v * 3 + 3)), normals: r.indices.flatMap((v) => r.normals.slice(v * 3, v * 3 + 3)), uvs: r.indices.flatMap((v) => r.uvs.slice(v * 2, v * 2 + 2)) };
    const source: LodSource = { streams: streamsOf(soup), indices: Uint32Array.from(r.indices, (_, i) => i), groups: [] };
    const lods = await generateLods(source, UNLIMITED, "auto");
    expect(triangleSet(lods.streams, lods.levels[0].indices)).toEqual(triangleSet(source.streams, source.indices));
    expect(lods.streams.positions.length / 3).toBe(r.positions.length / 3); // welded back to the shared vertices
    expect(lods.levels[1].triangles).toBeLessThan(lods.levels[0].triangles * 0.6); // and so it simplifies
  }, 60_000);

  it("simplifies two submeshes without opening cracks between them", async () => {
    const source = twoGroups(rock(4));
    expect(openEdges(source.streams, source.indices)).toBe(0); // closed, apart from the UV seam's welded positions
    const lods = await generateLods(source, DEFAULT_LOD_SETTINGS, "auto");
    for (const level of lods.levels) {
      expect(level.groups.map((g) => g.materialIndex)).toEqual([0, 1]);
      expect(level.groups[0].start).toBe(0);
      expect(level.groups[1].start).toBe(level.groups[0].count);
      expect(level.groups[0].count + level.groups[1].count).toBe(level.indices.length);
      expect(openEdges(lods.streams, level.indices)).toBe(0);
    }
    expect(lods.levels[3].triangles).toBeLessThan(lods.levels[0].triangles * 0.2);
  }, 60_000);

  it("keeps every vertex's joints, weights and morph deltas with its position through weld, simplification and reorder", async () => {
    const r = rock(3);
    const n = r.positions.length / 3;
    const rnd = random(7);
    // Skin: 4 influences of arbitrary joints and weights; two morph targets with arbitrary deltas; tangents and colours.
    const joints = Uint16Array.from({ length: n * 4 }, () => Math.floor(rnd() * 60));
    const weights = Float32Array.from({ length: n * 4 }, () => rnd());
    const morph = () => ({ positions: Float32Array.from({ length: n * 3 }, () => rnd() - 0.5), normals: Float32Array.from({ length: n * 3 }, () => rnd() - 0.5), tangents: null });
    const streams = streamsOf(r, { joints, weights, influences: 4, morphs: [morph(), morph()], tangents: Float32Array.from({ length: n * 4 }, () => rnd()), colors: Float32Array.from({ length: n * 4 }, () => rnd()), uvs2: Float32Array.from({ length: n * 2 }, () => rnd()) });
    const source: LodSource = { streams, indices: new Uint32Array(r.indices), groups: [] };
    const lods = await generateLods(source, UNLIMITED, "auto");
    // Every output vertex is exactly some input vertex, every stream together.
    const inputs = new Set(Array.from({ length: n }, (_, v) => vertexKey(streams, v)));
    for (let v = 0; v < lods.streams.positions.length / 3; v++) expect(inputs.has(vertexKey(lods.streams, v))).toBe(true);
    // LOD0 is the same triangles, by every stream; the levels use only LOD0's vertices.
    expect(triangleSet(lods.streams, lods.levels[0].indices)).toEqual(triangleSet(streams, source.indices));
    expect(lods.streams.joints!.length).toBe((lods.streams.positions.length / 3) * 4);
    expect(lods.streams.morphs).toHaveLength(2);
    expect(lods.streams.morphs[0].tangents).toBeNull();
    expect(lods.levels[3].triangles).toBeLessThan(lods.levels[0].triangles * 0.3);
  }, 60_000);

  it("orders the shared vertices coarsest level first", async () => {
    const source: LodSource = { streams: streamsOf(rock(4)), indices: new Uint32Array(rock(4).indices), groups: [] };
    const lods = await generateLods(source, DEFAULT_LOD_SETTINGS, "auto");
    const coarsest = lods.levels[lods.levels.length - 1];
    const used = new Set(coarsest.indices);
    // The coarsest level's vertices are exactly the first ones.
    expect(Math.max(...used)).toBe(used.size - 1);
  }, 60_000);

  it("is deterministic", async () => {
    const make = (): LodSource => twoGroups(rock(4));
    const settings: LodSettings = { ...DEFAULT_LOD_SETTINGS, permissive: true };
    const [a, b] = [await generateLods(make(), settings, "auto"), await generateLods(make(), settings, "auto")];
    const flat = (l: GeneratedLods) => ({ positions: Array.from(l.streams.positions), uvs: Array.from(l.streams.uvs!), levels: l.levels.map((lv) => ({ ...lv, indices: Array.from(lv.indices) })), bounds: l.bounds });
    expect(flat(a)).toEqual(flat(b));
  }, 60_000);

  it("gives the coarsest level, hole-trimmed, as the occluder stand-in for auto and lod, and none otherwise", async () => {
    const source = (): LodSource => ({ streams: streamsOf(rock(3)), indices: new Uint32Array(rock(3).indices), groups: [] });
    for (const setting of ["auto", "lod"] as const) {
      const lods = await generateLods(source(), DEFAULT_LOD_SETTINGS, setting);
      const coarsest = lods.levels[lods.levels.length - 1];
      const occluder = lods.occluder!;
      expect(occluder.error).toBe(coarsest.error);
      const kept = occluder.indices.length / 3;
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThanOrEqual(coarsest.triangles);
      // Each kept triangle is one of the level's, in the level's order.
      let at = 0;
      for (let t = 0; t < kept; t++) {
        const tri = Array.from(occluder.indices.subarray(t * 3, t * 3 + 3));
        while (at < coarsest.triangles && Array.from(coarsest.indices.subarray(at * 3, at * 3 + 3)).join() !== tri.join()) at++;
        expect(at).toBeLessThan(coarsest.triangles);
        at++;
      }
      expectTrimmed(occluder);
    }
    expect((await generateLods(source(), DEFAULT_LOD_SETTINGS, "none")).occluder).toBeNull();
    const noLevels = await generateLods(source(), { ...DEFAULT_LOD_SETTINGS, levels: [] }, "auto");
    expect(noLevels.levels).toHaveLength(1);
    expect(noLevels.occluder).toBeNull();
  }, 60_000);

  it("honours the error limit, permissive and locked borders", async () => {
    // An open sheet: a grid with a bumpy middle and a straight border.
    const N = 40;
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
    for (let y = 0; y <= N; y++) for (let x = 0; x <= N; x++) positions.push(x / N, 0.02 * Math.sin(x * 0.7) * Math.cos(y * 0.5), y / N), normals.push(0, 1, 0), uvs.push(x / N, y / N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * (N + 1) + x;
      indices.push(i, i + N + 1, i + 1, i + 1, i + N + 1, i + N + 2);
    }
    const source = (): LodSource => ({ streams: streamsOf({ positions, normals, uvs }), indices: new Uint32Array(indices), groups: [] });
    const borderOf = (s: VertexStreams, idx: Uint32Array) => {
      const keys = new Set<string>();
      for (let k = 0; k < idx.length; k++) {
        const x = s.positions[idx[k] * 3], z = s.positions[idx[k] * 3 + 2];
        if (x === 0 || x === 1 || z === 0 || z === 1) keys.add(positionKey(s, idx[k]));
      }
      return keys.size;
    };
    const tight = await generateLods(source(), { ...DEFAULT_LOD_SETTINGS, levels: [{ ratio: 0.05, error: 0.0001 }] }, "auto");
    const loose = await generateLods(source(), { ...DEFAULT_LOD_SETTINGS, levels: [{ ratio: 0.05, error: 0.1 }] }, "auto");
    expect(tight.levels[1].triangles).toBeGreaterThan(loose.levels[1].triangles);
    const locked = await generateLods(source(), { ...DEFAULT_LOD_SETTINGS, lockBorders: true, levels: [{ ratio: 0.05, error: 0.1 }] }, "auto");
    // Every border vertex of LOD0 is kept when borders are locked (4N of them).
    expect(borderOf(locked.streams, locked.levels[1].indices)).toBe(4 * N);
    expect(borderOf(loose.streams, loose.levels[1].indices)).toBeLessThan(4 * N);
    // No submesh goes below 1 % of its triangles, at least 12.
    const floor = await generateLods(source(), { ...DEFAULT_LOD_SETTINGS, permissive: true, levels: [{ ratio: 0.001, error: 1 }] }, "auto");
    expect(floor.levels[1].triangles).toBeGreaterThanOrEqual(Math.ceil(0.01 * N * N * 2));
  }, 60_000);
});

describe("occluder stand-in trimming (ADR 0447 §3)", () => {
  /** A sheet on [0, 1]² bumped by `bump` in z, simplified to 1 % of its triangles. */
  const bumpySheet = (bump: number): LodSource => {
    const N = 40;
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
    for (let y = 0; y <= N; y++) for (let x = 0; x <= N; x++) positions.push(x / N, y / N, bump * Math.sin(x) * Math.cos(y)), normals.push(0, 0, 1), uvs.push(x / N, y / N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * (N + 1) + x;
      indices.push(i, i + 1, i + N + 1, i + 1, i + N + 2, i + N + 1);
    }
    return { streams: streamsOf({ positions, normals, uvs }), indices: new Uint32Array(indices), groups: [] };
  };
  const coarse: LodSettings = { ...DEFAULT_LOD_SETTINGS, levels: [{ ratio: 0.01, error: 1 }] };

  it("keeps every triangle of a close stand-in, sharing the level's indices, each with its own error", async () => {
    const lods = await generateLods(bumpySheet(0.0005), coarse, "auto");
    const occluder = lods.occluder!;
    expect(occluder.indices).toBe(lods.levels[1].indices);
    expectTrimmed(occluder);
    expect(Math.max(...occluder.triangleErrors)).toBeGreaterThan(0);
  }, 60_000);

  it("gives no stand-in when trimming drops every triangle (each lies farther than 0.5 % of the diagonal)", async () => {
    const lods = await generateLods(bumpySheet(0.02), coarse, "auto");
    expect(lods.levels[1].error).toBeGreaterThan(0.005);
    expect(lods.occluder).toBeNull();
  }, 60_000);
});

describe("the LOD cache", () => {
  it("generates once per mesh and settings", async () => {
    let calls = 0;
    const host: LodHost = {
      cache: memoryLodCache(),
      generate: async (source, settings, occluder) => (calls++, generateLods(source, settings, occluder)),
    };
    const source = (): LodSource => ({ streams: streamsOf(rock(2)), indices: new Uint32Array(rock(2).indices), groups: [] });
    const a = await cachedLods(host, source(), DEFAULT_LOD_SETTINGS, "auto");
    expect(await cachedLods(host, source(), DEFAULT_LOD_SETTINGS, "auto")).toBe(a);
    expect(calls).toBe(1);
    await cachedLods(host, source(), DEFAULT_LOD_SETTINGS, "none");
    await cachedLods(host, source(), { ...DEFAULT_LOD_SETTINGS, permissive: true }, "auto");
    const moved = source();
    (moved.streams.positions as Float32Array)[0] += 0.5;
    await cachedLods(host, moved, DEFAULT_LOD_SETTINGS, "auto");
    expect(calls).toBe(4);
  }, 60_000);
});

describe("the LOD worker protocol", () => {
  it("generates over a message port what generateLods gives inline", async () => {
    const channel = new MessageChannel();
    const ends = [channel.port1, channel.port2] as const;
    serveLodGeneration(ends[1] as unknown as LodPort);
    const generate = lodGeneratorOver(ends[0] as unknown as LodPort);
    ends[0].start();
    ends[1].start();
    try {
      const source = (): LodSource => twoGroups(rock(3));
      const [remote, inline] = await Promise.all([generate(source(), DEFAULT_LOD_SETTINGS, "auto"), generateLods(source(), DEFAULT_LOD_SETTINGS, "auto")]);
      expect(Array.from(remote.streams.positions)).toEqual(Array.from(inline.streams.positions));
      expect(remote.levels.map((l) => [Array.from(l.indices), l.groups, l.error])).toEqual(inline.levels.map((l) => [Array.from(l.indices), l.groups, l.error]));
      expect(remote.occluder!.error).toBe(inline.occluder!.error);
      expect(Array.from(remote.occluder!.indices)).toEqual(Array.from(inline.occluder!.indices));
      expect(remote.occluder!.triangleErrors).toEqual(inline.occluder!.triangleErrors);
      expect(remote.occluder!.neighbors).toEqual(inline.occluder!.neighbors);
      const broken = source();
      await expect(generate({ ...broken, streams: { ...broken.streams, positions: null as unknown as Float32Array } }, DEFAULT_LOD_SETTINGS, "auto")).rejects.toThrow();
    } finally {
      ends[0].close();
      ends[1].close();
    }
  }, 60_000);
});

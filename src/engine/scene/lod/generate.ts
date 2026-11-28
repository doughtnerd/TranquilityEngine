/**
 * Generating a mesh's LOD levels at import (ADR 0459 §1) with meshoptimizer's simplifier, and its occluder stand-in
 * (ADR 0460 §3). Runs in the editor's worker (`worker.ts`) and inline in the export; games never load it (they read
 * baked levels). Plain arrays in, plain arrays out, so a worker can run it. Internal: not public API.
 *
 * The pipeline, per mesh:
 * 1. Weld vertices whose every stream is bit-identical (`streams.ts`).
 * 2. Simplify each submesh with `Sparse`, locking vertices shared between submeshes; normals, UVs and colours weighted
 *    when `attributes`; `Permissive` and `LockBorder` from the settings; each level chained from the previous one, and no
 *    submesh below 1 % of its triangles (at least 12).
 * 3. Measure each level's error as a sampled two-way Hausdorff distance against LOD0 (`hausdorff.ts`), as a fraction
 *    of LOD0's bounding-box diagonal: never meshoptimizer's estimate.
 * 4. The occluder stand-in: the coarsest level, hole-trimmed (ADR 0460 §3, `standInTrim.ts`): triangles whose own error
 *    exceeds 0.5 % of the diagonal are dropped, and each kept one keeps its error and its edge neighbours. Where the
 *    trimming module can't load there is no stand-in (an untrimmed one isn't conservative), with a warning once.
 * 5. Reorder each level's triangles for the vertex cache, then the shared vertices coarsest level first for vertex fetch,
 *    remapping every stream with the one table.
 */
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { MeshoptSimplifier, type SimplifierFlags } from "meshoptimizer/simplifier";
import type { Bounds6, LodSettings, OccluderSetting, OccluderStandIn } from "./types";
import { hausdorffDistance, TriangleBvh } from "./hausdorff";
import { loadStandInTrimmer, type StandInTrimmer } from "./standInTrim";
import { remapIndices, remapStreams, UNUSED, vertexCount, weldRemap, type VertexStreams } from "./streams";

/** An index range drawn with one surface (`MeshData.groups`' shape). */
export interface LodGroup {
  readonly start: number;
  readonly count: number;
  readonly materialIndex: number;
}

/** A mesh as the generator takes it. */
export interface LodSource {
  readonly streams: VertexStreams;
  readonly indices: Uint32Array;
  /** Empty: one surface for all. */
  readonly groups: readonly LodGroup[];
}

/** One generated level: its own indices and groups over the shared streams. */
export interface GeneratedLevel {
  readonly indices: Uint32Array;
  readonly groups: readonly LodGroup[];
  /** Measured two-way sampled Hausdorff error against LOD0, as a fraction of LOD0's diagonal (0 for LOD0). */
  readonly error: number;
  readonly triangles: number;
}

/** What the generator gives back: the welded, reordered streams that every level shares, the levels and the stand-in. */
export interface GeneratedLods {
  readonly streams: VertexStreams;
  /** Level 0 (the welded, reordered original) first. */
  readonly levels: readonly GeneratedLevel[];
  /** The hole-trimmed stand-in (its `indices` are the coarsest level's own array when trimming kept every triangle). */
  readonly occluder: OccluderStandIn | null;
  readonly bounds: Bounds6;
}

/** Attribute weights for `simplifyWithAttributes` (the spike's: normals 1, UVs 0.5; colours, used as wind weights, 0.5). */
const WEIGHT = { normal: 1, uv: 0.5, color: 0.5 } as const;

/** The interleaved attribute buffer the simplifier weighs, or an empty one. */
function attributes(streams: VertexStreams, on: boolean): { buffer: Float32Array; stride: number; weights: number[] } {
  const parts: { array: Float32Array; size: number; weight: number }[] = [];
  if (on) {
    if (streams.normals) parts.push({ array: streams.normals, size: 3, weight: WEIGHT.normal });
    if (streams.uvs) parts.push({ array: streams.uvs, size: 2, weight: WEIGHT.uv });
    if (streams.colors) parts.push({ array: streams.colors, size: 4, weight: WEIGHT.color });
  }
  const stride = parts.reduce((n, p) => n + p.size, 0);
  const count = vertexCount(streams);
  const buffer = new Float32Array(count * stride);
  let at = 0;
  for (const p of parts) {
    for (let i = 0; i < count; i++) for (let k = 0; k < p.size; k++) buffer[i * stride + at + k] = p.array[i * p.size + k];
    at += p.size;
  }
  return { buffer, stride, weights: parts.flatMap((p) => Array<number>(p.size).fill(p.weight)) };
}

/** Per vertex, 1 when triangles of more than one group use it. */
function sharedVertices(indices: Uint32Array, groups: readonly LodGroup[], count: number): Uint8Array | null {
  if (groups.length < 2) return null;
  const first = new Int32Array(count).fill(-1);
  const shared = new Uint8Array(count);
  groups.forEach((g, gi) => {
    for (let k = g.start; k < g.start + g.count; k++) {
      const v = indices[k];
      if (first[v] < 0) first[v] = gi;
      else if (first[v] !== gi) shared[v] = 1;
    }
  });
  return shared;
}

/** Each group's triangles laid end to end (groups in order), with the groups that cover them. */
function concatenate(parts: readonly Uint32Array[], materials: readonly number[]): { indices: Uint32Array; groups: LodGroup[] } {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const indices = new Uint32Array(total);
  const groups: LodGroup[] = [];
  let at = 0;
  parts.forEach((p, i) => {
    indices.set(p, at);
    groups.push({ start: at, count: p.length, materialIndex: materials[i] });
    at += p.length;
  });
  return { indices, groups };
}

/** The bounds of the vertices `indices` uses. */
function boundsOf(positions: Float32Array, indices: Uint32Array): Bounds6 {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let k = 0; k < indices.length; k++) {
    const v = indices[k] * 3;
    const x = positions[v], y = positions[v + 1], z = positions[v + 2];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (z < z0) z0 = z;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    if (z > z1) z1 = z;
  }
  return indices.length ? [x0, y0, z0, x1, y1, z1] : [0, 0, 0, 0, 0, 0];
}

/** A group's triangles reordered for the post-transform vertex cache, keeping their vertex ids. */
function cacheOrder(indices: Uint32Array): Uint32Array {
  if (indices.length < 6) return indices.slice();
  const out = indices.slice();
  const [remap] = MeshoptEncoder.reorderMesh(out, true, false);
  // reorderMesh also renumbers the vertices (first use); undo that, keeping only the triangle order.
  const inverse = new Uint32Array(remap.length);
  for (let i = 0; i < remap.length; i++) if (remap[i] !== UNUSED) inverse[remap[i]] = i;
  for (let i = 0; i < out.length; i++) out[i] = inverse[out[i]];
  return out;
}

/** The fewest triangles a group of `triangles` keeps at any level: 1 %, at least 12 (or all it has). */
const minimumTriangles = (triangles: number): number => Math.min(triangles, Math.max(12, Math.ceil(triangles * 0.01)));

let trimmerWarned = false;

/** The stand-in trimmer, or null (with a warning, once) when its module can't be loaded. */
async function trimmer(): Promise<StandInTrimmer | null> {
  try {
    return await loadStandInTrimmer();
  } catch (err) {
    if (!trimmerWarned) {
      trimmerWarned = true;
      console.warn("[myco] couldn't load the occluder trimming module; models get no occluder stand-ins:", err);
    }
    return null;
  }
}

/**
 * The levels of `source` with `settings`, and its occluder stand-in (`occluder`). Deterministic: the same input always
 * gives the same output, in Node and the browser alike.
 */
export async function generateLods(source: LodSource, settings: LodSettings, occluder: OccluderSetting): Promise<GeneratedLods> {
  await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready]);
  // 1. Weld.
  const welded = weldRemap(source.streams);
  const streams = remapStreams(source.streams, welded.remap, welded.unique);
  const indices = remapIndices(source.indices, welded.remap);
  const count = welded.unique;
  const groupList: LodGroup[] = source.groups.length ? [...source.groups] : [{ start: 0, count: indices.length - (indices.length % 3), materialIndex: 0 }];
  const materials = groupList.map((g) => g.materialIndex);
  const lod0Parts = groupList.map((g) => indices.slice(g.start, g.start + g.count));
  const lod0 = concatenate(lod0Parts, materials);
  const bounds = boundsOf(streams.positions, lod0.indices);
  const diagonal = Math.hypot(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]);

  // 2. Simplify each group, each level from the previous one.
  const lock = sharedVertices(lod0.indices, lod0.groups, count);
  const attr = attributes(streams, settings.attributes);
  const flags: SimplifierFlags[] = ["ErrorAbsolute", "Sparse"];
  if (settings.permissive) flags.push("Permissive");
  if (settings.lockBorders) flags.push("LockBorder");
  const lod0Triangles = lod0Parts.map((p) => p.length / 3);
  const partsPerLevel: Uint32Array[][] = [lod0Parts];
  let previous: Uint32Array[] = lod0Parts;
  for (const level of settings.levels) {
    const limit = level.error * diagonal;
    const parts = previous.map((from, gi) => {
      const target = Math.min(from.length / 3, Math.max(Math.round(level.ratio * lod0Triangles[gi]), minimumTriangles(lod0Triangles[gi])));
      if (target * 3 >= from.length) return from;
      const [out] = MeshoptSimplifier.simplifyWithAttributes(from, streams.positions, 3, attr.buffer, attr.stride, attr.weights, lock, target * 3, limit, flags);
      return out;
    });
    partsPerLevel.push(parts);
    previous = parts;
  }

  // 5 (before measuring: the error doesn't depend on the order). Cache order per level, then fetch order coarsest first.
  const ordered = partsPerLevel.map((parts) => parts.map(cacheOrder));
  const fetch = new Uint32Array(count).fill(UNUSED);
  let next = 0;
  for (let l = ordered.length - 1; l >= 0; l--) {
    for (const part of ordered[l]) {
      for (let k = 0; k < part.length; k++) if (fetch[part[k]] === UNUSED) fetch[part[k]] = next++;
    }
  }
  const finalStreams = remapStreams(streams, fetch, next);
  const levelsIndexed = ordered.map((parts) => concatenate(parts.map((p) => remapIndices(p, fetch)), materials));

  // 3. Measure every level against LOD0.
  const positions = finalStreams.positions;
  const original = { positions, indices: levelsIndexed[0].indices, bvh: new TriangleBvh(positions, levelsIndexed[0].indices) };
  const keepGroups = source.groups.length > 0;
  const levels: GeneratedLevel[] = levelsIndexed.map((lv, l) => {
    const measured = l === 0 || diagonal === 0 ? 0 : hausdorffDistance(original, { positions, indices: lv.indices }) / diagonal;
    const error = Number.isFinite(measured) ? measured : 1; // a level with no triangles left: as far off as the whole mesh
    return { indices: lv.indices, groups: keepGroups ? lv.groups : [], error, triangles: lv.indices.length / 3 };
  });

  // 4. The occluder stand-in: the coarsest generated level, hole-trimmed against LOD0.
  const coarsest = levels.length > 1 ? levels[levels.length - 1] : null;
  let standIn: OccluderStandIn | null = null;
  const trim = occluder !== "none" && coarsest && coarsest.triangles > 0 && diagonal > 0 ? await trimmer() : null;
  if (trim && coarsest) {
    const trimmed = trim(positions, levelsIndexed[0].indices, coarsest.indices);
    if (trimmed.indices.length > 0) {
      standIn = {
        // Trimming keeps triangles in order, so when it kept them all they're the level's own indices (stored once).
        indices: trimmed.indices.length === coarsest.indices.length ? coarsest.indices : trimmed.indices,
        // The whole stand-in's error stays the coarsest level's measured two-way Hausdorff error: trimming only removes
        // triangles, and the runtime's conservative rules use each triangle's own error (`triangleErrors`).
        error: coarsest.error,
        triangleErrors: trimmed.triangleErrors,
        neighbors: trimmed.neighbors,
      };
    }
  }
  return { streams: finalStreams, levels, occluder: standIn, bounds };
}

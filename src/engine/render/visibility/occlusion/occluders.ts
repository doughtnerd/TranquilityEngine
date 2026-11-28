/**
 * What a renderer occludes with (ADR 0447 §3), renderer-neutrally, and its triangles in world space for the core.
 *
 * - **Geometry:** a model mesh's trimmed stand-in from import (`ModelLods.occluder`, with per-triangle errors and edge
 *   neighbours), else, for a mesh of at most 512 triangles, the mesh itself (error 0, neighbours computed here once).
 *   A mesh with neither doesn't occlude.
 * - **Opacity:** only an opaque material occludes: a material asset whose `alphaMode` is `"opaque"`, or `"auto"` with
 *   a fully opaque colour (cut-outs and blends don't); without an asset, the model's own surfaces, all opaque. Anything
 *   else (a shader graph named directly, a file that doesn't parse) doesn't occlude.
 * - **Winding:** triangles go to the core as engine meshes wind them (`scene/winding.ts`, ADR 0450), with their edge
 *   neighbours as they are.
 * - **Errors:** stored as fractions of LOD0's bounding-box diagonal; the core gets them in world units, doubled (ADR
 *   0447 §3, "errors doubled").
 *
 * Not public API.
 */
import { Assets } from "../../../scene/Assets";
import { parseMaterial } from "../../../scene/material";
import type { ModelMesh } from "../../../scene/models";
import { edgeNeighbors, NO_NEIGHBOR } from "./neighbors";

/** Most triangles a mesh occludes with itself, without an import-time stand-in (ADR 0447 §3). */
export const SELF_OCCLUDER_TRIANGLES = 512;

/** A mesh's occluder geometry in model space. */
export interface OccluderGeometry {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** Per triangle, its error as a fraction of `diagonal`, before doubling. */
  readonly errors: Float32Array;
  readonly neighbors: Uint32Array;
  /** LOD0's bounding-box diagonal in model units (what `errors` are fractions of). */
  readonly diagonal: number;
}

const geometries = new WeakMap<ModelMesh, OccluderGeometry | null>();

/** The geometry `mesh` occludes with, or null for none. Cached per mesh. */
export function occluderGeometry(mesh: ModelMesh): OccluderGeometry | null {
  if (geometries.has(mesh)) return geometries.get(mesh)!;
  let g: OccluderGeometry | null = null;
  const stand = mesh.lods?.occluder;
  const lod0 = mesh.lods?.levels[0]?.mesh.data ?? mesh.data;
  if (stand && lod0 && stand.triangleErrors.length * 3 === stand.indices.length && stand.neighbors.length === stand.indices.length && stand.indices.length > 0) {
    const b = mesh.lods!.bounds;
    g = { positions: lod0.positions, indices: stand.indices, errors: stand.triangleErrors, neighbors: stand.neighbors, diagonal: Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) };
  } else if (mesh.data && mesh.data.indices.length > 0 && mesh.data.indices.length / 3 <= SELF_OCCLUDER_TRIANGLES) {
    const n = mesh.data.indices.length / 3;
    g = { positions: mesh.data.positions, indices: mesh.data.indices, errors: new Float32Array(n), neighbors: edgeNeighbors(mesh.data.indices), diagonal: 0 };
  }
  geometries.set(mesh, g);
  return g;
}

/** Material assets' opacity, by the parsed file's value (a rewritten file is judged again). */
const opaqueAssets = new WeakMap<object, boolean>();

/** Whether a renderer drawing `meshes` with material asset `path` (empty: the models' own surfaces) is opaque. */
export function opaqueMaterial(path: string, meshes: readonly ModelMesh[]): boolean {
  if (path) {
    let raw: unknown;
    try {
      raw = Assets.get(path);
    } catch {
      return false;
    }
    if (typeof raw !== "object" || raw === null) return false;
    const known = opaqueAssets.get(raw);
    if (known !== undefined) return known;
    let opaque = false;
    try {
      const { settings } = parseMaterial(raw, path);
      opaque = settings.alphaMode === "opaque" || (settings.alphaMode === "auto" && settings.color.a >= 1);
    } catch {
      opaque = false;
    }
    opaqueAssets.set(raw, opaque);
    return opaque;
  }
  for (const m of meshes) {
    for (const s of m.surfaces) {
      const mode = s.alphaMode ?? (s.transparent ? "blend" : "opaque");
      if (mode !== "opaque" || s.opacity < 1) return false;
    }
  }
  return true;
}

/** A renderer's occluder triangles in world space, as the core takes them. */
export interface WorldOccluder {
  /** 9 floats per triangle, in the engine's winding. */
  readonly triangles: Float32Array;
  /** World-space error per triangle, doubled. */
  readonly errors: Float32Array;
  /** Edge neighbours per triangle (edges a→b, b→c, c→a), indices into this list. */
  readonly neighbors: Uint32Array;
  readonly count: number;
}

/** `geometries` transformed by the world matrix at `m[o]` into one list (neighbours rebased per mesh). */
export function worldOccluder(geometries: readonly OccluderGeometry[], m: ArrayLike<number>, o: number): WorldOccluder {
  let count = 0;
  for (const g of geometries) count += g.indices.length / 3;
  const triangles = new Float32Array(count * 9), errors = new Float32Array(count), neighbors = new Uint32Array(count * 3);
  const scale = maxScale(m, o);
  let t = 0;
  for (const g of geometries) {
    const base = t, n = g.indices.length / 3, p = g.positions, idx = g.indices, factor = 2 * g.diagonal * scale;
    for (let i = 0; i < n; i++, t++) {
      for (let k = 0; k < 3; k++) {
        const v = idx[i * 3 + k] * 3, x = p[v], y = p[v + 1], z = p[v + 2];
        triangles[t * 9 + k * 3] = m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12];
        triangles[t * 9 + k * 3 + 1] = m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13];
        triangles[t * 9 + k * 3 + 2] = m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14];
      }
      errors[t] = g.errors[i] * factor;
      for (let k = 0; k < 3; k++) {
        const e = g.neighbors[i * 3 + k];
        neighbors[t * 3 + k] = e === NO_NEIGHBOR ? NO_NEIGHBOR : base + e;
      }
    }
  }
  return { triangles, errors, neighbors, count };
}

/** The largest axis scale of the matrix at `m[o]`. */
function maxScale(m: ArrayLike<number>, o: number): number {
  const sx = Math.hypot(m[o], m[o + 1], m[o + 2]), sy = Math.hypot(m[o + 4], m[o + 5], m[o + 6]), sz = Math.hypot(m[o + 8], m[o + 9], m[o + 10]);
  return Math.max(sx, sy, sz);
}

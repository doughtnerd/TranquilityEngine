/**
 * Bounds for the visibility stage (ADR 0446 §3): each renderer's local AABB from its meshes, and its world AABB and
 * sphere, recomputed only when its world matrix changes (`matrixChanged`); an `LODGroup`'s bounds as the union of its
 * members', and its automatic size. Renderer-neutral, no backend imports. Not public API.
 *
 * Matrices are column-major (translation at 12, 13, 14), as the World stores them.
 */
import { Mat4 } from "../../core/math";
import type { MeshData, ModelMesh } from "../../scene/models";
import { matrixChanged } from "../changeDetection";

/** minX, minY, minZ, maxX, maxY, maxZ. */
export type Aabb = Float32Array;

const dataBounds = new WeakMap<MeshData, Float32Array>();

/** The AABB of a mesh's vertices, computed once per `MeshData` and cached (an empty mesh: all zeros). */
export function meshDataBounds(data: MeshData): Readonly<Aabb> {
  let b = dataBounds.get(data);
  if (b) return b;
  const p = data.positions;
  b = new Float32Array(6);
  if (p.length >= 3) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    b.set([x0, y0, z0, x1, y1, z1]);
  }
  dataBounds.set(data, b);
  return b;
}

/** A mesh's model-space bounds: its generated levels' (`ModelLods.bounds`), else its vertices'. */
export function meshBounds(mesh: ModelMesh): Readonly<ArrayLike<number>> {
  return mesh.lods?.bounds ?? meshDataBounds(mesh.data);
}

/** The largest axis scale of the matrix at `m[o]`. */
export function maxScale(m: ArrayLike<number>, o: number): number {
  return Math.max(Math.hypot(m[o], m[o + 1], m[o + 2]), Math.hypot(m[o + 4], m[o + 5], m[o + 6]), Math.hypot(m[o + 8], m[o + 9], m[o + 10]));
}

/**
 * Write into `out` (6 floats from `oo`) the AABB of `local` transformed by the matrix at `m[mo]`: the transformed
 * centre, and each half-extent summed over the matrix's absolute entries (Arvo).
 */
export function transformAabb(local: ArrayLike<number>, m: ArrayLike<number>, mo: number, out: Float32Array, oo = 0): void {
  const cx = (local[0] + local[3]) / 2, cy = (local[1] + local[4]) / 2, cz = (local[2] + local[5]) / 2;
  const ex = (local[3] - local[0]) / 2, ey = (local[4] - local[1]) / 2, ez = (local[5] - local[2]) / 2;
  for (let r = 0; r < 3; r++) {
    const c = m[mo + r] * cx + m[mo + 4 + r] * cy + m[mo + 8 + r] * cz + m[mo + 12 + r];
    const e = Math.abs(m[mo + r]) * ex + Math.abs(m[mo + 4 + r]) * ey + Math.abs(m[mo + 8 + r]) * ez;
    out[oo + r] = c - e;
    out[oo + 3 + r] = c + e;
  }
}

/** One renderer's cached bounds. */
export class RendererBounds {
  /** The world matrix the world bounds were computed from (`matrixChanged`'s entry). */
  matrix: Float32Array | null = null;
  /** Whether it has local bounds: false while its model loads. */
  hasLocal = false;
  /** Bumped each time the meshes, and so the local bounds, change. */
  localVersion = 0;
  /** Model-space AABB of every mesh it draws. */
  readonly local: Aabb = new Float32Array(6);
  /** World-space AABB. */
  readonly world: Aabb = new Float32Array(6);
  /** World-space bounding sphere: x, y, z, radius. */
  readonly sphere = new Float32Array(4);
  /** The meshes `local` was computed from (by identity, element by element). */
  private meshes: readonly ModelMesh[] | null = null;

  /**
   * Bring the bounds up to date for `meshes` (null while loading) at the world matrix `m[o]`. Local bounds are recomputed
   * only when the meshes change, world bounds only when the matrix or the local bounds change. True when the world
   * bounds changed.
   */
  update(meshes: readonly ModelMesh[] | null, m: ArrayLike<number>, o: number): boolean {
    const localChanged = this.updateLocal(meshes);
    const moved = matrixChanged(this, m, o);
    if (!moved && !localChanged) return false;
    const w = this.matrix!;
    const s = this.sphere;
    if (!this.hasLocal) {
      // No geometry yet: a point at the node's origin.
      this.world.set([w[12], w[13], w[14], w[12], w[13], w[14]]);
      s.set([w[12], w[13], w[14], 0]);
      return true;
    }
    transformAabb(this.local, w, 0, this.world);
    const l = this.local;
    const c = Mat4.transformPoint(w, 0, (l[0] + l[3]) / 2, (l[1] + l[4]) / 2, (l[2] + l[5]) / 2);
    s[0] = c[0];
    s[1] = c[1];
    s[2] = c[2];
    s[3] = (Math.hypot(l[3] - l[0], l[4] - l[1], l[5] - l[2]) / 2) * maxScale(w, 0);
    return true;
  }

  private updateLocal(meshes: readonly ModelMesh[] | null): boolean {
    const prev = this.meshes;
    if (prev === meshes) return false;
    if (prev && meshes && prev.length === meshes.length && prev.every((m, i) => m === meshes[i])) {
      this.meshes = meshes;
      return false;
    }
    this.meshes = meshes;
    const was = this.hasLocal;
    this.hasLocal = false;
    const l = this.local;
    l.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (const mesh of meshes ?? []) {
      const b = meshBounds(mesh);
      for (let i = 0; i < 3; i++) {
        if (b[i] < l[i]) l[i] = b[i];
        if (b[i + 3] > l[i + 3]) l[i + 3] = b[i + 3];
      }
      this.hasLocal = true;
    }
    if (!this.hasLocal) l.fill(0);
    this.localVersion++;
    return this.hasLocal || was;
  }
}

/** An `LODGroup`'s bounds, computed from its members'. */
export interface GroupBounds {
  /** World AABB, the union of the members'. */
  readonly world: Aabb;
  /** World sphere around `world`: x, y, z, radius. */
  readonly sphere: Float32Array;
  /** The automatic size (ADR 0446 §2): the diagonal of the members' combined local bounds × the node's largest world scale. */
  size: number;
}

export const newGroupBounds = (): GroupBounds => ({ world: new Float32Array(6), sphere: new Float32Array(4), size: 0 });

const inverse = new Float32Array(16);
const toGroup = new Float32Array(16);
const box = new Float32Array(6);
const local = new Float32Array(6);

/**
 * Compute `out` for a group whose node has the world matrix `g[go]` from its members' bounds. Members without local
 * bounds (still loading) are left out; with none at all the group is a point at its node's origin with size 0. The
 * combined local bounds are the members' local AABBs taken into the group node's space, so the size doesn't change as
 * the group turns.
 */
export function computeGroupBounds(members: readonly RendererBounds[], g: ArrayLike<number>, go: number, out: GroupBounds): void {
  const w = out.world;
  w.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  box.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  const invertible = Mat4.invert(inverse, 0, g as Float32Array, go);
  let any = false;
  for (const m of members) {
    if (!m.hasLocal || !m.matrix) continue;
    any = true;
    for (let i = 0; i < 3; i++) {
      if (m.world[i] < w[i]) w[i] = m.world[i];
      if (m.world[i + 3] > w[i + 3]) w[i + 3] = m.world[i + 3];
    }
    if (!invertible) continue;
    Mat4.multiply(toGroup, 0, inverse, 0, m.matrix, 0);
    transformAabb(m.local, toGroup, 0, local);
    for (let i = 0; i < 3; i++) {
      if (local[i] < box[i]) box[i] = local[i];
      if (local[i + 3] > box[i + 3]) box[i + 3] = local[i + 3];
    }
  }
  const s = out.sphere;
  if (!any) {
    w.set([g[go + 12], g[go + 13], g[go + 14], g[go + 12], g[go + 13], g[go + 14]]);
    s.set([g[go + 12], g[go + 13], g[go + 14], 0]);
    out.size = 0;
    return;
  }
  s[0] = (w[0] + w[3]) / 2;
  s[1] = (w[1] + w[4]) / 2;
  s[2] = (w[2] + w[5]) / 2;
  s[3] = Math.hypot(w[3] - w[0], w[4] - w[1], w[5] - w[2]) / 2;
  out.size = invertible ? Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) * maxScale(g, go) : 2 * s[3];
}

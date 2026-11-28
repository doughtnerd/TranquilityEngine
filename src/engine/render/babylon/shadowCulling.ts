/**
 * Per-cascade shadow caster culling for Babylon's cascaded shadow maps (ADR 0075). Babylon draws every
 * caster into every cascade. This hands the shadow map, per cascade (layer), only the casters whose bounds reach that cascade's box:
 * inside its four sides and nearer the light than its far side. The near side isn't tested: with depth
 * clamping a caster between the light and the box still shadows it.
 *
 * ADR 0459 §3: a caster that stands for many (a thin batch's casters) is handed to an expander, which
 * replaces it with that cascade's own mesh holding only the instances that reach the cascade (per-cascade compaction).
 */
import { BoundingBox } from "@babylonjs/core/Culling/boundingBox.js";
import { Frustum } from "@babylonjs/core/Maths/math.frustum.js";
import { Plane } from "@babylonjs/core/Maths/math.plane.js";
import type { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";

/** A shadow map's `getCustomRenderList`: each layer's casters, from that layer's view-projection matrix. */
export type CustomRenderList = (layer: number, list: readonly AbstractMesh[], length: number) => AbstractMesh[] | null;

/**
 * Casters that stand for many (ADR 0459 §3): `expand` gets one of the shadow map's casters, and when it is one of its
 * own, appends what cascade `layer` of caster list `list` draws instead (nothing when no instance reaches it) and
 * returns true; false leaves the caster to the box test.
 */
export interface CascadeExpander {
  expand(mesh: AbstractMesh, list: number, layer: number, planes: readonly Plane[], out: AbstractMesh[]): boolean;
}

/**
 * Whether the world AABB at `box[o]` (minX, minY, minZ, maxX, maxY, maxZ) reaches the inside of every plane: for each,
 * the box's corner furthest along the plane's normal is on its inner side (dot ≥ 0).
 */
export function aabbInPlanes(box: ArrayLike<number>, planes: readonly Plane[], o = 0): boolean {
  for (const p of planes) {
    const n = p.normal;
    const x = n.x >= 0 ? box[o + 3] : box[o], y = n.y >= 0 ? box[o + 4] : box[o + 1], z = n.z >= 0 ? box[o + 5] : box[o + 2];
    if (n.x * x + n.y * y + n.z * z + p.d < 0) return false;
  }
  return true;
}

let lists = 0;

/**
 * `getCustomRenderList` for a cascaded shadow map whose cascade `layer` projects with `transformOf(layer)`. Casters the
 * expander (when given, read each call) claims are replaced by its per-cascade meshes.
 */
export function cascadeCasterList(transformOf: (layer: number) => Matrix | null, expander: () => CascadeExpander | null = () => null): CustomRenderList {
  const id = ++lists;
  const planes = [0, 1, 2, 3, 4, 5].map(() => new Plane(0, 0, 0, 0));
  // The near plane replaced by one every point is in front of (0·p + 1 ≥ 0).
  const tested = [new Plane(0, 0, 0, 1), planes[1], planes[2], planes[3], planes[4], planes[5]];
  const out: AbstractMesh[][] = [];
  return (layer, list, length) => {
    const transform = transformOf(layer);
    if (!transform) return null; // Babylon then draws the whole list
    Frustum.GetPlanesToRef(transform, planes);
    const casters = (out[layer] ??= []);
    casters.length = 0;
    const many = expander();
    for (let i = 0; i < length; i++) {
      const mesh = list[i];
      if (!mesh) continue;
      if (many?.expand(mesh, id, layer, tested, casters)) continue;
      if (BoundingBox.IsInFrustum(mesh.getBoundingInfo().boundingBox.vectorsWorld, tested)) casters.push(mesh);
    }
    return casters;
  };
}

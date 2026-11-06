/**
 * Per-cascade shadow caster culling for Babylon's cascaded shadow maps (ADR 0075). Babylon draws every
 * caster into every cascade; three.js's CSM culls each cascade's shadow camera like any camera. This
 * hands the shadow map, per cascade (layer), only the casters whose bounds reach that cascade's box:
 * inside its four sides and nearer the light than its far side. The near side isn't tested: with depth
 * clamping a caster between the light and the box still shadows it.
 */
import { BoundingBox } from "@babylonjs/core/Culling/boundingBox.js";
import { Frustum } from "@babylonjs/core/Maths/math.frustum.js";
import { Plane } from "@babylonjs/core/Maths/math.plane.js";
import type { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";

/** A shadow map's `getCustomRenderList`: each layer's casters, from that layer's view-projection matrix. */
export type CustomRenderList = (layer: number, list: readonly AbstractMesh[], length: number) => AbstractMesh[] | null;

/** `getCustomRenderList` for a cascaded shadow map whose cascade `layer` projects with `transformOf(layer)`. */
export function cascadeCasterList(transformOf: (layer: number) => Matrix | null): CustomRenderList {
  const planes = [0, 1, 2, 3, 4, 5].map(() => new Plane(0, 0, 0, 0));
  // The near plane replaced by one every point is in front of (0·p + 1 ≥ 0).
  const tested = [new Plane(0, 0, 0, 1), planes[1], planes[2], planes[3], planes[4], planes[5]];
  const lists: AbstractMesh[][] = [];
  return (layer, list, length) => {
    const transform = transformOf(layer);
    if (!transform) return null; // Babylon then draws the whole list
    Frustum.GetPlanesToRef(transform, planes);
    const out = (lists[layer] ??= []);
    out.length = 0;
    for (let i = 0; i < length; i++) {
      const mesh = list[i];
      if (mesh && BoundingBox.IsInFrustum(mesh.getBoundingInfo().boundingBox.vectorsWorld, tested)) out.push(mesh);
    }
    return out;
  };
}

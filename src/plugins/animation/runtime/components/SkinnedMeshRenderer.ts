/**
 * Draws a skinned mesh (ADR 0370, 0372): replaces `MeshRenderer` for meshes with a skin. The engine skins it on the GPU
 * (one `mycoSkin` kernel, ADR 0370) from the bone matrices of `skeleton`'s pose, and Babylon draws the result as an
 * ordinary mesh, so shadows, depth and picking reuse it. Morph weights are animatable fields.
 */
import { Component } from "../../../../engine/core/Component";
import type { LodMember, OcclusionRole } from "../../../../engine/render/visibility/types";
import { meshesIfLoaded, type ModelMesh } from "../../../../engine/scene/models";
import { Vector3 } from "../../../../engine/core/math";
import { AssetRef, component, field } from "../../../../engine/core/registry";
import { GameObject } from "../../../../engine/scene/GameObject";
import { skinnedMeshHooks } from "../features/skinning";
import type { SkinnedBoundsMode } from "../types";

@component("engine.SkinnedMeshRenderer")
export class SkinnedMeshRenderer extends Component implements LodMember {
  /** The skinned mesh (`asset:hero.glb#Body`). */
  @field(AssetRef, { kind: "mesh", animatable: false, description: "The skinned mesh." })
  mesh = "";
  /** A material asset for the whole mesh. Empty: the model's own materials. */
  @field(AssetRef, { kind: "material", description: "A material for the whole mesh. Empty: the model's own." })
  material = "";
  /** A material asset per material slot, drawn in place of `material` for that slot (as `MeshRenderer.materials`, ADR 0089). */
  @field([AssetRef], { kind: "material", description: "A material per slot, in place of the whole mesh's." })
  materials: string[] = [];
  /** The node with the `Skeleton` that deforms the mesh. Null: the nearest ancestor with one. */
  @field(GameObject, { animatable: false, description: "The node whose Skeleton deforms the mesh. Empty: the nearest ancestor with one." })
  skeleton: GameObject | null = null;
  /** How culling bounds are found: from the animated bones each frame, or the fixed box below. */
  @field(String, { choices: ["bones", "fixed"], animatable: false, description: "Culling bounds from the animated bones, or a fixed box." })
  boundsMode: SkinnedBoundsMode = "bones";
  /** With `boundsMode: "fixed"`: the bounds' centre, relative to the node. */
  @field(Vector3, { animatable: false, description: "The fixed bounds' centre, relative to the node." })
  boundsCenter = new Vector3(0, 1, 0);
  /** With `boundsMode: "fixed"`: the bounds' size. */
  @field(Vector3, { animatable: false, description: "The fixed bounds' size." })
  boundsSize = new Vector3(2, 2, 2);
  /** Morph target weights, in the mesh's morph target order (0–1 each). Animated by `morph` tracks. */
  @field([Number], { animatable: true, description: "Morph target weights, in the mesh's order." })
  morphWeights: number[] = [];
  /** Cast shadows from Lights with `castShadows` on. */
  @field(Boolean, { description: "Cast shadows." })
  castShadows = true;
  /** Show shadows cast onto it. */
  @field(Boolean, { description: "Show shadows cast onto it." })
  receiveShadows = true;

  /**
   * Its part in occlusion culling (ADR 0447 §3). A skinned mesh is an occludee only: it is hidden when something covers
   * it and never hides anything, whatever this says; "none" always draws it.
   */
  @field(String, {
    choices: ["auto", "occluder", "occludee", "none"],
    description: "Its part in occlusion culling. A skinned mesh never hides anything: it is hidden when covered, unless None (always drawn).",
  })
  occlusion: OcclusionRole = "auto";

  /** @internal The LOD0 model meshes it draws (ADR 0446 §2: what an `LODGroup` controls), or null while its model loads. */
  lodMeshes(): readonly ModelMesh[] | null {
    return meshesIfLoaded(this.mesh);
  }

  override _onAttach(): void {
    skinnedMeshHooks.attach?.(this);
  }

  override _onActivate(): void {
    skinnedMeshHooks.activate?.(this);
  }

  override _onDeactivate(): void {
    skinnedMeshHooks.deactivate?.(this);
  }

  override _onDetach(): void {
    skinnedMeshHooks.detach?.(this);
  }
}

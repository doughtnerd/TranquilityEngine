/**
 * The engine-owned visibility stage's shapes (ADR 0446 §3, 0447 §2): what each view draws, decided renderer-neutrally
 * and read by the Babylon mesh feature and the animation plugin's skinned feature. Not public API.
 *
 * Contract stub written by the coordinator before wave 1 (docs/plans/2026-11-lod-occlusion-plan.md, "Contracts");
 * only the coordinator edits it.
 */
import type { GameObject } from "../../scene/GameObject";
import type { ModelMesh } from "../../scene/models";

/** A level byte meaning "not drawn because LOD culled it". */
export const LOD_CULLED = 255;

/** What kind of render a view is (ADR 0129's outputs, plus probe captures). */
export type ViewKind = "camera" | "texture" | "sceneView" | "preview" | "probe";

/** Identifies a view across frames: fade and hysteresis state are kept per key. */
export type ViewKey = string;

/** One view's inputs to selection and occlusion, in world space. */
export interface VisibilityView {
  readonly key: ViewKey;
  readonly kind: ViewKind;
  /** Camera position. */
  readonly position: readonly [number, number, number];
  /** View-projection matrix, column-major. */
  readonly viewProjection: Float32Array;
  /** Six frustum planes (a, b, c, d each; inside where ax + by + cz + d >= 0). */
  readonly planes: Float32Array;
  readonly projection: "perspective" | "orthographic";
  /** Vertical field of view in radians (perspective). */
  readonly fovY: number;
  /** Half the view's height in world units (orthographic). */
  readonly orthoHalfHeight: number;
  /** The view's height in device pixels. */
  readonly heightPx: number;
  /** Persistent views keep fade and hysteresis state; probes and thumbnails don't. */
  readonly persistent: boolean;
  /** Whether occlusion runs for this view (ADR 0447 §4). */
  readonly occlusion: boolean;
  /** Near and far distances. */
  readonly near: number;
  readonly far: number;
  /** The projection's x and y scale: a world size at distance 1 in half-viewports (perspective), or per world unit (orthographic). */
  readonly sx: number;
  readonly sy: number;
}

/** Why a group or renderer isn't drawn, or that it is (`LODGroup.visibility`, ADR 0446 §2). */
export type LodVisibility = "drawn" | "lodCulled" | "offScreen" | "occluded";

/** A renderer's occlusion role (`MeshRenderer.occlusion`, ADR 0447 §3). */
export type OcclusionRole = "auto" | "occluder" | "occludee" | "none";

/**
 * A component an `LODGroup` controls (ADR 0446 §2): `MeshRenderer` in core and `SkinnedMeshRenderer` in the animation
 * plugin implement it, so core never imports a plugin.
 */
export interface LodMember {
  readonly gameObject: GameObject;
  readonly isActiveAndEnabled: boolean;
  /** The LOD0 model meshes it draws, or null while its model loads. */
  lodMeshes(): readonly ModelMesh[] | null;
  readonly occlusion: OcclusionRole;
  /** Whether it casts shadows (casters follow `VisibilityResult.casterLevels`). */
  readonly castShadows: boolean;
}

/** One view's result: the renderer side draws exactly this. */
export interface VisibilityResult {
  readonly view: VisibilityView;
  /** Per renderer slot: the level to draw, or `LOD_CULLED`. */
  readonly levels: Uint8Array;
  /**
   * Per renderer slot, for shadow casters (main view only, ADR 0446 §3): the level casters draw, or `LOD_CULLED` when
   * the renderer casts no shadow. LOD-culled groups cast at their coarsest level up to the tier's `shadowDistance`.
   */
  readonly casterLevels: Uint8Array;
  /** Per renderer slot: 1 when off-screen or occluded in this view (drawn otherwise, at `levels`). */
  readonly hidden: Uint8Array;
  /** Per renderer slot, during a crossfade: the fade value (0 steady; see ADR 0446 §4 for the sign convention). */
  readonly fade: Float32Array;
}

/** The per-view statistics the diagnostics report (ADR 0446 §3, 0447 §6). */
export interface VisibilityStats {
  readonly groups: number;
  readonly perLevel: readonly number[];
  readonly lodCulled: number;
  readonly fading: number;
  readonly occlusion: { readonly occluders: number; readonly triangles: number; readonly tested: number; readonly culled: number; readonly ms: number } | null;
}

/** One view's camera data the occlusion core needs besides the view-projection (ADR 0447 §4). */
export interface OcclusionCamera {
  readonly near: number;
  readonly far: number;
  /** Projection scale x and y (the matrix's [0][0] and [1][1]). */
  readonly sx: number;
  readonly sy: number;
  readonly eye: readonly [number, number, number];
}

/**
 * The occlusion core's boundary over the wasm module (ADR 0447 §2); `occlusion/core.ts` implements it over
 * `native/visibility`'s `vis-wasm` exports (layout documented in `vis-wasm/src/lib.rs`). Perspective views only:
 * orthographic views stay unculled.
 */
export interface OcclusionCore {
  /**
   * Rasterise this view's occluders and test its occludees. `occluders` holds world-space triangles (x, y, z per vertex,
   * three vertices per triangle, in the engine's winding: `scene/winding.ts`, ADR 0450); `errors` holds each triangle's final world-space error
   * (already doubled); `neighbors` 3 edge neighbours per triangle as indices into this frame's list (0xFFFFFFFF =
   * boundary; rebased when meshes are concatenated). `occludees` holds world AABBs (6 floats each). Writes 1 into
   * `hidden[i]` for each occludee the buffer proves hidden, and leaves other entries untouched.
   */
  occlude(view: VisibilityView, camera: OcclusionCamera, occluders: Float32Array, errors: Float32Array, neighbors: Uint32Array, occludees: Float32Array, hidden: Uint8Array): { triangles: number; culled: number };
  dispose(): void;
}

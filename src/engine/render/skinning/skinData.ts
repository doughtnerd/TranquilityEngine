/**
 * Internal (ADR 0370, 0371): what a skinned mesh carries beyond a model mesh's geometry, renderer-neutral:
 * its skin (joint indices and weights, 4 or 8 influences per vertex), its morph targets (position and
 * normal deltas) and its tangents. The skinning kernel (`skinKernel.ts`) packs these into its input tables.
 *
 * The importer (T14) fills them on `ModelMesh` as `SkinnedModelFields`; `skinnedSourceOf` reads them. A
 * mesh without a skin draws its morphed rest pose (weights all zero: the kernel keeps the vertex as is).
 */
import type { ModelMesh } from "../../scene/models";

/** Influences per vertex (ADR 0371: 4 by default, 8 when the model sidecar sets `influences: 8`). */
export type SkinInfluences = 4 | 8;

/** @internal A mesh's skin: per vertex, `influences` joint indices (into the skeleton's palette) and weights. */
export interface MeshSkin {
  readonly influences: SkinInfluences;
  /** `influences` joint indices per vertex (glTF `JOINTS_0`, then `JOINTS_1` for 8). */
  readonly joints: ArrayLike<number>;
  /** `influences` weights per vertex, normalised (extra influences dropped smallest first at import). */
  readonly weights: ArrayLike<number>;
}

/** @internal One morph target: per-vertex deltas added to the rest pose times the target's weight. */
export interface MorphTargetData {
  readonly name: string;
  /** x, y, z delta per vertex, or null. */
  readonly positions: Float32Array | null;
  /** x, y, z delta per vertex, or null. */
  readonly normals: Float32Array | null;
}

/** @internal The fields a skinned model mesh adds to `ModelMesh` (the importer's contract, T14). */
export interface SkinnedModelFields {
  readonly skin?: MeshSkin | null;
  readonly morphTargets?: readonly MorphTargetData[];
  /** x, y, z, w (handedness) per vertex (glTF `TANGENT`), or null. */
  readonly tangents?: Float32Array | null;
}

/** @internal What the skinning kernel deforms: a mesh's rest geometry, skin and morph targets. */
export interface SkinGeometry {
  /** x, y, z per vertex, in the skeleton's model space. */
  readonly positions: Float32Array;
  readonly normals: Float32Array | null;
  readonly tangents: Float32Array | null;
  readonly skin: MeshSkin | null;
  readonly morphTargets: readonly MorphTargetData[];
}

/** @internal A model mesh to draw skinned: its geometry for the kernel and the model mesh (indices, UVs, materials). */
export interface SkinnedMeshSource {
  readonly model: ModelMesh;
  readonly geometry: SkinGeometry;
}

/** @internal A model mesh as a skinned mesh source, from the skin fields its importer filled (none: the rest pose). */
export function skinnedSourceOf(model: ModelMesh): SkinnedMeshSource {
  const extra = model as ModelMesh & SkinnedModelFields;
  return {
    model,
    geometry: {
      positions: model.data.positions,
      normals: model.data.normals,
      tangents: extra.tangents ?? null,
      skin: extra.skin ?? null,
      morphTargets: extra.morphTargets ?? [],
    },
  };
}

/** @internal The number of vertices of a geometry. */
export function vertexCount(g: SkinGeometry): number {
  return Math.floor(g.positions.length / 3);
}

/** @internal The joints a geometry's skin uses (with a non-zero weight), ascending; empty without a skin. */
export function usedJoints(g: SkinGeometry): number[] {
  const skin = g.skin;
  if (!skin) return [];
  const used = new Set<number>();
  const n = vertexCount(g) * skin.influences;
  for (let i = 0; i < n; i++) if (skin.weights[i] !== 0) used.add(skin.joints[i]);
  return [...used].sort((a, b) => a - b);
}

/** @internal How many palette entries a geometry reads (its highest used joint + 1; 0 without a skin). */
export function jointsNeeded(g: SkinGeometry): number {
  const used = usedJoints(g);
  return used.length ? used[used.length - 1] + 1 : 0;
}

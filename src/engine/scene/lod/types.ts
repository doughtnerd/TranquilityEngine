/**
 * Generated LOD levels of a model mesh (ADR 0446): the renderer-neutral shapes the import pipeline produces, the
 * `.mycomesh` baker stores and the visibility stage and the Babylon mesh feature read. Not public API.
 *
 * Contract stub written by the coordinator before wave 1 (docs/plans/2026-11-lod-occlusion-plan.md, "Contracts");
 * only the coordinator edits it.
 */
import type { ModelMesh } from "../models";

/** Model-space axis-aligned bounds: minX, minY, minZ, maxX, maxY, maxZ. */
export type Bounds6 = readonly [number, number, number, number, number, number];

/** One level of a mesh. Level 0 is the (welded, reordered) original; its `error` is 0. */
export interface ModelLodLevel {
  /**
   * The level as a mesh: a derived `ModelMesh` with LOD0's surfaces, skin and morph targets and a `data` that shares
   * LOD0's vertex arrays with its own `indices` and `groups`. Its identity is stable for the model's lifetime, so it can
   * key batches (`render/babylon/meshBatches.ts`).
   */
  readonly mesh: ModelMesh;
  /** Measured two-way sampled Hausdorff error against LOD0, as a fraction of LOD0's bounding-box diagonal. */
  readonly error: number;
  /** Triangles in the level. */
  readonly triangles: number;
}

/** An occluder stand-in (ADR 0447 §3): positions are LOD0's; only indices are its own. */
export interface OccluderStandIn {
  /** The kept triangles after import-time hole trimming (ADR 0447 §3), into LOD0's positions. */
  readonly indices: Uint32Array;
  /** Measured two-way sampled Hausdorff error of the whole stand-in against LOD0, as a fraction of the diagonal. */
  readonly error: number;
  /**
   * Per kept triangle: its own measured error, as a fraction of the diagonal, before the runtime doubles it (ADR 0447
   * §3). Empty until trimming runs (`vis-trim`'s `trim_standin`).
   */
  readonly triangleErrors: Float32Array;
  /** Per kept triangle, 3 edge neighbours (indices into the kept triangles; 0xFFFFFFFF = boundary): silhouette edges. */
  readonly neighbors: Uint32Array;
}

/** A model mesh's generated levels, its occluder stand-in and its bounds. */
export interface ModelLods {
  /** At least one entry (level 0). */
  readonly levels: readonly ModelLodLevel[];
  readonly occluder: OccluderStandIn | null;
  readonly bounds: Bounds6;
  /** The sidecar's `pixelError`, which derives automatic transition heights (ADR 0446 §2). */
  readonly pixelError: number;
}

/** One level's generation settings in the sidecar (ADR 0446 §1). */
export interface LodLevelSettings {
  /** Triangle target relative to LOD0, 0 < ratio < 1. */
  readonly ratio: number;
  /** Error limit as a fraction of the diagonal. */
  readonly error: number;
}

/** The sidecar's `lod` (null in the sidecar: no levels). */
export interface LodSettings {
  readonly levels: readonly LodLevelSettings[];
  /** Weight normals, UVs and vertex colours in simplification. */
  readonly attributes: boolean;
  /** Let hard edges and seams collapse. */
  readonly permissive: boolean;
  /** Keep open borders exactly. */
  readonly lockBorders: boolean;
  /** Screen error in pixels at 1080p that derives automatic transition heights. */
  readonly pixelError: number;
}

/** The sidecar's `occluder` (ADR 0447 §3), beside `lod`. */
export type OccluderSetting = "auto" | "lod" | "none";

/** The default levels the import panel's "Generate LODs" switch fills in (ADR 0446 §1). */
export const DEFAULT_LOD_SETTINGS: LodSettings = {
  levels: [
    { ratio: 0.5, error: 0.01 },
    { ratio: 0.25, error: 0.02 },
    { ratio: 0.125, error: 0.04 },
  ],
  attributes: true,
  permissive: false,
  lockBorders: false,
  pixelError: 1,
};

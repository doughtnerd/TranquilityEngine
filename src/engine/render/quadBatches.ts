/**
 * Quad batches (ADR 0136): the renderer core's renderer-neutral way for a plugin's render feature to draw
 * sorted, unlit, alpha-blended textured quads in a node's space, as tilemap chunks do. The backend
 * implements it (`BabylonQuadBatches`); the feature (the Tilemaps plugin's tile renderer) decides what the
 * quads are and when they change. Types only: no backend code here (ADR 0010).
 */

/** @internal What a render feature borrows from the renderer to draw quad batches (ADR 0136). */
export interface QuadBatchHost {
  /** A new, empty, hidden batch. `name` is for debugging (`tilemap:Ground:0:0,0`). */
  createBatch(name: string): QuadBatch;
  /**
   * A texture's authored size in pixels (ADR 0119: a build may have shrunk the image), or null while it
   * loads; `onLoad` runs once it has (and not at all if it fails).
   */
  textureSize(path: string, onLoad: () => void): readonly [number, number] | null;
  /** Draw order for a sorting layer and order in layer (ADR 0014): the value sprites use. */
  sortOrder(sortingLayer: string, orderInLayer: number): number;
}

/** @internal One batch of textured quads: one draw call. */
export interface QuadBatch {
  /**
   * Replace the geometry: per quad, 4 corners × xyz `positions` (the node's local units), 4 × uv (`uvs`,
   * v up) and 6 `indices`. Shown once it has quads and is visible.
   */
  setQuads(texture: string, positions: Float32Array, uvs: Float32Array, indices: Uint32Array): void;
  /**
   * Replace the geometry with any triangles: xyz `positions` and uv (`uvs`, v up) per vertex, three `indices` per
   * triangle (a skinned sprite's mesh, ADR 0370, 0371). A call with the same texture, vertex count and `indices` array
   * only moves the vertices (and their UVs), so a deforming mesh can be updated every frame.
   */
  setTriangles(texture: string, positions: Float32Array, uvs: Float32Array, indices: Uint32Array): void;
  /** The column-major 4×4 node-to-world matrix at `offset` (the layout `World.worldMatrix` gives). */
  setMatrix(m: ArrayLike<number>, offset?: number): void;
  /** Draw order (from `QuadBatchHost.sortOrder`). */
  setOrder(order: number): void;
  /** `#rrggbb` (sRGB; anything else reads as white) and opacity 0..1. */
  setTint(color: string, opacity: number): void;
  /**
   * A colour per vertex (ADR 0395, 0396): RGBA, 0..1 sRGB and alpha, four floats per vertex of the current geometry,
   * multiplying the tint (per-decal fades and a 2D line's gradient in one batch). Null: none (white). Call it after the
   * geometry; a new geometry with another vertex count drops it.
   */
  setColors(rgba: Float32Array | null): void;
  /**
   * A mask (ADR 0395): the texture's alpha multiplies the fragment's, sampled at `uv`, a 2×3 affine map
   * `[a, b, c, d, e, f]` from the batch's local position (x, y) to the mask's UV (v up): `u = a·x + b·y + c`,
   * `v = d·x + e·y + f`. Outside 0..1 the mask reads as transparent. Null: no mask.
   */
  setMask(mask: QuadMask | null): void;
  /**
   * How the batch is lit by 2D lights (ADR 0399): lit (its sorting layer's light textures, with the sprite texture's
   * normal and mask maps when given) or null for unlit. A lit batch draws unlit while its layer has no 2D light.
   */
  setLighting(lighting: QuadLighting | null): void;
  /**
   * A 2D tangent per vertex (x, y: where the normal map's +X points, in the batch's local XY), turning the normal map
   * with a deforming mesh (a skinned sprite's bones, a 2D ribbon's direction). Null: the batch's matrix turns it.
   * Call it after the geometry; a new geometry with another vertex count drops it.
   */
  setTangents(tangents: Float32Array | null): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/** A lit batch's lighting (`QuadBatch.setLighting`, ADR 0399). */
export interface QuadLighting {
  /** The sorting layer whose light textures it reads (the one its order came from). */
  readonly sortingLayer: string;
  /** The sprite texture's normal map (ADR 0408), or null. */
  readonly normalMap?: string | null;
  /** Its normal map's green channel points down (DirectX). */
  readonly normalMapGreenDown?: boolean;
  /** The sprite texture's mask map (ADR 0408), or null. */
  readonly maskMap?: string | null;
}

/** A batch's mask (`QuadBatch.setMask`): a texture whose alpha clips the quads, and the map from local position to its UV. */
export interface QuadMask {
  readonly texture: string;
  /** `[a, b, c, d, e, f]`: `u = a·x + b·y + c`, `v = d·x + e·y + f` (v up). */
  readonly uv: ArrayLike<number>;
}

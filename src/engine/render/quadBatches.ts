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
  /** The column-major 4×4 node-to-world matrix at `offset` (the layout `World.worldMatrix` gives). */
  setMatrix(m: ArrayLike<number>, offset?: number): void;
  /** Draw order (from `QuadBatchHost.sortOrder`). */
  setOrder(order: number): void;
  /** `#rrggbb` (sRGB; anything else reads as white) and opacity 0..1. */
  setTint(color: string, opacity: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

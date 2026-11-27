/**
 * Quad batches (ADR 0136, 0418): the renderer core's renderer-neutral way for a plugin's render feature to draw
 * sorted, alpha-blended textured quads and triangles in a node's space, layered with sprites: tilemap chunks, 2D lines,
 * 2D decals, skinned sprites and light volumes. The backend implements it (`BabylonQuadBatches`); the feature decides
 * what the geometry is and when it changes. A batch names its 2D material asset; the backend works out its lighting,
 * normal and mask maps and tangents (its 2D materials, ADR 0418). Types only: no backend code here (ADR 0010).
 */

/** @internal What a render feature borrows from the renderer to draw quad batches (ADR 0136). */
export interface QuadBatchHost {
  /** A new, empty, hidden, unlit batch. `name` is for debugging (`tilemap:Ground:0:0,0`). */
  createBatch(name: string): QuadBatch;
  /**
   * A texture's authored size in pixels (ADR 0119: a build may have shrunk the image), or null while it
   * loads; `onLoad` runs once it has (and not at all if it fails).
   */
  textureSize(path: string, onLoad: () => void): readonly [number, number] | null;
  /**
   * Run `listener` just before each camera draws (ADR 0444: a tile layer's parallax follows each camera), with that
   * camera's world position. A `QuadBatch.setMatrix` called from the listener applies to that camera's draw only: once
   * the frame is drawn, the batch is back at the matrix last set outside a listener (what picking and the editor's
   * tools read). Returns a function that removes the listener.
   */
  onCameraRender(listener: (cameraWorldPosition: readonly [number, number, number]) => void): () => void;
}

/** @internal One batch of textured quads: one draw call. */
export interface QuadBatch {
  /**
   * Replace the geometry: per quad, 4 corners × xyz `positions` (the node's local units), 4 × uv (`uvs`,
   * v up) and 6 `indices`, and optionally a colour per vertex (`colors`: RGBA, 0..1 sRGB and alpha, multiplying the tint).
   * Shown once it has quads and is visible. A call with the same texture, vertex count and `indices` array as the last
   * one only updates the vertices (positions, UVs and colours) in place, as `setTriangles` does: an animated tile layer
   * rewrites its quads' UVs in the same arrays and calls again (ADR 0437), with no rebuild.
   */
  setQuads(texture: string, positions: Float32Array, uvs: Float32Array, indices: Uint32Array, colors?: Float32Array | null): void;
  /**
   * Replace the geometry with any triangles: xyz `positions` and uv (`uvs`, v up) per vertex, three `indices` per
   * triangle (a skinned sprite's mesh, ADR 0370, 0371), and optionally a colour per vertex as `setQuads` takes. A call
   * with the same texture, vertex count and `indices` array only moves the vertices (and their UVs and colours), so a
   * deforming mesh can be updated every frame; a normal map then follows it (ADR 0399).
   */
  setTriangles(texture: string, positions: Float32Array, uvs: Float32Array, indices: Uint32Array, colors?: Float32Array | null): void;
  /**
   * The column-major 4×4 node-to-world matrix at `offset` (the layout `World.worldMatrix` gives). From a
   * `QuadBatchHost.onCameraRender` listener, for the camera about to draw only.
   */
  setMatrix(m: ArrayLike<number>, offset?: number): void;
  /**
   * Its place among layered 2D content (ADR 0014): a sorting layer and an order in it, as sprites have. Lit batches read
   * that layer's 2D light. `within` (ADR 0437, 0440; [0, 1), default 0) orders draws of the same order among themselves,
   * larger drawing later: an isometric layer's chunks in painter's order, heights in a y-sorted layer.
   */
  setOrder(sortingLayer: string, orderInLayer: number, within?: number): void;
  /**
   * Its 2D material asset (ADR 0399, 0415): "" the default, Sprite Lit (lit by its sorting layer's 2D lights, with its
   * texture's normal and mask maps); a Sprite Unlit material, or a sprite graph's; or null (the default for a new batch)
   * for plain and unlit, as a light's volume draws.
   */
  setMaterial(material: string | null): void;
  /** `#rrggbb` (sRGB; anything else reads as white) and opacity 0..1. */
  setTint(color: string, opacity: number): void;
  /**
   * A mask (ADR 0395): the texture's alpha multiplies the fragment's, sampled at `uv`, a 2×3 affine map
   * `[a, b, c, d, e, f]` from the batch's local position (x, y) to the mask's UV (v up): `u = a·x + b·y + c`,
   * `v = d·x + e·y + f`. Outside 0..1 the mask reads as transparent. Null: no mask.
   */
  setMask(mask: QuadMask | null): void;
  /**
   * How its fragments meet what's drawn below (ADR 0415): `"alpha"` (the default) blends over it, `"additive"` adds
   * colour × alpha to it (a 2D light's volume glow).
   */
  setBlend(blend: QuadBlend): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/** A quad batch's blending (`QuadBatch.setBlend`). */
export type QuadBlend = "alpha" | "additive";

/** A batch's mask (`QuadBatch.setMask`): a texture whose alpha clips the quads, and the map from local position to its UV. */
export interface QuadMask {
  readonly texture: string;
  /** `[a, b, c, d, e, f]`: `u = a·x + b·y + c`, `v = d·x + e·y + f` (v up). */
  readonly uv: ArrayLike<number>;
}

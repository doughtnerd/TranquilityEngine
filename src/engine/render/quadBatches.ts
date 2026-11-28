/**
 * Quad batches (ADR 0136, 0418): the renderer core's renderer-neutral way for a plugin's render feature to draw
 * sorted, alpha-blended textured quads and triangles in a node's space, layered with sprites: tilemap chunks, 2D lines,
 * 2D decals, skinned sprites and light volumes. The backend implements it (`BabylonQuadBatches`); the feature decides
 * what the geometry is and when it changes. A batch names its 2D material asset; the backend works out its lighting,
 * normal and mask maps and tangents (its 2D materials, ADR 0418). A batch also owns its place in the draw order
 * (ADR 0445): the feature gives a sorting layer, an order in it and a sort point, the batch decides the rest and reports
 * its `place`, which picking reads. Types only: no backend code here (ADR 0010).
 */
import type { DrawSort } from "./sortOrder";

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
  /**
   * Whether batches on `sortingLayer` sort by their sort point's height (ADR 0440: a y-sorted layer): for a feature
   * that splits its geometry by sort point there (a tile layer's rows) or batches draws only at one height.
   */
  ySorted(sortingLayer: string): boolean;
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
   * Its place among layered 2D content (ADR 0014, 0445): a sorting layer and an order in it, as sprites have. Lit batches
   * read that layer's 2D light. `sort` orders batches of the same order among themselves (ADR 0437, 0440): `y`, the world
   * height of its sort point, counts when the layer is y-sorted (higher draws earlier); `within` ([0, 1), larger later) is
   * an explicit sub-order used otherwise (an isometric layer's chunks in painter's order). The batch works out its place
   * from these (warning once about a sorting layer the project doesn't list) and reports it as `place`.
   */
  setOrder(sortingLayer: string, orderInLayer: number, sort?: DrawSort): void;
  /**
   * Its place among layered 2D content as of the last `setOrder` (0 before one): what it draws at and what picking ranks
   * it by (ADR 0276, 0440), comparable with a sprite's. Higher draws later, on top.
   */
  readonly place: number;
  /**
   * Its 2D material asset (ADR 0399, 0415): "" the default, Sprite Lit (lit by its sorting layer's 2D lights, with its
   * texture's normal and mask maps); a Sprite Unlit material, or a sprite graph's; or null (the default for a new batch)
   * for plain and unlit, as a light's volume draws.
   */
  setMaterial(material: string | null): void;
  /**
   * A hex colour (`#rgb[a]`, `#rrggbb[aa]`, sRGB, ADR 0461: its alpha multiplies the opacity; any other string reads as
   * white), or sRGB channels 0..1 taken exactly (a sprite's colour, ADR 0450), and opacity 0..1.
   */
  setTint(color: QuadTint, opacity: number): void;
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

/** A quad batch's tint colour (`QuadBatch.setTint`): `#rrggbb`, or sRGB channels 0..1. */
export type QuadTint = string | { readonly r: number; readonly g: number; readonly b: number };

/** A quad batch's blending (`QuadBatch.setBlend`). */
export type QuadBlend = "alpha" | "additive";

/** A batch's mask (`QuadBatch.setMask`): a texture whose alpha clips the quads, and the map from local position to its UV. */
export interface QuadMask {
  readonly texture: string;
  /** `[a, b, c, d, e, f]`: `u = a·x + b·y + c`, `v = d·x + e·y + f` (v up). */
  readonly uv: ArrayLike<number>;
}

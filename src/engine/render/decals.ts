/**
 * Decal volumes (ADR 0381): the renderer core's renderer-neutral way for the Decals plugin to draw 3D decals. A
 * decal is a box (a unit cube, -0.5..0.5, placed by its matrix) that projects a material along its local +Z onto
 * the opaque surfaces the scene depth shows inside it. The backend implements it (`BabylonDecals`); the plugin decides
 * which decals exist, where, and how faded they are. Types only: no backend code here (ADR 0010).
 */

/** How a decal blends with what is under it: over it (lit), darkening it (unlit), or adding light (unlit). */
export type DecalBlend = "alpha" | "multiply" | "additive";

/** What every decal of a batch looks like. */
export interface DecalLook {
  /** A material asset or shader graph; "" for the built-in decal material. */
  readonly material: string;
  /** The built-in material's texture ("" for none); ignored with a material. */
  readonly texture: string;
  readonly blend: DecalBlend;
}

/** @internal What a render feature borrows from the renderer to draw decal volumes (ADR 0381). */
export interface DecalHost {
  /** A new, empty, hidden batch of decals drawn with `look`: one draw. `name` is for debugging. */
  createBatch(name: string, look: DecalLook): DecalBatch;
}

/** @internal Decals sharing a look and an order: instances of one box. */
export interface DecalBatch {
  /**
   * Replace the instances, `count` of them. Per instance: `matrices` 16 floats (column-major box-to-world, the unit
   * cube's -0.5..0.5 to the decal's box), `colors` 4 (0..1 sRGB colour, then alpha: opacity and fades), `uvs` 4 (UV
   * scale xy, offset zw) and `angles` 2 (the cosines of the angle fade's start and end: full strength while the
   * surface faces the projector closer than the start, gone past the end).
   */
  setInstances(count: number, matrices: Float32Array, colors: Float32Array, uvs: Float32Array, angles: Float32Array): void;
  /** Draw order among decals: higher on top. */
  setOrder(order: number): void;
  setVisible(visible: boolean): void;
  /** Whether its material and texture have loaded (absent ones count as loaded). */
  loaded(): boolean;
  dispose(): void;
}

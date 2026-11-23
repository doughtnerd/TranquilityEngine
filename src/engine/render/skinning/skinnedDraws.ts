/**
 * Internal (ADR 0370 "Rendering"): what a renderer offers to draw skinned meshes, renderer-neutral, so
 * the Animation plugin's sync (which knows `SkinnedMeshRenderer`s, skeletons and their matrices) drives
 * any backend. The Babylon backend is `render/babylon/skinnedMeshes.ts`. `M` is the renderer's mesh
 * type (shadow casters, picking and outlines name it).
 *
 * A draw is one model mesh skinned by `mycoSkin` (`skinRuns.ts`) and drawn as an ordinary mesh from the
 * kernel's output, so every pass (main, shadows, depth, previews) reuses it. Its geometry is in the
 * skeleton's model space; `setWorldMatrix` places it (the skeleton node's world matrix). The sync calls
 * `dispatch` only after the draw's palette or morph weights changed, before the frame renders.
 */
import type { SlotRequest } from "../materialResolution";
import type { Box6 } from "./skinBounds";
import type { SkinnedMeshSource } from "./skinData";
import type { SkinExecutor, SkinPalette } from "./skinRuns";

/** One skinned model mesh on the renderer. */
export interface SkinnedDraw<M> {
  /** The renderer's mesh (shadow casters, picking, outlines). */
  readonly mesh: M;
  readonly source: SkinnedMeshSource;
  /** Whether its GPU device or context was lost: the owner disposes it and makes a new one. */
  readonly lost: boolean;
  setPalette(palette: SkinPalette): void;
  setMorphWeights(weights: ArrayLike<number>): void;
  /** Skin every vertex now (the palette or morph weights changed). */
  dispatch(): void;
  /** Place it: a column-major 4×4 world matrix at `offset`. */
  setWorldMatrix(matrix: ArrayLike<number>, offset: number): void;
  /** Culling bounds in model space (the skeleton's). */
  setBounds(box: Box6): void;
  setEnabled(enabled: boolean): void;
  setShadows(cast: boolean, receive: boolean): void;
  /** Its materials: the renderer-wide material asset and per-slot ones (ADR 0089), else the model's own. */
  setMaterials(request: SlotRequest): void;
  dispose(): void;
}

/** A renderer's skinned-mesh backend. */
export interface SkinnedDraws<M> {
  /** Which executor skins (WebGPU compute, WebGL2 transform feedback, or the CPU). */
  readonly executor: SkinExecutor;
  /** A new bone palette (one per skeleton, shared by its draws). */
  palette(label: string): SkinPalette;
  /** A new draw of `source`. */
  create(source: SkinnedMeshSource, name: string): SkinnedDraw<M>;
  /** After the frame's dispatches (WebGL2: restore the renderer's GL state). */
  endDispatches(): void;
  dispose(): void;
}

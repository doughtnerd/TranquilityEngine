/**
 * @internal The editor's preview renderers as the editor sees them (ADR 0061, 0075 stage 7, 0081),
 * implemented by the Babylon.js classes in `render/babylon/previews/`. Type-only: nothing here loads a
 * renderer.
 */
import type { ParticleProgram } from "../scene/particleCompile";
import type { BuiltinMesh } from "../scene/models";
import type { GameObject } from "../scene/GameObject";
import type { SceneFile } from "../scene/SceneLoader";
import type { Bounds } from "./thumbnailMath";

/**
 * What an asset's thumbnail draws (ADR 0156): a made-up node set, loaded into a headless World and drawn
 * by the enabled plugins' render features as a World draws it, and how to frame it. Asset kinds supply
 * one per file (`AssetThumbnail.stage` in the editor); a prefab's or scene's is the file itself.
 */
export interface ThumbnailStage {
  /** The nodes, as a scene file has them. */
  readonly scene: SceneFile;
  /** The file the nodes come from (a prefab or scene): names the root and resolves its instances. */
  readonly source?: string;
  /** After the nodes load, before the first sync: what scene data can't say (a script Material, such as the chrome sphere's). */
  readonly dress?: (root: GameObject) => void;
  /** How the camera looks at what draws. */
  readonly view?: ThumbnailView;
  /** A hovered tile and the Inspector's preview keep drawing (particle effects, skies, graphs that use Time). */
  readonly animates?: boolean;
  /** Additive light: recover transparency by drawing over black and over white (particle effects). */
  readonly matte?: boolean;
}

/** How a thumbnail frames its stage (ADR 0156). */
export interface ThumbnailView {
  /**
   * Where the camera looks from: `above` (three-quarters, front-right-above), `front`, `level` (slightly
   * above the front, for a material's sphere); `auto` (default) is `above`, or `front` when only sprites draw.
   */
  readonly from?: "auto" | "above" | "front" | "level";
  /** Units of padding around what draws. */
  readonly pad?: number;
  /** The box framed when nothing drawn has bounds (a sky, an effect with no live particles); default a unit cube. */
  readonly fallback?: Bounds;
  /** Look through the stage's main camera when it has one, over its background (scenes, ADR 0117). */
  readonly mainCamera?: boolean;
}

/** The particle effect preview's backdrop. */
export type PreviewBackground = "dark" | "light" | "grid";

/** The meshes a shader graph preview can show. */
export type PreviewMesh = Extract<BuiltinMesh, "sphere" | "cube" | "capsule" | "plane" | "quad">;

/**
 * A live, orbitable preview drawn into a canvas (the Inspector's): it redraws when the view changes,
 * and continuously while the asset animates. One at a time; while one is open, tiles show stills.
 */
export interface ThumbnailPreview {
  /** Resolves true once the asset is drawn, false if it can't be (or the preview stopped first). */
  readonly ready: Promise<boolean>;
  /** Turn the view around the asset by `dyaw` (about the vertical) and `dpitch` radians. */
  orbit(dyaw: number, dpitch: number): void;
  /** Move closer (below 1) or further away (above 1). */
  zoom(factor: number): void;
  /** Back to the starting view. */
  reset(): void;
  /** Redraw at the canvas's current size (after it was resized). */
  redraw(): void;
  stop(): void;
}


/** The asset thumbnail renderer (ADR 0061). */
export interface ThumbnailRendererApi {
  readonly size: number;
  /** True once the browser has taken the GPU context away (too many contexts, a GPU reset). */
  lost: boolean;
  /** Run `f` once if the context is lost (the renderer is then useless: make another). */
  onContextLost(f: () => void): void;
  /** A still image of a stage (WebP where the browser encodes it, else PNG), or null if it can't be shown. */
  render(stage: ThumbnailStage): Promise<Blob | null>;
  /** Draw a (live) stage into `target` at about 30 fps, until the returned function is called. */
  animate(stage: ThumbnailStage, target: HTMLCanvasElement, onFrame?: () => void): () => void;
  /** An orbitable preview of a (live) stage in `target`; it keeps drawing when the stage animates. */
  preview(stage: ThumbnailStage, target: HTMLCanvasElement): ThumbnailPreview;
  /** Forget every loaded texture (another project opened). */
  clearCaches(): void;
  dispose(): void;
}

/** The particle effect preview in the particle graph editor (ADR 0060). */
export interface ParticleEffectPreviewApi {
  readonly canvas: HTMLCanvasElement;
  /** Playback speed multiplier. */
  speed: number;
  /** Force one-shot effects to repeat after a short gap. */
  looping: boolean;
  /** Called when the playing state changes (play, pause). */
  onChange: (() => void) | null;
  readonly playing: boolean;
  background: PreviewBackground;
  /** Particles alive and seconds played. */
  readonly stats: { particles: number; time: number };
  /** Show a compiled effect graph (null clears). Rebuilds the emitters and plays from the start. */
  setProgram(program: ParticleProgram | null): void;
  /** Send a custom event, starting and stopping the systems wired to it. */
  sendEvent(name: string): void;
  play(): void;
  pause(): void;
  restart(): void;
  resize(w?: number, h?: number): void;
  dispose(): void;
}

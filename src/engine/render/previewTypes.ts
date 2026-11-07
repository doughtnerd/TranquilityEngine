/**
 * @internal The editor's preview renderers as the editor sees them (ADR 0061, 0075 stage 7, 0081),
 * implemented by the Babylon.js classes in `render/babylon/previews/`. Type-only: nothing here loads a
 * renderer.
 */
import type { ParticleProgram } from "../scene/particleCompile";
import type { BuiltinMesh } from "../scene/models";

/** What gets a rendered thumbnail. */
export type ThumbnailKind = "model" | "material" | "shadergraph" | "environment" | "sky" | "particles" | "prefab";

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
  /** A still image of the asset (WebP where the browser encodes it, else PNG), or null if it can't be shown. */
  render(kind: ThumbnailKind, path: string): Promise<Blob | null>;
  /** Whether the asset animates on hover: particle effects, and shader graphs (or their materials) that use Time. */
  canAnimate(kind: ThumbnailKind, path: string): boolean;
  /** Draw the asset live into `target` at about 30 fps, until the returned function is called. */
  animate(kind: ThumbnailKind, path: string, target: HTMLCanvasElement, onFrame?: () => void): () => void;
  /** An orbitable preview of the asset in `target`. */
  preview(kind: ThumbnailKind, path: string, target: HTMLCanvasElement): ThumbnailPreview;
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

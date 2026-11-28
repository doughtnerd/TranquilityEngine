/**
 * Render policy (ADR 0129): the few renderer-neutral settings that make a World's renderer behave as
 * the editor's scene view, or keep what the editor's tools need, instead of as a game. A renderer reads
 * only these, never "is this the editor". The game values are the default; the editor sets the rest
 * through its viewport handle (`editorViewport.ts`), which a game never creates.
 */
import type { GameObject } from "../scene/GameObject";
import type { Camera } from "./components";
import type { ParticlePreviewSettings } from "./RenderSurface";

/** @internal What a World's renderer does beyond game rules (ADR 0129). Engine types only. */
export interface RenderPolicy {
  /**
   * The editor's scene view: canvas views see editor-only content (the grid), view 0 previews the scene
   * camera's post-processing and shows the editor backdrop (ADR 0051, 0111), and UI clicks select
   * rather than press buttons.
   */
  sceneView: boolean;
  /** "perObject" keeps a mesh per sprite, for the editor's picking and outlines; "batched" lets plain sprites batch (ADR 0108). */
  drawPolicy: "batched" | "perObject";
  /**
   * An extra view: `camera` drawn into the canvas at `inset` (picture-in-picture, ADR 0022), with its
   * screen UI laid out at that size. The editor's viewport handle measures the inset (ADR 0240).
   */
  cameraPreview: { camera: Camera; inset: PreviewInset } | null;
  /**
   * Particles in preview mode (ADR 0057): script commands are ignored, and only systems on selected
   * nodes play (all of them with Simulate All), at the preview speed. Null: game rules.
   */
  particlePreview: ParticlePreview | null;
  /** 2D draws are lit by 2D lights (ADR 0399); false draws them unlit (the scene view's 2D Lighting toggle). */
  lighting2D: boolean;
  /**
   * The editor's "preview a level" (ADR 0459 §7): the scene view draws `node`'s `LODGroup` at `level` (-1: culled),
   * whatever the camera's distance. Game views never see it. Null: every group chooses by distance.
   */
  lodPreview: { node: GameObject; level: number } | null;
  /** The scene view's visibility tools (ADR 0459 §7, 0460 §6). Game views never see them. */
  sceneVisibility: SceneVisibilityTools;
}

/**
 * @internal The scene view's visibility tools (ADR 0459 §7, 0460 §6), from the editor's View menu. All off by default,
 * so editing shows everything.
 */
export interface SceneVisibilityTools {
  /** Run occlusion for the scene view (it keeps one of the tier's `occlusionViews` while on). */
  readonly occlusion: boolean;
  /** Keep the scene view's last visibility set (levels and hidden bits) while its camera moves. */
  readonly freeze: boolean;
  /** Draw what occlusion hid in the scene view anyway, in `colors.occluded`, so a false occlusion shows. */
  readonly validator: boolean;
  /** A debug view: none, each renderer tinted by its LOD level, or the occlusion buffer, culled boxes and readout. */
  readonly debug: "none" | "lodLevels" | "occlusion";
  /** The tints, 0xRRGGBB: one per LOD level (the last repeats past it) and the validator's. The editor's theme sets them. */
  readonly colors: { readonly levels: readonly number[]; readonly occluded: number };
}

/** @internal The scene view's visibility tools when the editor hasn't set any: everything off. */
export const SCENE_VISIBILITY_OFF: SceneVisibilityTools = Object.freeze({ occlusion: false, freeze: false, validator: false, debug: "none", colors: Object.freeze({ levels: Object.freeze([0x4caf50, 0x2196f3, 0x9c27b0, 0xe91e63, 0xff9800, 0xffeb3b, 0x00bcd4, 0x795548]), occluded: 0xff0000 }) });

/**
 * @internal The particle preview as render policy (ADR 0057, 0154): which nodes' effects play, the
 * playback settings, and a restart count. The one place the preview's state lives on its way to the
 * renderer: the surface keeps the policy until the renderer loads and hands it over once.
 */
export interface ParticlePreview extends ParticlePreviewSettings {
  selected(node: GameObject): boolean;
  /** Raised by one to restart every previewed effect (the overlay's Restart); the renderer acts on a change. */
  restarts: number;
}

/**
 * @internal The camera preview inset (ADR 0240): fractions of the canvas, `x` and `width` from its left,
 * `top` and `height` from its top, clamped to it; and the inset's own aspect ratio (width / height).
 */
export interface PreviewInset {
  readonly x: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly aspect: number;
}

/** @internal A rectangle in CSS pixels, as `getBoundingClientRect` gives it. */
export interface ClientRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * @internal Where the inset element `frame` lies on `canvas` (both client rects), as a `PreviewInset`, or
 * null when there's nothing to draw: the frame is under 2 px a side, the canvas isn't laid out, or the
 * frame lies (almost) wholly off the canvas.
 */
export function previewInset(canvas: ClientRect, frame: ClientRect): PreviewInset | null {
  const cw = canvas.width, ch = canvas.height;
  if (frame.width < 2 || frame.height < 2 || cw <= 0 || ch <= 0) return null;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const x = clamp((frame.left - canvas.left) / cw), top = clamp((frame.top - canvas.top) / ch);
  const width = Math.min(clamp(frame.width / cw), 1 - x), height = Math.min(clamp(frame.height / ch), 1 - top);
  if (width <= 0.001 || height <= 0.001) return null;
  return { x, top, width, height, aspect: frame.width / frame.height };
}

/** @internal Whether two insets are the same (null for none). */
export function sameInset(a: PreviewInset | null, b: PreviewInset | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.top === b.top && a.width === b.width && a.height === b.height && a.aspect === b.aspect;
}

/** @internal A game's policy: everything off. */
export const GAME_POLICY: Readonly<RenderPolicy> = Object.freeze({ sceneView: false, drawPolicy: "batched", cameraPreview: null, particlePreview: null, lighting2D: true, lodPreview: null, sceneVisibility: SCENE_VISIBILITY_OFF });

/**
 * @internal What a render surface gives its editor viewport handle (ADR 0129): live from the start,
 * before the renderer or its editor tools have loaded (the surface keeps the values until then).
 */
export interface RenderPolicyPort {
  /** Change some settings; the others keep their value. */
  setPolicy(change: Partial<RenderPolicy>): void;
}

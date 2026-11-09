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
   * screen UI laid out at that size. The editor's viewport handle measures the inset (ADR 0163).
   */
  cameraPreview: { camera: Camera; inset: PreviewInset } | null;
  /**
   * Particles in preview mode (ADR 0057): script commands are ignored, and only systems on selected
   * nodes play (all of them with Simulate All), at the preview speed. Null: game rules.
   */
  particlePreview: ParticlePreview | null;
}

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
 * @internal The camera preview inset (ADR 0163): fractions of the canvas, `x` and `width` from its left,
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
export const GAME_POLICY: Readonly<RenderPolicy> = Object.freeze({ sceneView: false, drawPolicy: "batched", cameraPreview: null, particlePreview: null });

/**
 * @internal What a render surface gives its editor viewport handle (ADR 0129): live from the start,
 * before the renderer or its editor tools have loaded (the surface keeps the values until then).
 */
export interface RenderPolicyPort {
  /** Change some settings; the others keep their value. */
  setPolicy(change: Partial<RenderPolicy>): void;
}

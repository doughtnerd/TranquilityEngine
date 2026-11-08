/**
 * The frame plan (ADR 0129): which cameras draw this frame, in what order, where, with which clear
 * colour and post-processing, and which view gets the UI and the editor overlay. Pure and
 * renderer-neutral (ADR 0010): a renderer builds the input from the World, calls `planFrame`, and only
 * maps each planned view to its own camera and pass. Unit-tested in `tests/framePlan.test.ts`.
 */
import type { QualityTier } from "../core/graphics";
import type { Camera } from "./components";
import { resolvePostEffects, type PostSettings, type ResolvedPost } from "./postEffects";

/** @internal An sRGB colour, components 0–1. */
export type Rgb = readonly [number, number, number];

/** @internal A rectangle as fractions of the canvas, from the bottom-left (ADR 0056). */
export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** @internal One enabled camera the renderer can draw, in the World's component order. */
export interface FrameCamera {
  /** Identity only: handed back on its views. */
  camera: Camera;
  depth: number;
  /** Its viewport rectangle, already clamped to the canvas. */
  rect: ViewRect;
  /** Its render texture asset path (ADR 0109), or "" to draw on the canvas. */
  target: string;
  /** Its own background colour, or null. */
  background: Rgb | null;
  /** Its enabled PostProcessing component's values, or null. */
  post: PostSettings | null;
  /** The camera belongs to a node in the editor's edit mode (ADR 0026): it never draws on the canvas. */
  editMode: boolean;
}

/** @internal Everything a frame's views depend on. */
export interface FrameInput {
  cameras: readonly FrameCamera[];
  /** The clear colour: the project background, or the editor's in an editor World. */
  clearColor: Rgb;
  /** Fog's `affectsSkybox` (ADR 0071): the clear colour blends this far towards `color`. Null: none. */
  skyFog: { color: Rgb; amount: number } | null;
  tier: QualityTier;
  /** The editor's scene view (`RenderPolicy.sceneView`). */
  sceneView: boolean;
  /** The renderer has an editor overlay to draw (its editor tools have loaded). */
  overlay: boolean;
  /**
   * The camera-preview inset (ADR 0022), or null: its camera, its rectangle on the canvas (measured by
   * the renderer), the inset's width/height ratio, and whether its own screen UI is ready to draw.
   */
  preview: { camera: Camera; rect: ViewRect; aspect: number; ui: boolean } | null;
}

/** @internal Where a view draws. */
export type ViewOutput =
  | { kind: "canvas"; rect: ViewRect }
  /** A render texture asset (the whole texture, at its size). */
  | { kind: "texture"; texture: string }
  /** The camera-preview inset; an orthographic camera takes `aspect` instead of the canvas's. */
  | { kind: "preview"; rect: ViewRect; aspect: number };

/** @internal One view of the frame, in draw order. */
export interface PlannedView {
  camera: Camera;
  output: ViewOutput;
  /** The colour to clear to, or null to draw over the views before it. */
  clear: Rgb | null;
  /** Editor (ADR 0111): a colour shown behind the scene as it is, not tone mapped with it; null for none. */
  backdrop: Rgb | null;
  post: ResolvedPost;
  /** The game's screen UI ("screen"), the preview inset's own UI ("preview"), or none after this view. */
  ui: "screen" | "preview" | null;
  /** Draw the editor overlay after this view (at most one view). */
  overlay: boolean;
  /** The view sees editor-only content (the grid and axes). */
  editorContent: boolean;
}

/** @internal The frame's views, in draw order: canvas cameras by depth, then render-texture cameras by depth, then the preview inset. */
export function planFrame(input: FrameInput): PlannedView[] {
  void input;
  void resolvePostEffects;
  throw new Error("planFrame: not implemented yet (ADR 0129 wave 1)");
}

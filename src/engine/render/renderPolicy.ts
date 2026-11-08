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
  /** An extra view: `camera` drawn into the canvas under `frame` (picture-in-picture, ADR 0022), with its screen UI laid out at that size. */
  cameraPreview: { camera: Camera; frame: HTMLElement } | null;
  /**
   * Particles in preview mode (ADR 0057): script commands are ignored, and only systems on selected
   * nodes play (all of them with Simulate All), at the preview speed. Null: game rules.
   */
  particlePreview: { selected(node: GameObject): boolean } | null;
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
  /** The particle preview's playback (kept until changed). */
  setParticlePreview(preview: Partial<ParticlePreviewSettings>): void;
  /** Restart every previewed effect. */
  restartParticlePreview(): void;
}

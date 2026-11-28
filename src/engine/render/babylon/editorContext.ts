/**
 * What the Babylon backend's editor viewport (ADR 0022, 0075 stage 8, 0128; `editorViewport.ts`, which
 * also does the picking and canvas queries) gets from the renderer, as do its drawing modules: the grid,
 * outlines and overlay (`editorGuides.ts`), the camera, light and particle system icons (`editorIcons.ts`),
 * and the transform gizmo (`editorGizmo.ts`).
 *
 * Two scenes: the main scene (post-processed by the frame graph; the grid lives here so meshes hide
 * it) and the overlay scene, a utility layer drawn after the frame graph, on top of everything and
 * never post-processed (outlines, overlays, icons, frustums, the transform gizmo).
 */
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ProjectSettings } from "../../core/settings";
import type { World } from "../../core/World";
import type { Camera, ReflectionProbe } from "../components";
import type { ViewportUI } from "../editorViewport";
import type { DrawnCommon, DrawnQuads, DrawnShape } from "./feature";

/**
 * @internal What a render feature drew for a node (ADR 0276), as the editor tools read it: the renderer
 * has resolved quad batches to its meshes, one drawing per place the batches report (ADR 0445), so the shape is a quad,
 * meshes or a canvas rectangle (or none), and every drawing has its pick order.
 */
export interface EditorDrawn extends DrawnCommon {
  readonly shape: Exclude<DrawnShape, DrawnQuads> | null;
  /** Pick order, higher on top: layered 2D content its draw place, else a `PICK_ORDER`. Equal orders go nearest first. */
  readonly order: number;
}

/** @internal The renderer state the editor helpers read. */
export interface BabylonEditorContext {
  readonly scene: Scene;
  /** The utility layer drawn after the frame graph (overlays, gizmos). */
  readonly overlay: UtilityLayerRenderer;
  /**
   * The canvas's CSS size in pixels (zero when not laid out), from the surface's cached size: the
   * viewport reads it every frame, and reading `clientHeight` then would force a style and layout
   * pass whenever anything on the page changed (about 8 ms a frame in the editor during play).
   */
  canvasSize(): { readonly width: number; readonly height: number };
  readonly settings: ProjectSettings;
  /** An editor World's surface (fills its panel, has a grid); false for a game's. */
  readonly editor: boolean;
  /** The World this surface draws, once claimed. */
  world(): World | null;
  /** The enabled Camera components drawing the view, in depth order (the first is "the view camera"). */
  viewCameras(): readonly Camera[];
  /** A Camera component's Babylon camera, once synced. */
  babylonCamera(c: Camera): TargetCamera | null;
  /** What every loaded render feature drew now (ADR 0276): sprites, meshes, tile layers, water, world canvases… */
  drawn(): Iterable<EditorDrawn>;
  /** What the editor viewport (ADR 0128) asks of the renderer itself, beside the helpers' own drawing. */
  readonly renderer: BabylonEditorRendererHooks;
}

/**
 * @internal Renderer-level editor features: the background, UI and probe bakes. The camera inset, selection and particle preview are render policy (ADR 0129),
 * set through the surface's `RenderPolicyPort`, not here.
 */
export interface BabylonEditorRendererHooks {
  setClearColor(color: number): void;
  ui(): ViewportUI | null;
  bakeReflectionProbe(probe: ReflectionProbe): Promise<ArrayBuffer>;
}

/**
 * @internal Layer mask bit of editor-only meshes in the main scene (the grid and axes). Only an editor
 * World's view cameras see it; game cameras (the camera preview inset, reflection probes) keep
 * Babylon's default mask (0x0FFFFFFF), which leaves it out.
 */
export const EDITOR_LAYER_MASK = 0x10000000;

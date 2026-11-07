/**
 * What the Babylon backend's editor helpers (ADR 0022, 0075 stage 8) get from the renderer: picking
 * and canvas queries (`editorQueries.ts`), the grid, outlines, overlays and camera/light gizmos
 * (`editorOverlays.ts`), and the transform gizmo (`editorGizmo.ts`).
 *
 * Two scenes: the main scene (post-processed by the frame graph; the grid lives here so meshes hide
 * it) and the overlay scene, a utility layer drawn after the frame graph, on top of everything and
 * never post-processed (outlines, overlays, icons, frustums, the transform gizmo).
 */
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ProjectSettings } from "../../core/settings";
import type { World } from "../../core/World";
import type { Camera, MeshRenderer, SpriteRenderer, Text } from "../components";

/** A sprite as the renderer draws it. */
export interface EditorSprite {
  readonly component: SpriteRenderer;
  /** Its quad (a unit quad scaled to size, pivot at the node's origin), or disabled while loading. */
  readonly mesh: Mesh;
  /** Size in node units (before the node's scale), once known. */
  readonly size: [number, number] | null;
  /** Draw order: sprites draw without depth testing, higher on top (`sortingLayer` index × 10000 + `orderInLayer`). */
  readonly order: number;
}

/** A MeshRenderer as the renderer draws it. */
export interface EditorMesh {
  readonly component: MeshRenderer;
  /** One Babylon mesh per model mesh (world matrices frozen to the node's). */
  readonly meshes: readonly AbstractMesh[];
}

/** @internal The renderer state the editor helpers read. */
export interface BabylonEditorContext {
  readonly scene: Scene;
  /** The utility layer drawn after the frame graph (overlays, gizmos). */
  readonly overlay: UtilityLayerRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly settings: ProjectSettings;
  /** An editor World's surface (fills its panel, has a grid); false for a game's. */
  readonly editor: boolean;
  /** The World this surface draws, once claimed. */
  world(): World | null;
  /** The enabled Camera components drawing the view, in depth order (the first is "the view camera"). */
  viewCameras(): readonly Camera[];
  /** A Camera component's Babylon camera, once synced. */
  babylonCamera(c: Camera): TargetCamera | null;
  sprites(): Iterable<EditorSprite>;
  meshes(): Iterable<EditorMesh>;
  /** Screen-space Text components (ADR 0069's interim Text) and their canvas rectangles, if drawn. */
  texts(): Iterable<{ component: Text; rect: { left: number; top: number; right: number; bottom: number } }>;
}

/**
 * @internal Layer mask bit of editor-only meshes in the main scene (the grid and axes). Only an editor
 * World's view cameras see it; game cameras (the camera preview inset, reflection probes) keep
 * Babylon's default mask (0x0FFFFFFF), which leaves it out.
 */
export const EDITOR_LAYER_MASK = 0x10000000;

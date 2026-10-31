// Shared editor UI state (ADR 0025). Signals so Preact panels re-render when it changes.
import { signal } from "@preact/signals";
import type { CommandStack, SceneDocument, WorldSync } from "./document";
import type { OrbitCamera, ViewMode } from "./OrbitCamera";

/** The scene view camera, set once the Editor World is running. */
export const sceneCamera = signal<OrbitCamera | null>(null);

/** 3D orbit view or flat 2D view. Kept in sync with `sceneCamera.mode`. */
export const viewMode = signal<ViewMode>("3d");

export function setViewMode(mode: ViewMode): void {
  viewMode.value = mode;
  if (sceneCamera.value) sceneCamera.value.mode = mode;
}

/** The open scene: its document, undo stack and the Editor World view of it (ADR 0026). */
export interface OpenScene {
  readonly path: string;
  readonly doc: SceneDocument;
  readonly stack: CommandStack;
  readonly sync: WorldSync;
}

export const openScene = signal<OpenScene | null>(null);

/** Bumped whenever the open document changes, so panels that read it re-render. */
export const docVersion = signal(0);

/** Selected document node id. */
export const selection = signal<string | null>(null);

/** Viewport tool: plain selection, or a move/rotate/scale gizmo on the selection. */
export type Tool = "select" | "move" | "rotate" | "scale";
export const tool = signal<Tool>("move");

/** Gizmo snapping (held Ctrl/Cmd). */
export const snapping = signal(false);

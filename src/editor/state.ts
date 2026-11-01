// Shared editor UI state (ADR 0025). Signals so Preact panels re-render when it changes.
import { signal } from "@preact/signals";
import type { GameObject } from "../engine";
import type { CommandStack, NodePath, SceneDocument, WorldSync } from "./document";
import type { OrbitCamera, ViewMode } from "./OrbitCamera";
import type { EditorProject } from "./projects";

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

/** Selected document node: an id, or a path key inside a prefab instance (see `selectedPath`). */
export const selection = signal<string | null>(null);

/** Viewport tool: plain selection, or a move/rotate/scale gizmo on the selection. */
export type Tool = "select" | "move" | "rotate" | "scale";
export const tool = signal<Tool>("move");

/** Gizmo snapping (held Ctrl/Cmd). */
export const snapping = signal(false);

/** The open project (the bundled demo, or a folder on disk). */
export const currentProject = signal<EditorProject | null>(null);

/** A message for the status bar, e.g. a failed open or save. */
export const status = signal<{ kind: "info" | "error"; text: string; action?: { label: string; run: () => void; done?: string } } | null>(null);

/** Play mode: "edit", "starting" while the Runtime World boots, or "playing". */
export const playState = signal<"edit" | "starting" | "playing">("edit");

/**
 * The selection as a document path: `[id]` for a scene node, `[instanceId, innerId…]` for a node
 * inside a prefab instance. `selection` holds its key (ids joined with "/").
 */
export function selectedPath(): NodePath | null {
  const key = selection.value;
  return key ? key.split("/") : null;
}

/** The World node showing the selection, if the selection still exists. */
export function selectedWorldNode(): GameObject | null {
  const scene = openScene.value, path = selectedPath();
  return scene && path && scene.doc.has(path[0]) ? scene.sync.nodeFor(path) : null;
}

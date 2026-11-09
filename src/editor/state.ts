// Shared editor UI state (ADR 0025). Signals so Preact panels re-render when it changes.
import { batch, signal, type ReadonlySignal } from "@preact/signals";
import type { GameObject } from "../engine";
import type { CommandStack, NodePath, SceneDocument, WorldSync } from "./document";
import type { OrbitCamera, ViewMode } from "./OrbitCamera";
import type { EditorProject } from "./projects";
import type { HierarchyEntry } from "./selectionModel";
import type { PlaySession } from "./playMode";

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

/**
 * Every open scene tab, in tab order (ADR 0026). `openScene` is the active one, which every panel,
 * Save and Play act on; the others keep their document, undo history and dirty state, with no
 * nodes in the Editor World until they're active again.
 */
export const openScenes = signal<readonly OpenScene[]>([]);

/** Bumped whenever the open document changes, so panels that read it re-render. */
export const docVersion = signal(0);

/**
 * Selected document nodes as path keys (ids, or `instance/inner…` inside prefab instances, see
 * `selectedPath`), in the order they were selected. The last one is the active node: the one the
 * single-selection tools (Create Prefab, Edit Collider, focus) act on. Written only through
 * inspectorTarget.ts (`select`), which keeps it apart from the other selections (ADR 0162).
 */
export const selectedKeys = signal<readonly string[]>([]);

const activeOf = (keys: readonly string[]) => (keys.length ? keys[keys.length - 1] : null);

/** The active selected node's key, or null. Reading it tracks the selection like a signal; select with inspectorTarget.ts `select`. */
export const selection = {
  get value(): string | null {
    return activeOf(selectedKeys.value);
  },
  peek(): string | null {
    return activeOf(selectedKeys.peek());
  },
};

/**
 * The selected element of a UI document (ADR 0077), as a `uiDocuments.ts` key (`uiRefKey`), or
 * null. Elements aren't document nodes, so they're selected apart; written only through
 * inspectorTarget.ts (`selectUIElement`), which clears the other selections (ADR 0162).
 */
export const selectedUIElement = signal<string | null>(null);

/**
 * The Alt+click list (ADR 0022): nodes near the click, with their children, shown at a page
 * point; `before` is the selection to restore on Escape. Null when closed.
 */
export const refineList = signal<{ x: number; y: number; entries: readonly HierarchyEntry[]; before: readonly string[] } | null>(null);

/** True if `key` is selected (tracks the selection). */
export const isSelected = (key: string) => selectedKeys.value.includes(key);

/** Viewport tool: plain selection, or a move/rotate/scale gizmo on the selection. */
export type Tool = "select" | "move" | "rotate" | "scale";
export const tool = signal<Tool>("move");

/** Gizmo snapping (held Ctrl/Cmd). */
export const snapping = signal(false);

/** Bumped when the project's scripts are (re)read, so panels showing them re-render (ADR 0030). */
export const scriptsVersion = signal(0);

/** Project scripts that didn't compile or load (ADR 0030), by path. Empty when all loaded. */
export const scriptProblems = signal<readonly { path: string; message: string }[]>([]);

/** The open project (the bundled demo, or a folder on disk). */
export const currentProject = signal<EditorProject | null>(null);

/** A message for the status bar, e.g. a failed open or save. Every one also goes into the message log (messages.ts). */
export interface Status {
  kind: "info" | "error";
  text: string;
  /** More to read in the message log: a stack trace, or the full list behind a summary. */
  detail?: string;
  action?: { label: string; run: () => void; done?: string };
}
export const status = signal<Status | null>(null);

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

/** The World node showing the active selected node, if it still exists. */
export function selectedWorldNode(): GameObject | null {
  const scene = openScene.value, path = selectedPath();
  return scene && path && scene.doc.has(path[0]) ? scene.sync.nodeFor(path) : null;
}

/** Every selected node that still exists, as a path and its World node, active node last. */
export function selectedNodes(): { key: string; path: NodePath; node: GameObject }[] {
  const scene = openScene.value;
  if (!scene) return [];
  const out: { key: string; path: NodePath; node: GameObject }[] = [];
  for (const key of selectedKeys.value) {
    const path = key.split("/");
    const node = scene.doc.has(path[0]) ? scene.sync.nodeFor(path) : null;
    if (node) out.push({ key, path, node });
  }
  return out;
}

/** The running play session, for the Network panel (ADR 0033 §9) and the play Worlds' overlays; null while editing. */
export const playing = signal<PlaySession | null>(null);

/**
 * The active viewport tool's id (ADR 0138), or null for the transform tools. At most one tool is
 * active (editing a collider is the Physics plugin's tool, ADR 0142), and the transform gizmo steps aside while it's set.
 */
const activeTool = signal<string | null>(null);
export const activeViewportTool: ReadonlySignal<string | null> = activeTool;

/** Make a viewport tool the active one, or give the scene view back to the transform tools (null). */
export function activateViewportTool(id: string | null): void {
  activeTool.value = id;
}

/** Pick a tool. Picking any tool, even the current one, ends the active viewport tool (collider editing, painting) so its gizmo comes back. */
export function pickTool(t: Tool): void {
  batch(() => {
    activeTool.value = null;
    tool.value = t;
  });
}

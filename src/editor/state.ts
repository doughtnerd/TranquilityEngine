// Shared editor UI state (ADR 0025). Signals so Preact panels re-render when it changes.
import { signal } from "@preact/signals";
import type { GameObject } from "../engine";
import type { CommandStack, NodePath, SceneDocument, WorldSync } from "./document";
import type { OrbitCamera, ViewMode } from "./OrbitCamera";
import type { EditorProject } from "./projects";
import type { HierarchyEntry } from "./selectionModel";

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

/**
 * Selected document nodes as path keys (ids, or `instance/inner…` inside prefab instances, see
 * `selectedPath`), in the order they were selected. The last one is the active node: the one the
 * single-selection tools (Create Prefab, Edit Collider, focus) act on.
 */
export const selectedKeys = signal<readonly string[]>([]);

const activeOf = (keys: readonly string[]) => (keys.length ? keys[keys.length - 1] : null);

/**
 * The active selected node's key. Reading it tracks the selection like a signal; setting it
 * selects just that node (null clears the selection).
 */
export const selection = {
  get value(): string | null {
    return activeOf(selectedKeys.value);
  },
  set value(key: string | null) {
    select(key === null ? [] : [key]);
  },
  peek(): string | null {
    return activeOf(selectedKeys.peek());
  },
};

/** Select `keys` (duplicates dropped). `active`, if among them, becomes the active node. */
export function select(keys: Iterable<string>, active?: string | null): void {
  const next = [...new Set(keys)];
  if (active != null && next.includes(active)) next.push(next.splice(next.indexOf(active), 1)[0]);
  const current = selectedKeys.peek();
  if (next.length === current.length && next.every((k, i) => k === current[i])) return;
  selectedKeys.value = next;
}

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

/** Project scripts that didn't compile or load (ADR 0030), by path. Empty when all loaded. */
export const scriptProblems = signal<readonly { path: string; message: string }[]>([]);

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

/** The collider whose handles are showing ("Edit Collider", like Unity), or null. */
export interface EditingCollider {
  /** Path key of the node (see `selection`). */
  key: string;
  type: "engine.BoxCollider2D" | "engine.CircleCollider2D";
  /** Which collider of that type on the node. */
  index: number;
}
export const editingCollider = signal<EditingCollider | null>(null);

/** Pick a tool. Picking any tool, even the current one, ends collider editing so its gizmo comes back. */
export function pickTool(t: Tool): void {
  editingCollider.value = null;
  tool.value = t;
}

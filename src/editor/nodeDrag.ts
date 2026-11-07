// Dragging nodes in the hierarchy to reorder, reparent or unparent them (ADR 0026). Same drop
// rules and indicators as dropping assets there (`hierarchyDrop`): the middle of a row makes it
// the parent, near its top or bottom edge places the node beside it, empty space or the scene
// header moves it to the top level. Dragging a selected row drags the whole selection (its
// topmost nodes, in hierarchy order) as one move.
import { errorStatus } from "./messages";
import { signal } from "@preact/signals";
import { hierarchyTargetAt, overPrefabInsides, type AssetDropTarget } from "./assetDrag";
import type { SceneDocument } from "./document";
import { isInsidePrefab, moveNodes, whyNotMovable } from "./hierarchyEdit";
import { subtreeRoots } from "./nodeClipboard";
import { openScene, playState, select, selectedKeys, status } from "./state";

const DRAG_THRESHOLD = 5;

type HierarchyTarget = Extract<AssetDropTarget, { kind: "hierarchy" }>;

export interface NodeDrag {
  /** Path key of the row the drag started on. */
  key: string;
  /** Path keys of every node being dragged (the selection's topmost nodes, or just `key`). */
  keys: readonly string[];
  x: number;
  y: number;
  target: HierarchyTarget | null;
  problem: string | null;
}

export const nodeDrag = signal<NodeDrag | null>(null);

/** Index among the parent's current children where the node would land, or null if it wouldn't move. */
function wouldMove(doc: SceneDocument, id: string, t: HierarchyTarget): boolean {
  if (t.row === id) return false; // onto itself, or just above or below itself
  if (doc.parentOf(id) !== t.parent) return true;
  const siblings = doc.children(t.parent);
  const current = siblings.indexOf(id);
  let at = t.index ?? siblings.length;
  if (current < at) at -= 1;
  return at !== current;
}

/** Why dropping `key` (or all of `keys`) at `t` isn't allowed, or null if it is. Exported for tests. */
export function nodeDropProblem(doc: SceneDocument, key: string, t: HierarchyTarget | null, keys: readonly string[] = [key]): string | null {
  if (keys.some(isInsidePrefab)) return "nodes inside a prefab are moved in the prefab";
  if (!t) return "drop it in the hierarchy";
  for (const k of keys) {
    const reason = whyNotMovable(doc, k, t.parent);
    if (reason) return reason;
  }
  if (keys.length > 1) return keys.some((k) => wouldMove(doc, k, t)) || keys.includes(t.row ?? "") ? null : "that's where they already are";
  return wouldMove(doc, key, t) ? null : "that's where it already is";
}

/** What dragging the row `key` drags: the selection's topmost nodes when `key` is selected among others, else just it. */
export function draggedKeys(doc: SceneDocument, key: string, selected: readonly string[]): string[] {
  if (selected.length < 2 || !selected.includes(key)) return [key];
  return subtreeRoots(doc, selected);
}

/**
 * Press on a hierarchy row: past the threshold this drags the node, or the whole selection when
 * the row is selected. Releasing over a valid spot moves them (one undoable step; each stays where
 * it is in the world); anywhere else, or Escape, does nothing. A plain click still selects the row.
 */
export function startNodeDrag(e: PointerEvent, key: string): void {
  if (e.button !== 0) return;
  const startX = e.clientX, startY = e.clientY;
  let active = false;
  let keys: readonly string[] = [key];

  const update = (m: PointerEvent) => {
    if (!active && Math.hypot(m.clientX - startX, m.clientY - startY) < DRAG_THRESHOLD) return;
    const scene = openScene.value;
    if (!active && scene) keys = draggedKeys(scene.doc, key, selectedKeys.peek());
    active = true;
    const target = hierarchyTargetAt(m.clientX, m.clientY);
    const hierarchy = target?.kind === "hierarchy" ? target : null;
    const problem =
      !scene ? "no scene open"
      : playState.value !== "edit" ? "stop playing to edit the scene"
      : !hierarchy && !keys.some(isInsidePrefab) && overPrefabInsides(m.clientX, m.clientY) ? "nodes inside a prefab can't take children here"
      : nodeDropProblem(scene.doc, key, hierarchy, keys);
    nodeDrag.value = { key, keys, x: m.clientX, y: m.clientY, target: problem ? null : hierarchy, problem };
  };
  const finish = (apply: boolean) => {
    window.removeEventListener("pointermove", update);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key_, true);
    const state = nodeDrag.value;
    nodeDrag.value = null;
    if (!apply || !active || !state?.target) return;
    const scene = openScene.value!;
    try {
      moveNodes(scene, state.keys, state.target.parent, state.target.mode === "root" ? undefined : state.target.index);
      select(state.keys, key);
      status.value = null;
    } catch (err) {
      status.value = errorStatus(`Couldn't move it`, err);
    }
  };
  const up = (m: PointerEvent) => {
    if (active) update(m);
    finish(true);
  };
  const cancel = () => finish(false);
  const key_ = (k: KeyboardEvent) => {
    if (k.key !== "Escape" || !active) return;
    k.preventDefault();
    k.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", update);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key_, true);
}

/** Text for the ghost label while dragging a node. */
export function nodeDropDescription(drag: NodeDrag, doc: SceneDocument | null): string {
  const label = (id: string | null) => (id && doc?.has(id) ? doc.node(id).name ?? id : "the scene");
  const own = isInsidePrefab(drag.key) ? drag.key.split("/").pop()! : label(drag.key);
  const name = drag.keys.length > 1 ? `${drag.keys.includes(drag.key) ? own : label(drag.keys[0])} +${drag.keys.length - 1}` : own;
  if (drag.problem || !drag.target) return `${name}: ${drag.problem ?? "can't drop here"}`;
  const t = drag.target;
  switch (t.mode) {
    case "into": return `Move ${name} into ${label(t.row)}`;
    case "before": return `Move ${name} above ${label(t.row)}`;
    case "after": return `Move ${name} below ${label(t.row)}`;
    default: return `Move ${name} to the top of the scene`;
  }
}

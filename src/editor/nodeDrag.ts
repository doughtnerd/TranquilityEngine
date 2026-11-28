// Dragging nodes in the hierarchy to reorder, reparent or unparent them (ADR 0026). Same drop
// geometry and indicators as dropping assets there (the Hierarchy drop, ADR 0258): the middle of a
// row makes it the parent, near its top or bottom edge places the node beside it, empty space or the
// scene header moves it to the top level. A drop inside a prefab instance says why scene nodes can't
// go there. Dragging a selected row drags the whole selection (its topmost nodes, in hierarchy order)
// as one move.
import { errorStatus } from "./messages";
import { signal } from "@preact/signals";
import type { SceneDocument } from "./document";
import { dropRowName, hierarchyDropAt, type HierarchyDrop } from "./hierarchyDrop";
import { moveNodes, whyNotMovable } from "./hierarchyEdit";
import { isInnerKey } from "./nodeKey";
import { subtreeRoots } from "./nodeClipboard";
import { openScene, selectedKeys, status } from "./state";
import { whyNotEdit } from "./editGate";
import { select } from "./inspectorTarget";
import { startPointerDrag } from "./pointerDrag";

export interface NodeDrag {
  /** Path key of the row the drag started on. */
  key: string;
  /** Path keys of every node being dragged (the selection's topmost nodes, or just `key`). */
  keys: readonly string[];
  x: number;
  y: number;
  target: HierarchyDrop | null;
  problem: string | null;
}

export const nodeDrag = signal<NodeDrag | null>(null);

/** Where a move drops nodes: a document parent and index. */
type MoveSpot = { readonly parent: string | null; readonly index?: number };

/** Whether the node would move: false when it would land where it is. `row`: the row the drop marks. */
function wouldMove(doc: SceneDocument, id: string, row: string | null, t: MoveSpot): boolean {
  if (row === id) return false; // onto itself, or just above or below itself
  if (doc.parentOf(id) !== t.parent) return true;
  const siblings = doc.children(t.parent);
  const current = siblings.indexOf(id);
  let at = t.index ?? siblings.length;
  if (current < at) at -= 1;
  return at !== current;
}

/** Why dropping `key` (or all of `keys`) at `drop` isn't allowed, or null if it is. */
function nodeDropProblem(doc: SceneDocument, key: string, drop: HierarchyDrop | null, keys: readonly string[] = [key]): string | null {
  if (keys.some(isInnerKey)) return "nodes inside a prefab are moved in the prefab";
  if (!drop) return "drop it in the hierarchy";
  if ("reason" in drop.move) return drop.move.reason;
  const t = drop.move;
  for (const k of keys) {
    const reason = whyNotMovable(doc, k, t.parent);
    if (reason) return reason;
  }
  if (keys.length > 1) return keys.some((k) => wouldMove(doc, k, drop.row, t)) || keys.includes(drop.row ?? "") ? null : "that's where they already are";
  return wouldMove(doc, key, drop.row, t) ? null : "that's where it already is";
}

/** What dragging the row `key` drags: the selection's topmost nodes when `key` is selected among others, else just it. */
function draggedKeys(doc: SceneDocument, key: string, selected: readonly string[]): string[] {
  if (selected.length < 2 || !selected.includes(key)) return [key];
  return subtreeRoots(doc, selected);
}

/**
 * Press on a hierarchy row: past the threshold this drags the node, or the whole selection when
 * the row is selected. Releasing over a valid spot moves them (one undoable step; each stays where
 * it is in the world); anywhere else, or Escape, does nothing. A plain click still selects the row.
 * The gesture is the editor's one row drag (`pointerDrag.ts`, ADR 0278).
 */
export function startNodeDrag(e: PointerEvent, key: string): void {
  let keys: readonly string[] | null = null;
  startPointerDrag(e, {
    move: (m, doc) => {
      const scene = openScene.value;
      if (keys === null) keys = scene ? draggedKeys(scene.doc, key, selectedKeys.peek()) : [key];
      const drop = scene ? hierarchyDropAt(scene.doc, m.clientX, m.clientY, doc) : null;
      const problem =
        whyNotEdit({ kind: "scene", scene }) ?? // no scene, play mode (ADR 0247)
        (!scene ? "open a scene first" : nodeDropProblem(scene.doc, key, drop, keys));
      nodeDrag.value = { key, keys, x: m.clientX, y: m.clientY, target: problem ? null : drop, problem };
    },
    end: (how) => {
      const state = nodeDrag.value;
      nodeDrag.value = null;
      if (how !== "drop" || !state?.target || "reason" in state.target.move) return;
      const scene = openScene.value!;
      try {
        moveNodes(scene, state.keys, state.target.move.parent, state.target.move.index);
        select(state.keys, key);
        status.value = null;
      } catch (err) {
        status.value = errorStatus(`Couldn't move it`, err);
      }
    },
  });
}

/** Text for the ghost label while dragging a node. */
export function nodeDropDescription(drag: NodeDrag, doc: SceneDocument | null): string {
  const label = (id: string | null) => dropRowName(doc, id);
  const name = drag.keys.length > 1 ? `${drag.keys.length} nodes` : label(drag.key);
  if (drag.problem || !drag.target) return `${name}: ${drag.problem ?? "can't drop here"}`;
  const t = drag.target;
  switch (t.mode) {
    case "into": return `Move ${name} into ${label(t.row)}`;
    case "before": return `Move ${name} above ${label(t.row)}`;
    case "after": return `Move ${name} below ${label(t.row)}`;
    default: return `Move ${name} to the top of the scene`;
  }
}

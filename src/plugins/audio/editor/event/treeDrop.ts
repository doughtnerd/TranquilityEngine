// Where a drop on the Event editor's tree lands (ADR 0158 §7): a tree row being dragged to a new place, or clips
// dragged in from the asset browser. Pure: the panel finds the row under the pointer and the fraction of its height,
// this says what releasing there does, and `applyClipDrop` makes the edit.
import type { EventNode } from "../../../../engine/audio/eventFormat";
import {
  addChild,
  canAddChild,
  canMove,
  getNode,
  isListNode,
  newNode,
  parentPath,
  setNode,
  setSustainSlot,
  type DropTarget,
  type NodePath,
  type SustainSlot,
  type TreeEdit,
} from "./EventTree";

/** A drop: into a list or an empty sustain slot (`DropTarget`), or (clips only) onto a clip row, replacing its clip. */
export type TreeDrop = DropTarget | { replace: NodePath };

/** What's under the pointer: a node's row, or an empty sustain slot's placeholder row. */
export type DropRow = { path: NodePath } | { sustain: NodePath; slot: SustainSlot };

/**
 * The drop for a pointer over `row` at `fraction` of its height (0 = top), dragging a tree node (`"node"`) or clips
 * (`"clips"`). An empty slot row takes the drop into the slot. On a node row: the top quarter goes before the node and
 * the bottom quarter after it (when its parent is a list), the middle into it (a list container: at the end). A clip
 * row's middle replaces its clip for clips, and splits at half height into before and after for nodes. A list
 * container with no list parent (the root, a slot's node) takes edge drops into itself, first or last. `null` when
 * nothing fits.
 */
export function dropAt(root: EventNode, row: DropRow, fraction: number, what: "node" | "clips"): TreeDrop | null {
  if ("slot" in row) return getNode(root, row.sustain)?.type === "sustain" ? { parent: row.sustain, slot: row.slot } : null;
  const node = getNode(root, row.path);
  if (!node) return null;
  const parent = parentPath(row.path);
  const parentNode = parent ? getNode(root, parent) : undefined;
  const step = row.path[row.path.length - 1];
  const inList = parent !== null && parentNode !== undefined && isListNode(parentNode) && typeof step === "number";
  const beside = (after: boolean): TreeDrop | null => (inList ? { parent: parent!, index: (step as number) + (after ? 1 : 0) } : null);
  const middle = fraction >= 0.25 && fraction <= 0.75;
  if (middle && isListNode(node)) return { parent: row.path, index: node.children.length };
  if (middle && node.type === "clip") return what === "clips" ? { replace: row.path } : beside(fraction > 0.5);
  if (middle) return null; // a sustain's own row: drop on one of its empty slot rows instead
  // The root (or a slot's node) has no list to sit beside in: its edges drop into it, first or last.
  return beside(fraction > 0.75) ?? (isListNode(node) ? { parent: row.path, index: fraction < 0.25 ? 0 : node.children.length } : null);
}

/** Whether a tree node at `from` may be dropped at `drop` (never onto a `replace`). */
export function canDropNode(root: EventNode, from: NodePath, drop: TreeDrop | null): drop is DropTarget {
  return drop !== null && !("replace" in drop) && canMove(root, from, drop);
}

/**
 * Add clip nodes for `clips` (asset paths) at `drop`: into a list, each a new `clip` node in order from the index; into
 * an empty slot, one clip (only one path fits); `replace` sets the clip row's path to the first one. Returns the edit
 * (the path of the first node made or changed), or a reason it can't.
 */
export function applyClipDrop(root: EventNode, drop: TreeDrop, clips: readonly string[]): TreeEdit | string {
  if (clips.length === 0) return "only audio clips can be added to an event";
  if ("replace" in drop) {
    const node = getNode(root, drop.replace);
    if (node?.type !== "clip") return "that row isn't a clip";
    if (clips.length > 1) return "drop one clip on a clip row to replace it";
    return { root: setNode(root, drop.replace, { ...node, clip: clips[0] }), path: drop.replace };
  }
  if ("slot" in drop) {
    const sustain = getNode(root, drop.parent);
    if (sustain?.type !== "sustain" || sustain[drop.slot] !== undefined) return "that slot is taken";
    if (clips.length > 1) return "a sustain slot holds one node; drop one clip, or drop several on a container";
    return setSustainSlot(root, drop.parent, drop.slot, newNode("clip", clips[0]));
  }
  let next = root;
  let first: NodePath | null = null;
  for (const [i, clip] of clips.entries()) {
    const node = newNode("clip", clip);
    if (!canAddChild(next, drop.parent, node)) return "the event can't hold more nodes there";
    const edit = addChild(next, drop.parent, node, drop.index + i);
    next = edit.root;
    first ??= edit.path;
  }
  return { root: next, path: first! };
}

/** A drop's description for the hint line ("Add 2 clips to Random"…). */
export function describeDrop(root: EventNode, drop: TreeDrop | null, count: number, what: "node" | "clips"): string {
  const thing = what === "node" ? "Move here" : count === 1 ? "Add the clip" : `Add ${count} clips`;
  if (!drop) return what === "node" ? "Can't move it here" : "Drop on a container, a slot or a clip";
  if ("replace" in drop) return "Replace this clip";
  if ("slot" in drop) return `${thing} as the ${drop.slot}`;
  const parent = getNode(root, drop.parent);
  return `${thing} in ${parent ? parent.type : "the tree"} at ${drop.index + 1}`;
}

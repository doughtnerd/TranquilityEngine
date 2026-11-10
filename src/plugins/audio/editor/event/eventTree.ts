// The Event editor's pure tree operations (ADR 0158 §1, §7): addressing a node of an audio event's container tree by
// path, and every structural edit the tree pane makes (add, remove, reorder, move, duplicate, wrap), plus renaming a
// local parameter everywhere it is used. Every function returns new values and never mutates its inputs: untouched
// subtrees are shared, changed ones are copied along the path. The panel turns each result into one undoable edit.
import {
  MAX_EVENT_DEPTH,
  MAX_EVENT_NODES,
  type AudioEventAsset,
  type EventNode,
  type NodeType,
} from "../../../../engine/audio/eventFormat";

/** A `sustain` node's three slots, in play order. `loop` is required; `start` and `end` are optional. */
export const SUSTAIN_SLOTS = ["start", "loop", "end"] as const;
export type SustainSlot = (typeof SUSTAIN_SLOTS)[number];

/**
 * One step down the tree: an index into a list container's `children` (`random`, `sequence`, `switch`, `blend`,
 * `layer`), or a slot name of a `sustain` node.
 */
export type PathStep = number | SustainSlot;

/**
 * A node's address from the event's root: `[]` is the root, `[1]` the root's second child, `[1, "loop"]` the loop slot
 * of a sustain node that is the root's second child, `[1, "loop", 0]` that loop node's first child.
 */
export type NodePath = readonly PathStep[];

/** Containers whose children are a list (everything but `clip` and `sustain`). */
export type ListNodeType = "random" | "sequence" | "switch" | "blend" | "layer";
export const LIST_NODE_TYPES: readonly ListNodeType[] = ["random", "sequence", "switch", "blend", "layer"];

/** Where a moved node lands: at `index` in a list container's children, or in an empty slot of a sustain node. */
export type DropTarget = { parent: NodePath; index: number } | { parent: NodePath; slot: SustainSlot };

/** A tree edit's result: the new root and the path of the node the edit made or moved (to select it). */
export interface TreeEdit {
  root: EventNode;
  path: NodePath;
}

// --- paths ----------------------------------------------------------------------------------------------------------

/**
 * A stable string for a path, for selection state and Preact keys: steps joined by `/` (`""` for the root,
 * `"1/loop/0"`). `parsePathKey` reverses it.
 */
export function pathKey(path: NodePath): string {
  void path;
  throw new Error("not implemented"); // L6.3a
}

/** The path `pathKey` made. Numeric steps come back as numbers, slot names as slots; anything else is `null`. */
export function parsePathKey(key: string): NodePath | null {
  void key;
  throw new Error("not implemented"); // L6.3a
}

/** True when both paths have the same steps. */
export function samePath(a: NodePath, b: NodePath): boolean {
  void a; void b;
  throw new Error("not implemented"); // L6.3a
}

/** True when `ancestor` is a proper prefix of `path` (a path is not its own ancestor). */
export function isAncestor(ancestor: NodePath, path: NodePath): boolean {
  void ancestor; void path;
  throw new Error("not implemented"); // L6.3a
}

/** The parent's path, or `null` for the root. */
export function parentPath(path: NodePath): NodePath | null {
  void path;
  throw new Error("not implemented"); // L6.3a
}

// --- reading --------------------------------------------------------------------------------------------------------

/** True for the list containers (`LIST_NODE_TYPES`). */
export function isListNode(node: EventNode): node is Extract<EventNode, { type: ListNodeType }> {
  void node;
  throw new Error("not implemented"); // L6.3a
}

/**
 * The steps from `node` to each child it has, in tree order: `0..n-1` for a list container, the filled slots of a
 * sustain node in `SUSTAIN_SLOTS` order (`"loop"` always), nothing for a clip.
 */
export function childSteps(node: EventNode): PathStep[] {
  void node;
  throw new Error("not implemented"); // L6.3a
}

/** The node at `path`, or `undefined` when the path doesn't lead to one (a stale selection, say). */
export function getNode(root: EventNode, path: NodePath): EventNode | undefined {
  void root; void path;
  throw new Error("not implemented"); // L6.3a
}

/** Every node's path, depth first, in the order `eventNodes` walks (sustain slots start, loop, end). The root's is `[]`. */
export function nodePaths(root: EventNode): NodePath[] {
  void root;
  throw new Error("not implemented"); // L6.3a
}

/** The number of nodes in the subtree (the node itself included). */
export function countNodes(node: EventNode): number {
  void node;
  throw new Error("not implemented"); // L6.3a
}

/** The subtree's height in levels: 1 for a node without children, 1 + its deepest child's otherwise. */
export function subtreeHeight(node: EventNode): number {
  void node;
  throw new Error("not implemented"); // L6.3a
}

/**
 * A short label for the tree row: a clip's file name without folder or extension (`"sfx/step_01.ogg"` → `"step_01"`),
 * `"(no clip)"` for an empty clip; a container's type capitalised (`"Random"`, `"Sequence"`…).
 */
export function nodeLabel(node: EventNode): string {
  void node;
  throw new Error("not implemented"); // L6.3a
}

// --- making nodes ---------------------------------------------------------------------------------------------------

/**
 * A fresh node of `type` with every field at the default `parseAudioEvent` gives it (no array shared with any other
 * node): `NodeBase` volume 1, pitch 1, volumeRandom [0, 0], pitchRandom [0, 0], delay 0, automation [], weight 1,
 * fade 0, and no `value` or `range`. A clip gets `clip` (default `""`), loop false, startOffset 0, sustain false, no
 * loopRegion. `random`: children [], avoidRepeat 0, mode "step", gap 0. `sequence`: children [], mode "step",
 * loop false, gap 0, reset 0. `switch`: parameter "", children [], onChange "keep", crossfade 0.1, no default.
 * `blend`: parameter "", children []. `layer`: children []. `sustain`: release "loopEnd", a fresh empty clip in
 * `loop`, no start or end. `clip` is used only for type "clip".
 */
export function newNode(type: NodeType, clip?: string): EventNode {
  void type; void clip;
  throw new Error("not implemented"); // L6.3a
}

/** A deep copy of the subtree: equal by value, sharing no object or array with `node`. */
export function cloneNode(node: EventNode): EventNode {
  void node;
  throw new Error("not implemented"); // L6.3a
}

// --- edits ----------------------------------------------------------------------------------------------------------

/**
 * A new root with the node at `path` replaced by `node` (ancestors copied, everything else shared). `path` `[]`
 * replaces the root. Throws `RangeError` when `path` doesn't lead to a node.
 */
export function setNode(root: EventNode, path: NodePath, node: EventNode): EventNode {
  void root; void path; void node;
  throw new Error("not implemented"); // L6.3a
}

/**
 * Whether `node` may be added under the list container at `parent`: the parent exists and is a list container, no node
 * would sit at depth `MAX_EVENT_DEPTH` or deeper (a node's depth is its path's length, the root's 0, so the rule is
 * `parent.length + subtreeHeight(node) < MAX_EVENT_DEPTH`; the parser drops deeper nodes), and the tree would hold at
 * most `MAX_EVENT_NODES` nodes (`countNodes(root) + countNodes(node) <= MAX_EVENT_NODES`).
 */
export function canAddChild(root: EventNode, parent: NodePath, node: EventNode): boolean {
  void root; void parent; void node;
  throw new Error("not implemented"); // L6.3a
}

/**
 * Insert `node` (as given, not copied) into the children of the list container at `parent`, at `index` (default: the
 * end; clamped to 0..children.length). Returns the new root and the new node's path. Throws `RangeError` when
 * `canAddChild` is false.
 */
export function addChild(root: EventNode, parent: NodePath, node: EventNode, index?: number): TreeEdit {
  void root; void parent; void node; void index;
  throw new Error("not implemented"); // L6.3a
}

/**
 * Fill or clear a slot of the sustain node at `sustain`: `node` undefined clears `start` or `end` (the key is removed,
 * not set to undefined). Replaces whatever the slot held. Returns the new root and the slot's path. Throws
 * `RangeError` when `sustain` isn't a sustain node, when clearing `loop` (it is required), or when the depth or node
 * limits of `canAddChild` would be passed.
 */
export function setSustainSlot(root: EventNode, sustain: NodePath, slot: SustainSlot, node: EventNode | undefined): TreeEdit {
  void root; void sustain; void slot; void node;
  throw new Error("not implemented"); // L6.3a
}

/** Whether the node at `path` may be removed: it exists, isn't the root, and isn't a sustain node's `loop`. */
export function canRemove(root: EventNode, path: NodePath): boolean {
  void root; void path;
  throw new Error("not implemented"); // L6.3a
}

/**
 * A new root without the node at `path` (and its subtree): spliced out of a list, or a sustain `start`/`end` slot's key
 * removed. Throws `RangeError` when `canRemove` is false.
 */
export function removeNode(root: EventNode, path: NodePath): EventNode {
  void root; void path;
  throw new Error("not implemented"); // L6.3a
}

/**
 * Move the child at `from` to position `to` among the same list container's children (both indices of the list as it
 * is now, `to` clamped to 0..n-1; the moved child ends up at index `to`). Returns the new root and the child's new path;
 * `from === to` returns the root unchanged (the same object). Throws `RangeError` when `parent` isn't a list container
 * or `from` is out of range.
 */
export function reorderChild(root: EventNode, parent: NodePath, from: number, to: number): TreeEdit {
  void root; void parent; void from; void to;
  throw new Error("not implemented"); // L6.3a
}

/**
 * Whether the node at `from` may move to `to`: `canRemove(root, from)`; `to.parent` exists and is not `from` or inside
 * it; a list target is a list container (`index` in 0..children.length, counted before the move); a slot target is a
 * sustain node whose slot is empty (a `loop` slot is never empty); and the depth limit of `canAddChild` holds at the
 * new place.
 */
export function canMove(root: EventNode, from: NodePath, to: DropTarget): boolean {
  void root; void from; void to;
  throw new Error("not implemented"); // L6.3a
}

/**
 * Move the subtree at `from` to `to` in one edit. A list target's `index` is a position in the target's children as
 * they are before the move (where the drop indicator was drawn); when the node leaves the same list from an earlier
 * index, the insertion index is one less, so the node lands where the indicator was. Paths in `to.parent` are of the
 * tree before the move, too: the function adjusts for the removal. Returns the new root and the node's new path.
 * Throws `RangeError` when `canMove` is false.
 */
export function moveNode(root: EventNode, from: NodePath, to: DropTarget): TreeEdit {
  void root; void from; void to;
  throw new Error("not implemented"); // L6.3a
}

/** Whether the node at `path` may be duplicated: it is a list container's child and the node limit holds for a copy. */
export function canDuplicate(root: EventNode, path: NodePath): boolean {
  void root; void path;
  throw new Error("not implemented"); // L6.3a
}

/**
 * Insert a deep copy (`cloneNode`) of the node at `path` right after it in its list. Returns the new root and the
 * copy's path. Throws `RangeError` when `canDuplicate` is false.
 */
export function duplicateNode(root: EventNode, path: NodePath): TreeEdit {
  void root; void path;
  throw new Error("not implemented"); // L6.3a
}

/**
 * Replace the node at `path` with a fresh container of `type` (`newNode(type)`) holding it: as its only child for a list
 * type, in its `loop` slot for `"sustain"`. The wrapped node moves in unchanged and the wrapper takes over none of its
 * fields. Returns the new root and the wrapper's path (equal to `path`). Throws `RangeError` when the path leads
 * nowhere or the depth limit would be passed (`path.length + 1 + subtreeHeight(node) > MAX_EVENT_DEPTH`).
 */
export function wrapNode(root: EventNode, path: NodePath, type: ListNodeType | "sustain"): TreeEdit {
  void root; void path; void type;
  throw new Error("not implemented"); // L6.3a
}

// --- parameters -----------------------------------------------------------------------------------------------------

/**
 * How many places name the parameter `name`: `switch`/`blend` nodes' `parameter`, and `automation` entries' `parameter`
 * on the event and on every node. For the "delete parameter" confirmation.
 */
export function parameterUses(event: AudioEventAsset, name: string): number {
  void event; void name;
  throw new Error("not implemented"); // L6.3a
}

/**
 * A copy of `event` with every use of the parameter `from` (as `parameterUses` counts them, plus the entry in
 * `event.parameters` itself) renamed `to`. Nothing else changes; subtrees without a use are shared. When `from` equals
 * `to` the event comes back as is.
 */
export function renameParameter(event: AudioEventAsset, from: string, to: string): AudioEventAsset {
  void event; void from; void to;
  throw new Error("not implemented"); // L6.3a
}

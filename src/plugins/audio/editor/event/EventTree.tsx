// The Event editor's container tree (ADR 0158 §7): the event row, then the nodes depth first with each sustain's
// empty slots as placeholder rows. A toolbar adds, wraps, retypes, duplicates, reorders and deletes; rows drag to
// a new place; clips dragged from the asset browser drop into containers and slots or onto a clip row. Every edit is
// handed to the panel as a new root and the path to select, which it makes one undo step.
// A music event (ADR 0166, decision D6: its tree is `AudioEventAsset.musicRoot`) shows `MusicTree` instead: segments,
// playlists and music switches with their `library` segments, edited by the `*Music*` functions below.
import { useEffect, useRef, useState } from "preact/hooks";
import { registerAssetDropTarget } from "../../../../editor/sdk";
import { NODE_TYPES } from "../../../../engine/audio/eventFormat";
import { audioPaths } from "./assetDrop";
import { addNode, changeListType } from "./treeActions";
import { applyClipDrop, canDropNode, describeDrop, dropAt, type DropRow, type TreeDrop } from "./treeDrop";
// The Event editor's pure tree operations (ADR 0158 §1, §7): addressing a node of an audio event's container tree by
// path, and every structural edit the tree pane makes (add, remove, reorder, move, duplicate, wrap), plus renaming a
// local parameter everywhere it is used. Every function returns new values and never mutates its inputs: untouched
// subtrees are shared, changed ones are copied along the path. The panel turns each result into one undoable edit.
import {
  MAX_EVENT_DEPTH,
  MAX_EVENT_NODES,
  eventNodes,
  type Automation,
  type AudioEventAsset,
  type EventNode,
  type NodeBase,
  type NodeType,
} from "../../../../engine/audio/eventFormat";
import {
  MUSIC_ID_PATTERN,
  MUSIC_LIMITS,
  emptySegment,
  isMusicContainer,
  type MusicNode,
  type MusicNodeType,
  type MusicSwitchNode,
  type PlaylistNode,
  type SegmentNode,
} from "../../../../engine/audio/musicFormat";

/** A `sustain` node's three slots, in play order. `loop` is required; `start` and `end` are optional. */
export const SUSTAIN_SLOTS = ["start", "loop", "end"] as const;
export type SustainSlot = (typeof SUSTAIN_SLOTS)[number];

/**
 * One step down the tree: an index into a list container's `children` (`random`, `sequence`, `switch`, `blend`,
 * `layer`), or a slot name of a `sustain` node.
 */
export type PathStep = number | SustainSlot | LibraryStep;

/** A music container's `library` segment `n` (`"lib0"`): the step to it from the container, beside its numeric `children` steps. */
export type LibraryStep = `lib${number}`;
const LIBRARY_STEP = /^lib(0|[1-9][0-9]*)$/;
const libraryIndex = (step: PathStep): number | null => (typeof step === "string" && LIBRARY_STEP.test(step) ? Number(step.slice(3)) : null);

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

type ListContainer = Extract<EventNode, { type: ListNodeType }>;

/** A child and the step that leads to it from its parent. */
type ChildEntry = [PathStep, EventNode];

// --- paths ----------------------------------------------------------------------------------------------------------

/**
 * A stable string for a path, for selection state and Preact keys: steps joined by `/` (`""` for the root,
 * `"1/loop/0"`). `parsePathKey` reverses it.
 */
export function pathKey(path: NodePath): string {
  return path.map(String).join("/");
}

const CANONICAL_INDEX = /^(0|[1-9][0-9]*)$/;

/** The path `pathKey` made. Numeric steps come back as numbers, slot names as slots; anything else is `null`. */
export function parsePathKey(key: string): NodePath | null {
  if (key === "") return [];
  const out: PathStep[] = [];
  for (const part of key.split("/")) {
    if (CANONICAL_INDEX.test(part)) {
      const n = Number(part);
      if (!Number.isSafeInteger(n)) return null;
      out.push(n);
    } else if (isSlot(part) || LIBRARY_STEP.test(part)) out.push(part as PathStep);
    else return null;
  }
  return out;
}

/** True when both paths have the same steps. */
export function samePath(a: NodePath, b: NodePath): boolean {
  return a.length === b.length && a.every((step, i) => step === b[i]);
}

/** True when `ancestor` is a proper prefix of `path` (a path is not its own ancestor). */
export function isAncestor(ancestor: NodePath, path: NodePath): boolean {
  return ancestor.length < path.length && ancestor.every((step, i) => step === path[i]);
}

/** The parent's path, or `null` for the root. */
export function parentPath(path: NodePath): NodePath | null {
  return path.length === 0 ? null : path.slice(0, -1);
}

// --- reading --------------------------------------------------------------------------------------------------------

/** True for the list containers (`LIST_NODE_TYPES`). */
export function isListNode(node: EventNode): node is Extract<EventNode, { type: ListNodeType }> {
  return (LIST_NODE_TYPES as readonly string[]).includes(node.type);
}

/**
 * The steps from `node` to each child it has, in tree order: `0..n-1` for a list container, the filled slots of a
 * sustain node in `SUSTAIN_SLOTS` order (`"loop"` always), nothing for a clip.
 */
export function childSteps(node: EventNode): PathStep[] {
  return childEntries(node).map(([step]) => step);
}

/** The node at `path`, or `undefined` when the path doesn't lead to one (a stale selection, say). */
export function getNode(root: EventNode, path: NodePath): EventNode | undefined {
  let node: EventNode | undefined = root;
  for (const step of path) {
    if (!node) return undefined;
    node = getChild(node, step);
  }
  return node;
}

/** Every node's path, depth first, in the order `eventNodes` walks (sustain slots start, loop, end). The root's is `[]`. */
export function nodePaths(root: EventNode): NodePath[] {
  const out: NodePath[] = [];
  const walk = (node: EventNode, path: NodePath): void => {
    out.push(path);
    for (const [step, child] of childEntries(node)) walk(child, [...path, step]);
  };
  walk(root, []);
  return out;
}

/** The number of nodes in the subtree (the node itself included). */
export function countNodes(node: EventNode): number {
  return childEntries(node).reduce((n, [, child]) => n + countNodes(child), 1);
}

/** The subtree's height in levels: 1 for a node without children, 1 + its deepest child's otherwise. */
export function subtreeHeight(node: EventNode): number {
  return childEntries(node).reduce((h, [, child]) => Math.max(h, subtreeHeight(child)), 0) + 1;
}

/**
 * A short label for the tree row: a clip's file name without folder or extension (`"sfx/step_01.ogg"` → `"step_01"`),
 * `"(no clip)"` for an empty clip; a container's type capitalised (`"Random"`, `"Sequence"`…).
 */
export function nodeLabel(node: EventNode): string {
  if (node.type === "clip") {
    if (node.clip === "") return "(no clip)";
    const file = node.clip.slice(node.clip.lastIndexOf("/") + 1);
    return file.replace(/\.[^.]*$/, "") || file || "(no clip)";
  }
  return node.type.charAt(0).toUpperCase() + node.type.slice(1);
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
  const base: NodeBase = {
    volume: 1,
    pitch: 1,
    volumeRandom: [0, 0],
    pitchRandom: [0, 0],
    delay: 0,
    automation: [],
    weight: 1,
    fade: 0,
  };
  switch (type) {
    case "clip":
      return { ...base, type, clip: clip ?? "", loop: false, startOffset: 0, sustain: false };
    case "random":
      return { ...base, type, children: [], avoidRepeat: 0, mode: "step", gap: 0 };
    case "sequence":
      return { ...base, type, children: [], mode: "step", loop: false, gap: 0, reset: 0 };
    case "switch":
      return { ...base, type, parameter: "", children: [], onChange: "keep", crossfade: 0.1 };
    case "blend":
      return { ...base, type, parameter: "", children: [] };
    case "layer":
      return { ...base, type, children: [] };
    case "sustain":
      return { ...base, type, loop: newNode("clip"), release: "loopEnd" };
  }
}

/** A deep copy of the subtree: equal by value, sharing no object or array with `node`. */
export function cloneNode(node: EventNode): EventNode {
  return deepCopy(node);
}

// --- edits ----------------------------------------------------------------------------------------------------------

/**
 * A new root with the node at `path` replaced by `node` (ancestors copied, everything else shared). `path` `[]`
 * replaces the root. Throws `RangeError` when `path` doesn't lead to a node.
 */
export function setNode(root: EventNode, path: NodePath, node: EventNode): EventNode {
  if (getNode(root, path) === undefined) throw new RangeError(`no node at "${pathKey(path)}"`);
  return replaceAt(root, path, 0, node);
}

/**
 * Whether `node` may be added under the list container at `parent`: the parent exists and is a list container, no node
 * would sit at depth `MAX_EVENT_DEPTH` or deeper (a node's depth is its path's length, the root's 0, so the rule is
 * `parent.length + subtreeHeight(node) < MAX_EVENT_DEPTH`; the parser drops deeper nodes), and the tree would hold at
 * most `MAX_EVENT_NODES` nodes (`countNodes(root) + countNodes(node) <= MAX_EVENT_NODES`).
 */
export function canAddChild(root: EventNode, parent: NodePath, node: EventNode): boolean {
  const target = getNode(root, parent);
  if (!target || !isListNode(target)) return false;
  return parent.length + subtreeHeight(node) < MAX_EVENT_DEPTH && countNodes(root) + countNodes(node) <= MAX_EVENT_NODES;
}

/**
 * Insert `node` (as given, not copied) into the children of the list container at `parent`, at `index` (default: the
 * end; clamped to 0..children.length). Returns the new root and the new node's path. Throws `RangeError` when
 * `canAddChild` is false.
 */
export function addChild(root: EventNode, parent: NodePath, node: EventNode, index?: number): TreeEdit {
  if (!canAddChild(root, parent, node)) throw new RangeError(`cannot add a node under "${pathKey(parent)}"`);
  const target = getNode(root, parent) as ListContainer;
  const children = target.children;
  const at = index === undefined || !Number.isFinite(index)
    ? children.length
    : Math.max(0, Math.min(children.length, Math.trunc(index)));
  const next = [...children.slice(0, at), node, ...children.slice(at)];
  return { root: setNode(root, parent, withFields(target, { children: next })), path: [...parent, at] };
}

/**
 * Fill or clear a slot of the sustain node at `sustain`: `node` undefined clears `start` or `end` (the key is removed,
 * not set to undefined). Replaces whatever the slot held. Returns the new root and the slot's path. Throws
 * `RangeError` when `sustain` isn't a sustain node, when clearing `loop` (it is required), or when the depth or node
 * limits of `canAddChild` would be passed.
 */
export function setSustainSlot(root: EventNode, sustain: NodePath, slot: SustainSlot, node: EventNode | undefined): TreeEdit {
  const target = getNode(root, sustain);
  if (!target || target.type !== "sustain") throw new RangeError(`"${pathKey(sustain)}" is not a sustain node`);
  if (slot === "loop" && node === undefined) throw new RangeError("the loop slot is required");
  if (node !== undefined) {
    if (sustain.length + subtreeHeight(node) >= MAX_EVENT_DEPTH) throw new RangeError("nested too deeply");
    const replaced = target[slot];
    const count = countNodes(root) - (replaced ? countNodes(replaced) : 0) + countNodes(node);
    if (count > MAX_EVENT_NODES) throw new RangeError(`more than ${MAX_EVENT_NODES} nodes`);
  }
  const next: Record<string, unknown> = { ...target };
  if (node === undefined) delete next[slot];
  else next[slot] = node;
  return {
    root: setNode(root, sustain, next as unknown as EventNode),
    // A cleared slot has no node to select, so the edit selects the sustain that lost it.
    path: node === undefined ? [...sustain] : [...sustain, slot],
  };
}

/** Whether the node at `path` may be removed: it exists, isn't the root, and isn't a sustain node's `loop`. */
export function canRemove(root: EventNode, path: NodePath): boolean {
  if (path.length === 0 || getNode(root, path) === undefined) return false;
  return path[path.length - 1] !== "loop";
}

/**
 * A new root without the node at `path` (and its subtree): spliced out of a list, or a sustain `start`/`end` slot's key
 * removed. Throws `RangeError` when `canRemove` is false.
 */
export function removeNode(root: EventNode, path: NodePath): EventNode {
  if (!canRemove(root, path)) throw new RangeError(`cannot remove "${pathKey(path)}"`);
  const parentP = parentPath(path) as NodePath;
  const parent = getNode(root, parentP) as EventNode;
  const step = path[path.length - 1];
  if (typeof step === "number") {
    const children = (parent as ListContainer).children.filter((_, i) => i !== step);
    return setNode(root, parentP, withFields(parent, { children }));
  }
  const next: Record<string, unknown> = { ...parent };
  delete next[step];
  return setNode(root, parentP, next as unknown as EventNode);
}

/**
 * Move the child at `from` to position `to` among the same list container's children (both indices of the list as it
 * is now, `to` clamped to 0..n-1; the moved child ends up at index `to`). Returns the new root and the child's new path;
 * `from === to` returns the root unchanged (the same object). Throws `RangeError` when `parent` isn't a list container
 * or `from` is out of range.
 */
export function reorderChild(root: EventNode, parent: NodePath, from: number, to: number): TreeEdit {
  const list = getNode(root, parent);
  if (!list || !isListNode(list)) throw new RangeError(`"${pathKey(parent)}" is not a list container`);
  const n = list.children.length;
  if (!Number.isInteger(from) || from < 0 || from >= n) throw new RangeError(`no child ${from}`);
  if (!Number.isFinite(to)) throw new RangeError(`bad index ${to}`);
  const at = Math.max(0, Math.min(n - 1, Math.trunc(to)));
  if (at === from) return { root, path: [...parent, from] };
  const children = list.children.slice();
  const [moved] = children.splice(from, 1);
  children.splice(at, 0, moved);
  return { root: setNode(root, parent, withFields(list, { children })), path: [...parent, at] };
}

/**
 * Whether the node at `from` may move to `to`: `canRemove(root, from)`; `to.parent` exists and is not `from` or inside
 * it; a list target is a list container (`index` in 0..children.length, counted before the move); a slot target is a
 * sustain node whose slot is empty (a `loop` slot is never empty); and the depth limit of `canAddChild` holds at the
 * new place.
 */
export function canMove(root: EventNode, from: NodePath, to: DropTarget): boolean {
  if (!canRemove(root, from)) return false;
  const node = getNode(root, from) as EventNode;
  const target = getNode(root, to.parent);
  if (!target) return false;
  if (samePath(to.parent, from) || isAncestor(from, to.parent)) return false;
  if (to.parent.length + subtreeHeight(node) >= MAX_EVENT_DEPTH) return false;
  if ("slot" in to) return target.type === "sustain" && target[to.slot] === undefined;
  return isListNode(target) && Number.isInteger(to.index) && to.index >= 0 && to.index <= target.children.length;
}

/**
 * Move the subtree at `from` to `to` in one edit. A list target's `index` is a position in the target's children as
 * they are before the move (where the drop indicator was drawn); when the node leaves the same list from an earlier
 * index, the insertion index is one less, so the node lands where the indicator was. Paths in `to.parent` are of the
 * tree before the move, too: the function adjusts for the removal. Returns the new root and the node's new path.
 * Throws `RangeError` when `canMove` is false.
 */
export function moveNode(root: EventNode, from: NodePath, to: DropTarget): TreeEdit {
  if (!canMove(root, from, to)) throw new RangeError(`cannot move "${pathKey(from)}" to "${pathKey(to.parent)}"`);
  const node = getNode(root, from) as EventNode;
  const fromParent = parentPath(from) as NodePath;
  const fromStep = from[from.length - 1];

  // Removing a list child shifts the later siblings of that list, and so any target path inside one of them.
  let parent: NodePath = to.parent;
  const at = fromParent.length;
  const stepAt = parent[at];
  if (typeof fromStep === "number" && parent.length > at && typeof stepAt === "number" && stepAt > fromStep
    && samePath(parent.slice(0, at), fromParent)) {
    parent = [...parent.slice(0, at), stepAt - 1, ...parent.slice(at + 1)];
  }

  const without = removeNode(root, from);
  if ("slot" in to) return setSustainSlot(without, parent, to.slot, node);
  let index = to.index;
  if (typeof fromStep === "number" && samePath(to.parent, fromParent) && index > fromStep) index -= 1;
  return addChild(without, parent, node, index);
}

/** Whether the node at `path` may be duplicated: it is a list container's child and the node limit holds for a copy. */
export function canDuplicate(root: EventNode, path: NodePath): boolean {
  const node = getNode(root, path);
  if (!node || path.length === 0 || typeof path[path.length - 1] !== "number") return false;
  return countNodes(root) + countNodes(node) <= MAX_EVENT_NODES;
}

/**
 * Insert a deep copy (`cloneNode`) of the node at `path` right after it in its list. Returns the new root and the
 * copy's path. Throws `RangeError` when `canDuplicate` is false.
 */
export function duplicateNode(root: EventNode, path: NodePath): TreeEdit {
  if (!canDuplicate(root, path)) throw new RangeError(`cannot duplicate "${pathKey(path)}"`);
  const parent = parentPath(path) as NodePath;
  const index = path[path.length - 1] as number;
  return addChild(root, parent, cloneNode(getNode(root, path) as EventNode), index + 1);
}

/**
 * Replace the node at `path` with a fresh container of `type` (`newNode(type)`) holding it: as its only child for a list
 * type, in its `loop` slot for `"sustain"`. The wrapped node moves in unchanged and the wrapper takes over none of its
 * fields. Returns the new root and the wrapper's path (equal to `path`). Throws `RangeError` when the path leads
 * nowhere or the depth limit would be passed (`path.length + 1 + subtreeHeight(node) > MAX_EVENT_DEPTH`).
 */
export function wrapNode(root: EventNode, path: NodePath, type: ListNodeType | "sustain"): TreeEdit {
  const node = getNode(root, path);
  if (!node) throw new RangeError(`no node at "${pathKey(path)}"`);
  if (path.length + 1 + subtreeHeight(node) > MAX_EVENT_DEPTH) throw new RangeError("nested too deeply");
  if (countNodes(root) + 1 > MAX_EVENT_NODES) throw new RangeError(`more than ${MAX_EVENT_NODES} nodes`);
  const fresh = newNode(type);
  const wrapper = type === "sustain"
    ? withFields(fresh, { loop: node })
    : withFields(fresh, { children: [node] });
  return { root: setNode(root, path, wrapper), path: [...path] };
}

// --- parameters -----------------------------------------------------------------------------------------------------

/**
 * How many places name the parameter `name`: `switch`/`blend` nodes' `parameter`, and `automation` entries' `parameter`
 * on the event and on every node. For the "delete parameter" confirmation.
 */
export function parameterUses(event: AudioEventAsset, name: string): number {
  let uses = event.automation.filter((a) => a.parameter === name).length;
  for (const node of eventNodes(event.root)) {
    uses += node.automation.filter((a) => a.parameter === name).length;
    if ((node.type === "switch" || node.type === "blend") && node.parameter === name) uses++;
  }
  if (event.musicRoot) uses += musicParameterUses(event.musicRoot, name);
  return uses;
}

/**
 * A copy of `event` with every use of the parameter `from` (as `parameterUses` counts them, plus the entry in
 * `event.parameters` itself) renamed `to`. Nothing else changes; subtrees without a use are shared. When `from` equals
 * `to` the event comes back as is.
 */
export function renameParameter(event: AudioEventAsset, from: string, to: string): AudioEventAsset {
  if (from === to) return event;
  const renameAutomation = (list: Automation[]): Automation[] =>
    list.some((a) => a.parameter === from) ? list.map((a) => (a.parameter === from ? { ...a, parameter: to } : a)) : list;
  const renameNode = (node: EventNode): EventNode => {
    const fields: Record<string, unknown> = {};
    const automation = renameAutomation(node.automation);
    if (automation !== node.automation) fields.automation = automation;
    if ((node.type === "switch" || node.type === "blend") && node.parameter === from) fields.parameter = to;
    if (node.type === "sustain") {
      for (const slot of SUSTAIN_SLOTS) {
        const child = node[slot];
        if (child) {
          const renamed = renameNode(child);
          if (renamed !== child) fields[slot] = renamed;
        }
      }
    } else if (node.type !== "clip") {
      const children = node.children.map((c) => renameNode(c));
      if (children.some((c, i) => c !== node.children[i])) fields.children = children;
    }
    return Object.keys(fields).length > 0 ? withFields(node, fields) : node;
  };
  return {
    ...event,
    parameters: event.parameters.map((p) => (p.name === from ? { ...p, name: to } : p)),
    automation: renameAutomation(event.automation),
    root: renameNode(event.root),
    ...(event.musicRoot ? { musicRoot: renameMusicParameter(event.musicRoot, from, to) } : {}),
  };
}

// --- music trees (ADR 0166 §2.3, §2.5; decision D6) ----------------------------------------------------------------------
// A music event's tree is `AudioEventAsset.musicRoot`: segments, playlists and music switches. A container's children
// are reached by number, its `library` segments (bridges and stingers) by `"lib<n>"`. Ids are required and unique per
// event, so every edit here keeps them so (a duplicate would make the parser drop the second node) and keeps the
// rules, bridges and stingers that name an id in step with it. Same conventions as above: pure, new values, shared
// subtrees.

/** A music tree edit's result: the new root and the path of the node it made or moved (to select it). */
export interface MusicEdit {
  root: MusicNode;
  path: NodePath;
}

/** What "Add" can make in a music tree: a node of a music type, or a `library` segment of a container. */
export type MusicAddKind = MusicNodeType | "library";

const musicChild = (node: MusicNode, step: PathStep): MusicNode | undefined => {
  if (!isMusicContainer(node)) return undefined;
  if (typeof step === "number") return node.children[step];
  const i = libraryIndex(step);
  return i === null ? undefined : node.library[i];
};

/** The music node at `path` (`[]` is the root), or `undefined`. */
export function getMusicNode(root: MusicNode, path: NodePath): MusicNode | undefined {
  let node: MusicNode | undefined = root;
  for (const step of path) {
    if (!node) return undefined;
    node = musicChild(node, step);
  }
  return node;
}

/** Whether the node at `path` is one of its container's `library` segments. */
export const isLibraryPath = (path: NodePath): boolean => path.length > 0 && libraryIndex(path[path.length - 1]) !== null;

/** The steps from a music node to its children, then its library segments. */
function musicSteps(node: MusicNode): PathStep[] {
  if (!isMusicContainer(node)) return [];
  return [...node.children.map((_, i): PathStep => i), ...node.library.map((_, i): PathStep => `lib${i}`)];
}

/** Every music node with its path, depth first: children, then the library, as `eventNodes` walks them. */
export function musicNodePaths(root: MusicNode): { path: NodePath; node: MusicNode }[] {
  const out: { path: NodePath; node: MusicNode }[] = [];
  const walk = (node: MusicNode, path: NodePath): void => {
    out.push({ path, node });
    for (const step of musicSteps(node)) walk(musicChild(node, step)!, [...path, step]);
  };
  walk(root, []);
  return out;
}

const countMusic = (node: MusicNode): number => 1 + musicSteps(node).reduce<number>((n, step) => n + countMusic(musicChild(node, step)!), 0);

/** `node` with `fields` set, as a shallow copy of the same type. */
const withMusic = <T extends MusicNode>(node: T, fields: Partial<T>): T => ({ ...node, ...fields });

/** A new root with the node at `path` replaced by `node` (ancestors copied). Throws `RangeError` when `path` leads nowhere. */
export function setMusicNode(root: MusicNode, path: NodePath, node: MusicNode): MusicNode {
  if (getMusicNode(root, path) === undefined) throw new RangeError(`no node at "${pathKey(path)}"`);
  const at = (current: MusicNode, i: number): MusicNode => {
    if (i === path.length) return node;
    const step = path[i];
    const child = at(musicChild(current, step)!, i + 1);
    const container = current as PlaylistNode | MusicSwitchNode;
    if (typeof step === "number") return withMusic(container, { children: container.children.map((c, j) => (j === step ? child : c)) });
    const n = libraryIndex(step)!;
    return withMusic(container, { library: container.library.map((c, j) => (j === n ? (child as SegmentNode) : c)) });
  };
  return at(root, 0);
}

/** `fn` applied to every node of the subtree, bottom up; nodes `fn` leaves alone (same object) and their ancestors are shared. */
function mapMusic(node: MusicNode, fn: (n: MusicNode) => MusicNode): MusicNode {
  if (!isMusicContainer(node)) return fn(node);
  const children = node.children.map((c) => mapMusic(c, fn));
  const library = node.library.map((c) => mapMusic(c, fn) as SegmentNode);
  const same = children.every((c, i) => c === node.children[i]) && library.every((c, i) => c === node.library[i]);
  return fn(same ? node : withMusic(node, { children, library }));
}

/** The library segments in the whole event (the limit is per event). */
const libraryCount = (root: MusicNode): number => musicNodePaths(root).reduce((n, e) => n + (isMusicContainer(e.node) ? e.node.library.length : 0), 0);

/** Every id in the tree, in walk order (library segments included). */
export const musicIds = (root: MusicNode): string[] => musicNodePaths(root).map((e) => e.node.id);

/** The text for an id the format refuses, or `null` when `id` is fine for the node at `path` (its own id doesn't clash with itself). */
export function musicIdProblem(root: MusicNode, path: NodePath, id: string): string | null {
  if (!MUSIC_ID_PATTERN.test(id)) return "An id is 1 to 48 letters, digits, - or _.";
  if (musicNodePaths(root).some((e) => e.node.id === id && !samePath(e.path, path))) return `The id "${id}" is already used in this event.`;
  return null;
}

/** An id based on `base` (cleaned to the id alphabet and length) that no node uses: `base`, `base-2`, `base-3`… */
export function freshMusicId(taken: ReadonlySet<string>, base: string): string {
  const clean = base.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "node";
  if (!taken.has(clean)) return clean;
  for (let n = 2; ; n++) {
    const id = `${clean}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** The container with every id its rules, bridges and stingers name looked up in `map` (unlisted ids stay). */
function remapReferences(node: MusicNode, map: ReadonlyMap<string, string>): MusicNode {
  if (!isMusicContainer(node)) return node;
  const to = (id: string): string => map.get(id) ?? id;
  const transitions = node.transitions.map((r) => {
    const bridge = r.bridge && map.has(r.bridge.segment) ? { ...r.bridge, segment: to(r.bridge.segment) } : r.bridge;
    return r.from === to(r.from) && r.to === to(r.to) && bridge === r.bridge ? r : { ...r, from: to(r.from), to: to(r.to), ...(bridge ? { bridge } : {}) };
  });
  const stingers = node.stingers.map((s) => (map.has(s.segment) ? { ...s, segment: to(s.segment) } : s));
  const same = transitions.every((r, i) => r === node.transitions[i]) && stingers.every((s, i) => s === node.stingers[i]);
  return same ? node : withMusic(node, { transitions, stingers });
}

/** The node at `path` renamed `id` (the caller checked `musicIdProblem`), and every rule, bridge and stinger that named the old id follows. */
export function renameMusicId(root: MusicNode, path: NodePath, id: string): MusicNode {
  const node = getMusicNode(root, path);
  if (!node || node.id === id) return root;
  const map = new Map([[node.id, id]]);
  return mapMusic(setMusicNode(root, path, withMusic(node, { id })), (n) => remapReferences(n, map));
}

/** A fresh music node of `type` with `id`, every field at the default the parser gives it (an empty segment has no stems yet). */
export function newMusicNode(type: MusicNodeType, id: string): MusicNode {
  if (type === "segment") return emptySegment(id);
  const base = {
    id, volume: 1, pitch: 1, pitchRandom: [0, 0] as [number, number], volumeRandom: [0, 0] as [number, number], delay: 0, automation: [],
    weight: 1, fade: 0, plays: 1, children: [], library: [], transitions: [], stingers: [],
  };
  return type === "playlist"
    ? { ...base, type, mode: "sequence", rounds: 1, avoidRepeat: 0 }
    : { ...base, type, parameter: "" };
}

/**
 * Where "Add" puts a node: `library` segments go to the selected container (or the container of a selected child or
 * library segment); other nodes go into the selected container at its end, or beside a selected child (after it); the
 * event row (`null`) means the root. Null when there is no such container.
 */
function musicAddTarget(root: MusicNode, selected: NodePath | null, library: boolean): { parent: NodePath; index: number } | null {
  const path = selected ?? [];
  const node = getMusicNode(root, path);
  if (!node) return null;
  const upper = path.length > 0 ? path.slice(0, -1) : null;
  const step = path[path.length - 1];
  const host: NodePath | null = isMusicContainer(node) ? path : upper;
  const hostNode = host ? getMusicNode(root, host) : undefined;
  if (!host || !hostNode || !isMusicContainer(hostNode)) return null;
  if (library) return { parent: host, index: hostNode.library.length };
  if (host === path || typeof step !== "number") return { parent: host, index: hostNode.children.length };
  return { parent: host, index: step + 1 };
}

/** Add a fresh node (or `library` segment) where `musicAddTarget` says; the new node's id is based on its type. Or a reason it can't. */
export function addMusicNode(root: MusicNode, selected: NodePath | null, kind: MusicAddKind): MusicEdit | string {
  const at = musicAddTarget(root, selected, kind === "library");
  if (!at) return "select a playlist or music switch, or a node in one, to add to it";
  const container = getMusicNode(root, at.parent) as PlaylistNode | MusicSwitchNode;
  const type: MusicNodeType = kind === "library" ? "segment" : kind;
  const id = freshMusicId(new Set(musicIds(root)), kind === "library" ? "library" : type === "musicSwitch" ? "switch" : type);
  const node = newMusicNode(type, id);
  if (countMusic(root) + 1 > MAX_EVENT_NODES) return "the event can't hold more nodes";
  if (at.parent.length + 1 >= MAX_EVENT_DEPTH) return "the event can't hold more nodes there";
  if (kind === "library") {
    if (libraryCount(root) >= MUSIC_LIMITS.library) return `an event holds at most ${MUSIC_LIMITS.library} library segments`;
    return { root: setMusicNode(root, at.parent, withMusic(container, { library: [...container.library, node as SegmentNode] })), path: [...at.parent, `lib${container.library.length}`] };
  }
  if (container.children.length >= MUSIC_LIMITS.playlistChildren) return `a container holds at most ${MUSIC_LIMITS.playlistChildren} children`;
  const children = [...container.children.slice(0, at.index), node, ...container.children.slice(at.index)];
  return { root: setMusicNode(root, at.parent, withMusic(container, { children })), path: [...at.parent, at.index] };
}

/** Whether the node at `path` may be removed: it exists and isn't the root (an event keeps its music tree). */
export const canRemoveMusic = (root: MusicNode, path: NodePath): boolean => path.length > 0 && getMusicNode(root, path) !== undefined;

/**
 * A new root without the node at `path` (and its subtree). The rules naming a removed child, the bridges naming a removed
 * library segment and the stingers playing one go with it, so nothing dangles (the parser would drop them with a problem).
 * Throws `RangeError` when `canRemoveMusic` is false.
 */
export function removeMusicNode(root: MusicNode, path: NodePath): MusicNode {
  if (!canRemoveMusic(root, path)) throw new RangeError(`cannot remove "${pathKey(path)}"`);
  const gone = new Set(musicIds(getMusicNode(root, path)!));
  const parentP = path.slice(0, -1);
  const parent = getMusicNode(root, parentP) as PlaylistNode | MusicSwitchNode;
  const step = path[path.length - 1];
  const n = libraryIndex(step);
  const next = n === null
    ? withMusic(parent, { children: parent.children.filter((_, i) => i !== step) })
    : withMusic(parent, { library: parent.library.filter((_, i) => i !== n) });
  return mapMusic(setMusicNode(root, parentP, next), (node) => {
    if (!isMusicContainer(node)) return node;
    const transitions = node.transitions.filter((r) => !gone.has(r.from) && !gone.has(r.to)).map((r) => {
      if (!r.bridge || !gone.has(r.bridge.segment)) return r;
      const { bridge: _bridge, ...rest } = r;
      return rest;
    });
    const stingers = node.stingers.filter((s) => !gone.has(s.segment));
    return transitions.length === node.transitions.length && transitions.every((r, i) => r === node.transitions[i]) && stingers.length === node.stingers.length
      ? node
      : withMusic(node, { transitions, stingers });
  });
}

/** Move the child or library segment at `path` by `by` places among its siblings (clamped). The node keeps its id; rules name ids, so none change. */
export function reorderMusicNode(root: MusicNode, path: NodePath, by: number): MusicEdit {
  const parentP = path.slice(0, -1);
  const parent = getMusicNode(root, parentP);
  if (!parent || !isMusicContainer(parent) || path.length === 0) throw new RangeError(`"${pathKey(path)}" has no siblings`);
  const step = path[path.length - 1];
  const lib = libraryIndex(step);
  const list: MusicNode[] = lib === null ? parent.children : parent.library;
  const from = lib === null ? (step as number) : lib;
  const to = Math.max(0, Math.min(list.length - 1, from + by));
  if (to === from) return { root, path };
  const moved = list.slice();
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);
  const next = lib === null ? withMusic(parent, { children: moved }) : withMusic(parent, { library: moved as SegmentNode[] });
  return { root: setMusicNode(root, parentP, next), path: [...parentP, lib === null ? to : (`lib${to}` as const)] };
}

/** Whether the node at `path` may be duplicated: a child or library segment, with the node, depth and library limits holding for a copy. */
export function canDuplicateMusic(root: MusicNode, path: NodePath): boolean {
  const node = getMusicNode(root, path);
  if (!node || path.length === 0) return false;
  const parent = getMusicNode(root, path.slice(0, -1));
  if (!parent || !isMusicContainer(parent)) return false;
  if (countMusic(root) + countMusic(node) > MAX_EVENT_NODES) return false;
  if (libraryIndex(path[path.length - 1]) !== null) return libraryCount(root) < MUSIC_LIMITS.library;
  return parent.children.length < MUSIC_LIMITS.playlistChildren;
}

/**
 * Insert a deep copy of the node at `path` right after it, every id in the copy made fresh (`id-2`…) and the copy's own
 * rules, bridges and stingers following its renamed children. Throws `RangeError` when `canDuplicateMusic` is false.
 */
export function duplicateMusicNode(root: MusicNode, path: NodePath): MusicEdit {
  if (!canDuplicateMusic(root, path)) throw new RangeError(`cannot duplicate "${pathKey(path)}"`);
  const taken = new Set(musicIds(root));
  const map = new Map<string, string>();
  const fresh = (n: MusicNode): MusicNode => {
    const id = freshMusicId(taken, n.id);
    taken.add(id);
    map.set(n.id, id);
    return { ...deepCopy(n), id } as MusicNode;
  };
  const copy = mapMusic(getMusicNode(root, path)!, fresh);
  const renamed = mapMusic(copy, (n) => remapReferences(n, map));
  const parentP = path.slice(0, -1);
  const parent = getMusicNode(root, parentP) as PlaylistNode | MusicSwitchNode;
  const step = path[path.length - 1];
  const lib = libraryIndex(step);
  if (lib !== null) {
    const library = [...parent.library.slice(0, lib + 1), renamed as SegmentNode, ...parent.library.slice(lib + 1)];
    return { root: setMusicNode(root, parentP, withMusic(parent, { library })), path: [...parentP, `lib${lib + 1}`] };
  }
  const at = (step as number) + 1;
  // A music switch's children are keyed by `value`, and a copy with the same value would lose to the original: the copy starts unset.
  const unkeyed = parent.type === "musicSwitch" && renamed.value !== undefined ? (({ value: _value, ...rest }) => rest as MusicNode)(renamed) : renamed;
  const children = [...parent.children.slice(0, at), unkeyed, ...parent.children.slice(at)];
  return { root: setMusicNode(root, parentP, withMusic(parent, { children })), path: [...parentP, at] };
}

/** Every parameter name a music tree reads: musicSwitch parameters, stem automation and region `while` conditions. */
function musicParameterNames(root: MusicNode): string[] {
  const out: string[] = [];
  for (const { node } of musicNodePaths(root)) {
    if (node.type === "musicSwitch") out.push(node.parameter);
    if (node.type === "segment") {
      for (const t of node.tracks) for (const a of t.automation) out.push(a.parameter);
      for (const r of node.regions) if (r.while) out.push(r.while.parameter);
    }
  }
  return out;
}

/** How many places in a music tree name the parameter `name` (added to `parameterUses`' count for a music event). */
export const musicParameterUses = (root: MusicNode, name: string): number => musicParameterNames(root).filter((n) => n === name).length;

/** The music tree with every use of the parameter `from` renamed `to` (`renameParameter`'s music half). */
export function renameMusicParameter(root: MusicNode, from: string, to: string): MusicNode {
  return mapMusic(root, (n) => {
    if (n.type === "musicSwitch") return n.parameter === from ? withMusic(n, { parameter: to }) : n;
    if (n.type !== "segment") return n;
    const tracks = n.tracks.map((t) => (t.automation.some((a) => a.parameter === from) ? { ...t, automation: t.automation.map((a) => (a.parameter === from ? { ...a, parameter: to } : a)) } : t));
    const regions = n.regions.map((r) => (r.while?.parameter === from ? { ...r, while: { ...r.while, parameter: to } } : r));
    return tracks.some((t, i) => t !== n.tracks[i]) || regions.some((r, i) => r !== n.regions[i]) ? withMusic(n, { tracks, regions }) : n;
  });
}

/** A short label for a music tree row: the node's id. */
export const musicNodeLabel = (node: MusicNode): string => node.id;

// --- internals ------------------------------------------------------------------------------------------------------

function isSlot(step: unknown): step is SustainSlot {
  return (SUSTAIN_SLOTS as readonly unknown[]).includes(step);
}

/** A node's children with the steps that lead to them, in tree order (`getNode` and `nodePaths` both walk this). */
function childEntries(node: EventNode): ChildEntry[] {
  if (node.type === "clip") return [];
  if (node.type === "sustain") {
    const out: ChildEntry[] = [];
    if (node.start) out.push(["start", node.start]);
    out.push(["loop", node.loop]);
    if (node.end) out.push(["end", node.end]);
    return out;
  }
  return node.children.map((child, i): ChildEntry => [i, child]);
}

function getChild(node: EventNode, step: PathStep): EventNode | undefined {
  if (typeof step === "number") return isListNode(node) ? node.children[step] : undefined;
  if (!isSlot(step) || node.type !== "sustain") return undefined;
  return node[step];
}

/** The subtree with the child at `step` replaced by `child`; the ancestors are copied, the siblings shared. */
function withChild(node: EventNode, step: PathStep, child: EventNode): EventNode {
  if (typeof step === "number") {
    const children = (node as ListContainer).children.slice();
    children[step] = child;
    return withFields(node, { children });
  }
  return withFields(node, { [step]: child });
}

function replaceAt(current: EventNode, path: NodePath, i: number, node: EventNode): EventNode {
  if (i === path.length) return node;
  const step = path[i];
  const child = getChild(current, step) as EventNode;
  return withChild(current, step, replaceAt(child, path, i + 1, node));
}

/** `node` with `fields` set, as a shallow copy of the same type. */
function withFields(node: EventNode, fields: Record<string, unknown>): EventNode {
  return { ...node, ...fields } as EventNode;
}

function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => deepCopy(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = deepCopy(v);
    return out as T;
  }
  return value;
}

export interface EventTreeProps {
  root: EventNode;
  /** The selected node, or null for the event row. */
  selected: NodePath | null;
  onSelect(path: NodePath | null): void;
  /** An edit: the new root, the path to select (null: the event row) and the undo step's name. */
  onEdit(root: EventNode, select: NodePath | null, label: string): void;
  /** A problem to report (an action that can't be done). */
  onProblem(text: string): void;
  readOnly: boolean;
  /** Set for a music event (its `musicRoot`): the pane shows the music tree instead of `root`. */
  music?: MusicTreeProps;
}

type Row =
  | { kind: "node"; path: NodePath; node: EventNode; depth: number; slot?: SustainSlot }
  | { kind: "slot"; sustain: NodePath; slot: SustainSlot; depth: number };

/** The rows in display order: every node depth first, with each sustain's empty start and end as slot rows. */
function rowsOf(root: EventNode): Row[] {
  const out: Row[] = [];
  const walk = (node: EventNode, path: NodePath, depth: number, slot?: SustainSlot) => {
    out.push({ kind: "node", path, node, depth, slot });
    if (node.type === "sustain") {
      for (const s of SUSTAIN_SLOTS) {
        const child = node[s];
        if (child) walk(child, [...path, s], depth + 1, s);
        else out.push({ kind: "slot", sustain: path, slot: s, depth: depth + 1 });
      }
    } else for (const step of childSteps(node)) walk(getNode(node, [step])!, [...path, step], depth + 1);
  };
  walk(root, [], 0);
  return out;
}

/** Pointer travel (CSS px) before pressing a row becomes a drag, as in the asset browser. */
const DRAG_THRESHOLD = 5;

/** The row under a client point and the fraction of its height there, from the DOM (`data-event-row`). */
function rowAt(x: number, y: number): { row: DropRow; fraction: number } | null {
  const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-event-row]");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const fraction = r.height > 0 ? (y - r.top) / r.height : 0.5;
  const slot = el.dataset.slot as SustainSlot | undefined;
  const path = parsePathKey(el.dataset.eventPath ?? "");
  if (!path) return null;
  return { row: el.dataset.eventRow === "slot" ? { sustain: path, slot: slot! } : { path }, fraction };
}

/** The indicator a row shows for `drop`: a line before or after it, or a highlight for into / replace. */
function indicator(row: Row, drop: TreeDrop | null, root: EventNode): string {
  if (!drop) return "";
  if ("replace" in drop) return row.kind === "node" && samePath(row.path, drop.replace) ? " drop-replace" : "";
  if ("slot" in drop) return row.kind === "slot" && row.slot === drop.slot && samePath(row.sustain, drop.parent) ? " drop-into" : "";
  if (row.kind !== "node") return "";
  const parent = getNode(root, drop.parent);
  const count = parent && isListNode(parent) ? parent.children.length : 0;
  if (samePath(row.path, drop.parent)) return count === 0 || drop.index === count ? " drop-into" : "";
  const p = parentPath(row.path);
  const step = row.path[row.path.length - 1];
  if (!p || !samePath(p, drop.parent) || typeof step !== "number") return "";
  return step === drop.index ? " drop-before" : "";
}

const TYPE_LABEL: Record<NodeType, string> = { clip: "Clip", random: "Random", sequence: "Sequence", switch: "Switch", blend: "Blend", layer: "Layer", sustain: "Sustain" };

function ClassicEventTree(props: EventTreeProps) {
  const { root, selected, readOnly } = props;
  const rows = rowsOf(root);
  const sel = selected ? getNode(root, selected) : undefined;
  /** A row being dragged: its path and the drop under the pointer (after the threshold). */
  const [nodeDrag, setNodeDrag] = useState<{ from: NodePath; drop: TreeDrop | null; x: number; y: number } | null>(null);
  /** Clips from the asset browser over the tree: how many, and the drop under the pointer. */
  const [clipDrag, setClipDrag] = useState<{ count: number; drop: TreeDrop | null } | null>(null);

  const edit = (e: TreeEdit | string, label: string) => (typeof e === "string" ? props.onProblem(e) : props.onEdit(e.root, e.path, label));
  const add = (type: NodeType) => edit(addNode(root, selected, type), `Add ${type}`);
  const remove = () => {
    if (!selected || !canRemove(root, selected)) return;
    props.onEdit(removeNode(root, selected), parentPath(selected), "Delete node");
  };
  const step = selected?.[selected.length - 1];
  const parent = selected ? parentPath(selected) : null;
  const parentNode = parent ? getNode(root, parent) : undefined;
  const siblings = parentNode && isListNode(parentNode) ? parentNode.children.length : 0;
  const move = (by: number) => {
    if (!parent || typeof step !== "number") return;
    edit(reorderChild(root, parent, step, step + by), "Reorder node");
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, select, textarea")) return;
    const keys = rows.filter((r) => r.kind === "node").map((r) => (r as { path: NodePath }).path);
    const at = selected ? keys.findIndex((k) => samePath(k, selected)) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (e.altKey && !readOnly) return move(e.key === "ArrowDown" ? 1 : -1);
      const next = at + (e.key === "ArrowDown" ? 1 : -1);
      if (next < 0) props.onSelect(null);
      else if (next < keys.length) props.onSelect(keys[next]);
    } else if ((e.key === "Delete" || e.key === "Backspace") && !readOnly) {
      e.preventDefault();
      remove();
    } else if (e.key === "d" && (e.ctrlKey || e.metaKey) && !readOnly && selected && canDuplicate(root, selected)) {
      e.preventDefault();
      edit(duplicateNode(root, selected), "Duplicate node");
    }
  };

  /** Press on a row: select it; past the threshold, drag it to a new place. */
  const onRowPointerDown = (e: PointerEvent, path: NodePath) => {
    if (e.button !== 0) return;
    props.onSelect(path);
    if (readOnly || !canRemove(root, path)) return;
    const startX = e.clientX, startY = e.clientY;
    let active = false;
    let drop: TreeDrop | null = null;
    const update = (m: PointerEvent) => {
      if (!active && Math.hypot(m.clientX - startX, m.clientY - startY) < DRAG_THRESHOLD) return;
      active = true;
      const at = rowAt(m.clientX, m.clientY);
      const d = at ? dropAt(root, at.row, at.fraction, "node") : null;
      drop = canDropNode(root, path, d) ? d : null;
      setNodeDrag({ from: path, drop, x: m.clientX, y: m.clientY });
    };
    const finish = (apply: boolean) => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      setNodeDrag(null);
      if (apply && active && drop && canDropNode(root, path, drop)) edit(moveNode(root, path, drop), "Move node");
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (k: KeyboardEvent) => {
      if (k.key !== "Escape") return;
      k.preventDefault();
      k.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  };

  /** Clips from the asset browser: the tree is a drop target (SDK); the drag's label says what releasing does. */
  const clipDropAt = (x: number, y: number): TreeDrop | null => {
    const at = rowAt(x, y);
    if (at) return dropAt(root, at.row, at.fraction, "clips");
    return isListNode(root) ? { parent: [], index: root.children.length } : null; // empty space: the root's end
  };
  // The registered callbacks read the latest render's tree and edit through this ref.
  const live = useRef({ clipDropAt, edit, root, readOnly, setClipDrag });
  live.current = { clipDropAt, edit, root, readOnly, setClipDrag };
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!treeRef.current) return;
    const dropFor = (assets: readonly string[], p: { x: number; y: number }) => {
      const { clipDropAt, readOnly } = live.current;
      const clips = audioPaths(assets);
      return readOnly || clips.length === 0 ? null : { clips, drop: clipDropAt(p.x, p.y) };
    };
    const unregister = registerAssetDropTarget(treeRef.current, {
      accepts: (assets) => !live.current.readOnly && audioPaths(assets).length > 0,
      label: (assets, p) => {
        const d = dropFor(assets, p);
        return d?.drop ? describeDrop(live.current.root, d.drop, d.clips.length, "clips") : null;
      },
      over: (assets, p) => {
        const d = dropFor(assets, p);
        if (d) live.current.setClipDrag({ count: d.clips.length, drop: d.drop });
      },
      leave: () => live.current.setClipDrag(null),
      drop: (assets, p) => {
        const d = dropFor(assets, p);
        live.current.setClipDrag(null);
        if (d?.drop) live.current.edit(applyClipDrop(live.current.root, d.drop, d.clips), d.clips.length === 1 ? "Add clip" : "Add clips");
      },
    });
    return unregister;
  }, []);

  const drop = nodeDrag?.drop ?? clipDrag?.drop ?? null;
  const listSelected = sel && isListNode(sel) ? sel : null;
  return (
    <section class="ev-tree-pane" aria-label="Containers">
      <div class="ev-section-head">
        <span>Containers</span>
      </div>
      <div class="ev-toolbar" role="toolbar" aria-label="Tree actions">
        <select aria-label="Add node" data-testid="event-add-node" value="" disabled={readOnly} onChange={(e) => {
          const t = (e.currentTarget as HTMLSelectElement).value as NodeType;
          (e.currentTarget as HTMLSelectElement).value = "";
          if (t) add(t);
        }}>
          <option value="">+ Add…</option>
          {NODE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <select aria-label="Wrap in" value="" disabled={readOnly || !sel} onChange={(e) => {
          const t = (e.currentTarget as HTMLSelectElement).value as ListNodeType | "sustain";
          (e.currentTarget as HTMLSelectElement).value = "";
          if (t && selected) {
            try {
              edit(wrapNode(root, selected, t), `Wrap in ${t}`);
            } catch {
              props.onProblem("The event can't nest any deeper there");
            }
          }
        }}>
          <option value="">Wrap in…</option>
          {[...LIST_NODE_TYPES, "sustain" as const].map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        {listSelected && (
          <select aria-label="Change type" value={listSelected.type} disabled={readOnly} onChange={(e) => {
            const t = (e.currentTarget as HTMLSelectElement).value as ListNodeType;
            props.onEdit(changeListType(root, selected!, t), selected, `Change to ${t}`);
          }}>
            {LIST_NODE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        )}
        <button class="icon" aria-label="Move up" title="Move up (Alt+↑)" disabled={readOnly || typeof step !== "number" || step === 0 || siblings === 0} onClick={() => move(-1)}>↑</button>
        <button class="icon" aria-label="Move down" title="Move down (Alt+↓)" disabled={readOnly || typeof step !== "number" || step >= siblings - 1} onClick={() => move(1)}>↓</button>
        <button class="icon" aria-label="Duplicate" title="Duplicate (Ctrl+D)" disabled={readOnly || !selected || !canDuplicate(root, selected)} onClick={() => selected && edit(duplicateNode(root, selected), "Duplicate node")}>⧉</button>
        <button class="icon ev-danger" aria-label="Delete" title="Delete (Del)" disabled={readOnly || !selected || !canRemove(root, selected)} onClick={remove}>×</button>
      </div>
      <div
        ref={treeRef}
        class={`ev-tree${clipDrag ? " ev-drop-ready" : ""}`}
        role="tree"
        aria-label="Event tree"
        data-testid="event-tree"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div
          class={`ev-row ev-row-event${selected === null ? " selected" : ""}`}
          role="treeitem"
          aria-selected={selected === null}
          data-testid="event-tree-event"
          onPointerDown={(e) => e.button === 0 && props.onSelect(null)}
        >
          <span class="ev-badge">event</span>
          <span class="ev-row-label">Event</span>
        </div>
        {rows.map((row) => {
          const ind = indicator(row, drop, root);
          if (row.kind === "slot") {
            return (
              <div
                key={`${pathKey(row.sustain)}#${row.slot}`}
                class={`ev-row ev-row-slot${ind}`}
                role="treeitem"
                aria-selected={false}
                data-event-row="slot"
                data-event-path={pathKey(row.sustain)}
                data-slot={row.slot}
                style={{ paddingLeft: `${8 + row.depth * 14}px` }}
              >
                <span class="ev-slot-name">{row.slot}</span>
                <span class="ev-row-hint">empty: drop a clip or a node here</span>
              </div>
            );
          }
          const key = pathKey(row.path);
          const isSel = selected !== null && samePath(row.path, selected);
          const count = isListNode(row.node) ? row.node.children.length : null;
          const dragged = nodeDrag && samePath(nodeDrag.from, row.path);
          return (
            <div
              key={key}
              class={`ev-row${isSel ? " selected" : ""}${dragged ? " dragged" : ""}${ind}`}
              role="treeitem"
              aria-selected={isSel}
              aria-level={row.depth + 1}
              data-testid="event-tree-row"
              data-event-row="node"
              data-event-path={key}
              data-node-type={row.node.type}
              title={row.node.type === "clip" ? row.node.clip || "No clip chosen" : undefined}
              style={{ paddingLeft: `${8 + row.depth * 14}px` }}
              onPointerDown={(e) => onRowPointerDown(e, row.path)}
            >
              {row.slot && <span class="ev-slot-name">{row.slot}</span>}
              <span class={`ev-badge ev-badge-${row.node.type}`}>{row.node.type}</span>
              <span class={`ev-row-label${row.node.type === "clip" && !row.node.clip ? " missing" : ""}`}>{nodeLabel(row.node)}</span>
              {count !== null && <span class="ev-row-hint">{count === 0 ? "empty" : count}</span>}
            </div>
          );
        })}
        {nodePaths(root).length === 1 && isListNode(root) && root.children.length === 0 && (
          <p class="ev-empty">Drag clips here from the Assets panel, or use + Add.</p>
        )}
      </div>
      {nodeDrag && (
        <div class="ev-drop-hint" role="status" data-testid="event-drop-hint">
          {describeDrop(root, nodeDrag.drop, 1, "node")}
        </div>
      )}
    </section>
  );
}

/** The music half of the tree pane (see `MusicEdit`): what the panel gives `EventTree` for an event with a `musicRoot`. */
export interface MusicTreeProps {
  root: MusicNode;
  /** An edit: the new music root, the path to select (null: the event row) and the undo step's name. */
  onEdit(root: MusicNode, select: NodePath | null, label: string): void;
  /** Double-click on a segment: open it in the segment view. */
  onOpenSegment?(id: string): void;
  /** Double-click on a container: open its rules table. */
  onOpenRules?(id: string): void;
}

const MUSIC_ADD_LABEL: Record<MusicAddKind, string> = { segment: "Segment", playlist: "Playlist", musicSwitch: "Music switch", library: "Library segment" };
const MUSIC_ADD_KINDS = ["segment", "playlist", "musicSwitch", "library"] as const;

/** The tree of a music event: segments, playlists and music switches, each container's library after its children. No drag: move with the arrows. */
function MusicTree(props: EventTreeProps & { music: MusicTreeProps }) {
  const { selected, readOnly, music } = props;
  const root = music.root;
  const rows = musicNodePaths(root);
  const sel = selected ? getMusicNode(root, selected) : undefined;
  const edit = (e: MusicEdit | string, label: string) => (typeof e === "string" ? props.onProblem(e) : music.onEdit(e.root, e.path, label));
  const remove = () => {
    if (!selected || !canRemoveMusic(root, selected)) return;
    music.onEdit(removeMusicNode(root, selected), selected.slice(0, -1), "Delete node");
  };
  const move = (by: number) => {
    if (selected && selected.length > 0) edit(reorderMusicNode(root, selected, by), "Reorder node");
  };
  const duplicate = () => selected && canDuplicateMusic(root, selected) && edit(duplicateMusicNode(root, selected), "Duplicate node");
  const open = (node: MusicNode) => (isMusicContainer(node) ? music.onOpenRules?.(node.id) : music.onOpenSegment?.(node.id));

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, select, textarea")) return;
    const at = selected ? rows.findIndex((r) => samePath(r.path, selected)) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (e.altKey && !readOnly) return move(e.key === "ArrowDown" ? 1 : -1);
      const next = at + (e.key === "ArrowDown" ? 1 : -1);
      if (next < 0) props.onSelect(null);
      else if (next < rows.length) props.onSelect(rows[next].path);
    } else if ((e.key === "Delete" || e.key === "Backspace") && !readOnly) {
      e.preventDefault();
      remove();
    } else if (e.key === "d" && (e.ctrlKey || e.metaKey) && !readOnly) {
      e.preventDefault();
      duplicate();
    } else if (e.key === "Enter" && sel) {
      e.preventDefault();
      open(sel);
    }
  };

  const step = selected?.[selected.length - 1];
  const parentNode = selected && selected.length > 0 ? getMusicNode(root, selected.slice(0, -1)) : undefined;
  const siblings = parentNode && isMusicContainer(parentNode) ? (isLibraryPath(selected!) ? parentNode.library.length : parentNode.children.length) : 0;
  const index = step === undefined ? -1 : typeof step === "number" ? step : Number(step.slice(3));
  return (
    <section class="ev-tree-pane" aria-label="Music" data-testid="event-music-tree">
      <div class="ev-section-head">
        <span>Music</span>
      </div>
      <div class="ev-toolbar" role="toolbar" aria-label="Tree actions">
        <select aria-label="Add node" data-testid="event-add-node" value="" disabled={readOnly} onChange={(e) => {
          const k = (e.currentTarget as HTMLSelectElement).value as MusicAddKind;
          (e.currentTarget as HTMLSelectElement).value = "";
          if (k) edit(addMusicNode(root, selected, k), `Add ${MUSIC_ADD_LABEL[k].toLowerCase()}`);
        }}>
          <option value="">+ Add…</option>
          {MUSIC_ADD_KINDS.map((k) => <option key={k} value={k}>{MUSIC_ADD_LABEL[k]}</option>)}
        </select>
        <button class="icon" aria-label="Move up" title="Move up (Alt+↑)" disabled={readOnly || index <= 0 || siblings === 0} onClick={() => move(-1)}>↑</button>
        <button class="icon" aria-label="Move down" title="Move down (Alt+↓)" disabled={readOnly || index < 0 || index >= siblings - 1} onClick={() => move(1)}>↓</button>
        <button class="icon" aria-label="Duplicate" title="Duplicate (Ctrl+D)" disabled={readOnly || !selected || !canDuplicateMusic(root, selected)} onClick={duplicate}>⧉</button>
        <button class="icon ev-danger" aria-label="Delete" title="Delete (Del)" disabled={readOnly || !selected || !canRemoveMusic(root, selected)} onClick={remove}>×</button>
      </div>
      <div class="ev-tree" role="tree" aria-label="Event tree" data-testid="event-tree" tabIndex={0} onKeyDown={onKeyDown}>
        <div
          class={`ev-row ev-row-event${selected === null ? " selected" : ""}`}
          role="treeitem"
          aria-selected={selected === null}
          data-testid="event-tree-event"
          onPointerDown={(e) => e.button === 0 && props.onSelect(null)}
        >
          <span class="ev-badge">event</span>
          <span class="ev-row-label">Event</span>
        </div>
        {rows.map(({ path, node }) => {
          const key = pathKey(path);
          const isSel = selected !== null && samePath(path, selected);
          return (
            <div
              key={key}
              class={`ev-row${isSel ? " selected" : ""}`}
              role="treeitem"
              aria-selected={isSel}
              aria-level={path.length + 1}
              data-testid="event-tree-row"
              data-event-row="node"
              data-event-path={key}
              data-node-type={node.type}
              data-node-id={node.id}
              title={isMusicContainer(node) ? "Double-click to open the rules table" : "Double-click to open the segment view"}
              style={{ paddingLeft: `${8 + path.length * 14}px` }}
              onPointerDown={(e) => e.button === 0 && props.onSelect(path)}
              onDblClick={() => open(node)}
            >
              {isLibraryPath(path) && <span class="ev-slot-name">library</span>}
              <span class={`ev-badge ev-badge-${node.type}`}>{node.type}</span>
              <span class="ev-row-label">{musicNodeLabel(node)}</span>
              {isMusicContainer(node) && <span class="ev-row-hint">{node.children.length === 0 ? "empty" : node.children.length}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The tree pane: the 0158 container tree, or the music tree when `music` is given (the event has a `musicRoot`). */
export function EventTree(props: EventTreeProps) {
  return props.music ? <MusicTree {...props} music={props.music} /> : <ClassicEventTree {...props} />;
}

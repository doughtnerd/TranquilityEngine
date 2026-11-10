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
    } else if (isSlot(part)) out.push(part);
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
  };
}

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

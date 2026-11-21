// The Event editor's pure tree operations (ADR 0158 §1, §7): addressing a node of an audio event's container tree by
// path, and every structural edit the tree pane makes (add, remove, reorder, move, duplicate, wrap). Renaming a
// parameter where the event names it is `engine/audio/eventReferences.ts`'s (ADR 0299). Every function returns new values and never mutates its inputs: untouched
// subtrees are shared, changed ones are copied along the path. Every edit returns the refused-or-next `EditResult` (ADR
// 0307, 0313), which the panel applies as one undoable edit or a refusal in the status bar.
import {
  MAX_EVENT_DEPTH,
  MAX_EVENT_NODES,
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
import {
  isLibraryStep, libraryIndexOf, mapMusicTree, musicEntries, musicNodeAt, musicNodeCount, replaceMusicNodeAt, type MusicLibraryStep,
} from "../../../../engine/audio/musicTree";
import { accept, refuse, type EditResult } from "../editResult";

/** A `sustain` node's three slots, in play order. `loop` is required; `start` and `end` are optional. */
export const SUSTAIN_SLOTS = ["start", "loop", "end"] as const;
export type SustainSlot = (typeof SUSTAIN_SLOTS)[number];

/**
 * One step down the tree: an index into a list container's `children` (`random`, `sequence`, `switch`, `blend`,
 * `layer`), or a slot name of a `sustain` node.
 */
export type PathStep = number | SustainSlot | LibraryStep;

/** A music container's `library` segment `n` (`"lib0"`), addressed as the music tree module addresses it (ADR 0269). */
export type LibraryStep = MusicLibraryStep;

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
    } else if (isSlot(part) || isLibraryStep(part)) out.push(part as PathStep);
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
// Every structural edit returns the refused-or-next `EditResult` (ADR 0307, 0313): the toolbar's "disabled" checks ask
// the edit itself (`refusalOf(removeNode(root, path)) !== null`), and the panel applies it with `applyEdit`, so a refused
// Delete or drop says why in the status bar.

/**
 * A new root with the node at `path` replaced by `node` (ancestors copied, everything else shared). `path` `[]`
 * replaces the root. The addressing step under the edits, not an edit a user can get refused: it throws `RangeError`
 * when `path` doesn't lead to a node, which only a caller that didn't read the node first can cause.
 */
export function setNode(root: EventNode, path: NodePath, node: EventNode): EventNode {
  if (getNode(root, path) === undefined) throw new RangeError(`no node at "${pathKey(path)}"`);
  return replaceAt(root, path, 0, node);
}

const DEEPER = "the event can't nest any deeper there";
const noNodeAt = (path: NodePath) => `no node at "${pathKey(path)}"`;
const tooMany = () => `the event can't hold more than ${MAX_EVENT_NODES} nodes`;

/**
 * Insert `node` (as given, not copied) into the children of the list container at `parent`, at `index` (default: the
 * end; clamped to 0..children.length). Returns the new root and the new node's path. Refused when the parent isn't a
 * list container, when a node would sit at depth `MAX_EVENT_DEPTH` or deeper (a node's depth is its path's length, the
 * root's 0, so the rule is `parent.length + subtreeHeight(node) < MAX_EVENT_DEPTH`; the parser drops deeper nodes), or
 * when the tree would hold more than `MAX_EVENT_NODES` nodes.
 */
export function addChild(root: EventNode, parent: NodePath, node: EventNode, index?: number): EditResult<TreeEdit> {
  const target = getNode(root, parent);
  if (!target) return refuse(noNodeAt(parent));
  if (!isListNode(target)) return refuse("only a random, sequence, switch, blend or layer holds a list of nodes");
  if (parent.length + subtreeHeight(node) >= MAX_EVENT_DEPTH) return refuse(DEEPER);
  if (countNodes(root) + countNodes(node) > MAX_EVENT_NODES) return refuse(tooMany());
  const children = target.children;
  const at = index === undefined || !Number.isFinite(index)
    ? children.length
    : Math.max(0, Math.min(children.length, Math.trunc(index)));
  const next = [...children.slice(0, at), node, ...children.slice(at)];
  return accept({ root: setNode(root, parent, withFields(target, { children: next })), path: [...parent, at] });
}

/**
 * Fill or clear a slot of the sustain node at `sustain`: `node` undefined clears `start` or `end` (the key is removed,
 * not set to undefined). Replaces whatever the slot held. Returns the new root and the slot's path (the sustain's for a
 * cleared slot). Refused when `sustain` isn't a sustain node, when clearing `loop` (it is required), or when the depth or
 * node limits of `addChild` would be passed.
 */
export function setSustainSlot(root: EventNode, sustain: NodePath, slot: SustainSlot, node: EventNode | undefined): EditResult<TreeEdit> {
  const target = getNode(root, sustain);
  if (!target || target.type !== "sustain") return refuse("only a sustain node has start, loop and end slots");
  if (slot === "loop" && node === undefined) return refuse("a sustain node's loop slot is required");
  if (node !== undefined) {
    if (sustain.length + subtreeHeight(node) >= MAX_EVENT_DEPTH) return refuse(DEEPER);
    const replaced = target[slot];
    const count = countNodes(root) - (replaced ? countNodes(replaced) : 0) + countNodes(node);
    if (count > MAX_EVENT_NODES) return refuse(tooMany());
  }
  const next: Record<string, unknown> = { ...target };
  if (node === undefined) delete next[slot];
  else next[slot] = node;
  return accept({
    root: setNode(root, sustain, next as unknown as EventNode),
    // A cleared slot has no node to select, so the edit selects the sustain that lost it.
    path: node === undefined ? [...sustain] : [...sustain, slot],
  });
}

/** Why the node at `path` can't leave its place (removed or moved), or null: it exists, isn't the root, isn't a `loop`. */
function leaveRefusal(root: EventNode, path: NodePath): string | null {
  if (path.length === 0) return "the event's root node stays (wrap it or change its type instead)";
  if (getNode(root, path) === undefined) return noNodeAt(path);
  return path[path.length - 1] === "loop" ? "a sustain node's loop slot is required" : null;
}

/**
 * A new root without the node at `path` (and its subtree): spliced out of a list, or a sustain `start`/`end` slot's key
 * removed; the edit selects the parent. Refused for the root, a sustain node's `loop` and a path that leads nowhere.
 */
export function removeNode(root: EventNode, path: NodePath): EditResult<TreeEdit> {
  const refusal = leaveRefusal(root, path);
  if (refusal) return refuse(refusal);
  const parentP = parentPath(path) as NodePath;
  const parent = getNode(root, parentP) as EventNode;
  const step = path[path.length - 1];
  if (typeof step === "number") {
    const children = (parent as ListContainer).children.filter((_, i) => i !== step);
    return accept({ root: setNode(root, parentP, withFields(parent, { children })), path: parentP });
  }
  const next: Record<string, unknown> = { ...parent };
  delete next[step];
  return accept({ root: setNode(root, parentP, next as unknown as EventNode), path: parentP });
}

/**
 * Move the child at `from` to position `to` among the same list container's children (both indices of the list as it
 * is now, `to` clamped to 0..n-1; the moved child ends up at index `to`). Returns the new root and the child's new path;
 * `from === to` returns the root unchanged (the same object). Refused when `parent` isn't a list container or `from` is
 * out of range.
 */
export function reorderChild(root: EventNode, parent: NodePath, from: number, to: number): EditResult<TreeEdit> {
  const list = getNode(root, parent);
  if (!list || !isListNode(list)) return refuse("only a node in a list container can move up or down");
  const n = list.children.length;
  if (!Number.isInteger(from) || from < 0 || from >= n) return refuse(`no child ${from} there`);
  if (!Number.isFinite(to)) return refuse(`no place ${to} there`);
  const at = Math.max(0, Math.min(n - 1, Math.trunc(to)));
  if (at === from) return accept({ root, path: [...parent, from] });
  const children = list.children.slice();
  const [moved] = children.splice(from, 1);
  children.splice(at, 0, moved);
  return accept({ root: setNode(root, parent, withFields(list, { children })), path: [...parent, at] });
}

/**
 * Move the subtree at `from` to `to` in one edit. A list target's `index` is a position in the target's children as
 * they are before the move (where the drop indicator was drawn); when the node leaves the same list from an earlier
 * index, the insertion index is one less, so the node lands where the indicator was. Paths in `to.parent` are of the
 * tree before the move, too: the function adjusts for the removal. Returns the new root and the node's new path.
 * Refused when the node can't leave its place (`removeNode`'s rules), `to.parent` leads nowhere or is the node or
 * inside it, the depth limit of `addChild` would be passed at the new place, a slot target isn't an empty slot of a
 * sustain node (a `loop` slot is never empty), or a list target isn't a list container with `index` in
 * 0..children.length.
 */
export function moveNode(root: EventNode, from: NodePath, to: DropTarget): EditResult<TreeEdit> {
  const leave = leaveRefusal(root, from);
  if (leave) return refuse(leave);
  const node = getNode(root, from) as EventNode;
  const target = getNode(root, to.parent);
  if (!target) return refuse(noNodeAt(to.parent));
  if (samePath(to.parent, from) || isAncestor(from, to.parent)) return refuse("a node can't move into itself");
  if (to.parent.length + subtreeHeight(node) >= MAX_EVENT_DEPTH) return refuse(DEEPER);
  if ("slot" in to) {
    if (target.type !== "sustain") return refuse("only a sustain node has start, loop and end slots");
    if (target[to.slot] !== undefined) return refuse("that slot is taken");
  } else {
    if (!isListNode(target)) return refuse("only a random, sequence, switch, blend or layer holds a list of nodes");
    if (!Number.isInteger(to.index) || to.index < 0 || to.index > target.children.length) return refuse(`no place ${to.index + 1} there`);
  }
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

  const removed = removeNode(root, from);
  if ("refused" in removed) return removed;
  const without = removed.next.root;
  if ("slot" in to) return setSustainSlot(without, parent, to.slot, node);
  let index = to.index;
  if (typeof fromStep === "number" && samePath(to.parent, fromParent) && index > fromStep) index -= 1;
  return addChild(without, parent, node, index);
}

/**
 * Insert a deep copy (`cloneNode`) of the node at `path` right after it in its list. Returns the new root and the
 * copy's path. Refused for the root, a node in a sustain slot (a slot holds one node), and when the copy would pass the
 * node limit.
 */
export function duplicateNode(root: EventNode, path: NodePath): EditResult<TreeEdit> {
  const node = getNode(root, path);
  if (!node) return refuse(noNodeAt(path));
  if (path.length === 0) return refuse("the event's root node can't be duplicated");
  if (typeof path[path.length - 1] !== "number") return refuse("a sustain slot holds one node, so its node can't be duplicated");
  const parent = parentPath(path) as NodePath;
  const index = path[path.length - 1] as number;
  return addChild(root, parent, cloneNode(node), index + 1);
}

/**
 * Replace the node at `path` with a fresh container of `type` (`newNode(type)`) holding it: as its only child for a list
 * type, in its `loop` slot for `"sustain"`. The wrapped node moves in unchanged and the wrapper takes over none of its
 * fields. Returns the new root and the wrapper's path (equal to `path`), or refused when the path leads nowhere, the
 * depth limit would be passed (`path.length + 1 + subtreeHeight(node) > MAX_EVENT_DEPTH`) or the node limit would.
 */
export function wrapNode(root: EventNode, path: NodePath, type: ListNodeType | "sustain"): EditResult<TreeEdit> {
  const node = getNode(root, path);
  if (!node) return refuse(`no node at "${pathKey(path)}"`);
  if (path.length + 1 + subtreeHeight(node) > MAX_EVENT_DEPTH) return refuse("the event can't nest any deeper there");
  if (countNodes(root) + 1 > MAX_EVENT_NODES) return refuse(`the event can't hold more than ${MAX_EVENT_NODES} nodes`);
  const fresh = newNode(type);
  const wrapper = type === "sustain"
    ? withFields(fresh, { loop: node })
    : withFields(fresh, { children: [node] });
  return accept({ root: setNode(root, path, wrapper), path: [...path] });
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

/** `node` with `fields` set, as a shallow copy of the same type. */
const withMusic = <T extends MusicNode>(node: T, fields: Partial<T>): T => ({ ...node, ...fields });

/** The library segments in the whole event (the limit is per event). */
const libraryCount = (root: MusicNode): number => musicEntries(root).reduce((n, e) => n + (isMusicContainer(e.node) ? e.node.library.length : 0), 0);

/** Every id in the tree, in walk order (library segments included). */
export const musicIds = (root: MusicNode): string[] => musicEntries(root).map((e) => e.node.id);

/** The text for an id the format refuses, or `null` when `id` is fine for the node at `path` (its own id doesn't clash with itself). */
export function musicIdProblem(root: MusicNode, path: NodePath, id: string): string | null {
  if (!MUSIC_ID_PATTERN.test(id)) return "An id is 1 to 48 letters, digits, - or _.";
  if (musicEntries(root).some((e) => e.node.id === id && !samePath(e.path, path))) return `The id "${id}" is already used in this event.`;
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
  const node = musicNodeAt(root, path);
  if (!node || node.id === id) return root;
  const map = new Map([[node.id, id]]);
  return mapMusicTree(replaceMusicNodeAt(root, path, withMusic(node, { id })), (n) => remapReferences(n, map));
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
  const node = musicNodeAt(root, path);
  if (!node) return null;
  const upper = path.length > 0 ? path.slice(0, -1) : null;
  const step = path[path.length - 1];
  const host: NodePath | null = isMusicContainer(node) ? path : upper;
  const hostNode = host ? musicNodeAt(root, host) : undefined;
  if (!host || !hostNode || !isMusicContainer(hostNode)) return null;
  if (library) return { parent: host, index: hostNode.library.length };
  if (host === path || typeof step !== "number") return { parent: host, index: hostNode.children.length };
  return { parent: host, index: step + 1 };
}

/** Add a fresh node (or `library` segment) where `musicAddTarget` says; the new node's id is based on its type. Or refused, with why. */
export function addMusicNode(root: MusicNode, selected: NodePath | null, kind: MusicAddKind): EditResult<MusicEdit> {
  const at = musicAddTarget(root, selected, kind === "library");
  if (!at) return refuse("select a playlist or music switch, or a node in one, to add to it");
  const container = musicNodeAt(root, at.parent) as PlaylistNode | MusicSwitchNode;
  const type: MusicNodeType = kind === "library" ? "segment" : kind;
  const id = freshMusicId(new Set(musicIds(root)), kind === "library" ? "library" : type === "musicSwitch" ? "switch" : type);
  const node = newMusicNode(type, id);
  if (musicNodeCount(root) + 1 > MAX_EVENT_NODES) return refuse("the event can't hold more nodes");
  if (at.parent.length + 1 >= MAX_EVENT_DEPTH) return refuse("the event can't hold more nodes there");
  if (kind === "library") {
    if (libraryCount(root) >= MUSIC_LIMITS.library) return refuse(`an event holds at most ${MUSIC_LIMITS.library} library segments`);
    return accept({ root: replaceMusicNodeAt(root, at.parent, withMusic(container, { library: [...container.library, node as SegmentNode] })), path: [...at.parent, `lib${container.library.length}`] });
  }
  if (container.children.length >= MUSIC_LIMITS.playlistChildren) return refuse(`a container holds at most ${MUSIC_LIMITS.playlistChildren} children`);
  const children = [...container.children.slice(0, at.index), node, ...container.children.slice(at.index)];
  return accept({ root: replaceMusicNodeAt(root, at.parent, withMusic(container, { children })), path: [...at.parent, at.index] });
}

/**
 * A new root without the node at `path` (and its subtree); the edit selects the parent. The rules naming a removed child,
 * the bridges naming a removed library segment and the stingers playing one go with it, so nothing dangles (the parser
 * would drop them with a problem). Refused for the root (an event keeps its music tree) and a path that leads nowhere.
 */
export function removeMusicNode(root: MusicNode, path: NodePath): EditResult<MusicEdit> {
  if (path.length === 0) return refuse("the music root stays (an event keeps its music tree)");
  if (musicNodeAt(root, path) === undefined) return refuse(noNodeAt(path));
  const gone = new Set(musicIds(musicNodeAt(root, path)!));
  const parentP = path.slice(0, -1);
  const parent = musicNodeAt(root, parentP) as PlaylistNode | MusicSwitchNode;
  const step = path[path.length - 1];
  const n = libraryIndexOf(step);
  const next = n === null
    ? withMusic(parent, { children: parent.children.filter((_, i) => i !== step) })
    : withMusic(parent, { library: parent.library.filter((_, i) => i !== n) });
  const cleaned = mapMusicTree(replaceMusicNodeAt(root, parentP, next), (node) => {
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
  return accept({ root: cleaned, path: parentP });
}

/**
 * Move the child or library segment at `path` by `by` places among its siblings (clamped; at the end, the root unchanged).
 * The node keeps its id; rules name ids, so none change. Refused for the root, which has no siblings.
 */
export function reorderMusicNode(root: MusicNode, path: NodePath, by: number): EditResult<MusicEdit> {
  const parentP = path.slice(0, -1);
  const parent = musicNodeAt(root, parentP);
  if (path.length === 0 || !parent || !isMusicContainer(parent) || musicNodeAt(root, path) === undefined) return refuse("only a node in a playlist or music switch can move up or down");
  const step = path[path.length - 1];
  const lib = libraryIndexOf(step);
  const list: MusicNode[] = lib === null ? parent.children : parent.library;
  const from = lib === null ? (step as number) : lib;
  const to = Math.max(0, Math.min(list.length - 1, from + by));
  if (to === from) return accept({ root, path });
  const moved = list.slice();
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);
  const next = lib === null ? withMusic(parent, { children: moved }) : withMusic(parent, { library: moved as SegmentNode[] });
  return accept({ root: replaceMusicNodeAt(root, parentP, next), path: [...parentP, lib === null ? to : (`lib${to}` as const)] });
}

/**
 * Insert a deep copy of the node at `path` right after it, every id in the copy made fresh (`id-2`…) and the copy's own
 * rules, bridges and stingers following its renamed children. Refused for the root, and when the copy would pass the
 * node, library or children limits.
 */
export function duplicateMusicNode(root: MusicNode, path: NodePath): EditResult<MusicEdit> {
  const original = musicNodeAt(root, path);
  if (!original) return refuse(noNodeAt(path));
  if (path.length === 0) return refuse("the music root can't be duplicated");
  const container = musicNodeAt(root, path.slice(0, -1));
  if (!container || !isMusicContainer(container)) return refuse(noNodeAt(path.slice(0, -1)));
  if (musicNodeCount(root) + musicNodeCount(original) > MAX_EVENT_NODES) return refuse(tooMany());
  if (libraryIndexOf(path[path.length - 1]) !== null) {
    if (libraryCount(root) >= MUSIC_LIMITS.library) return refuse(`an event holds at most ${MUSIC_LIMITS.library} library segments`);
  } else if (container.children.length >= MUSIC_LIMITS.playlistChildren) return refuse(`a container holds at most ${MUSIC_LIMITS.playlistChildren} children`);
  const taken = new Set(musicIds(root));
  const map = new Map<string, string>();
  const fresh = (n: MusicNode): MusicNode => {
    const id = freshMusicId(taken, n.id);
    taken.add(id);
    map.set(n.id, id);
    return { ...deepCopy(n), id } as MusicNode;
  };
  const copy = mapMusicTree(original, fresh);
  const renamed = mapMusicTree(copy, (n) => remapReferences(n, map));
  const parentP = path.slice(0, -1);
  const parent = musicNodeAt(root, parentP) as PlaylistNode | MusicSwitchNode;
  const step = path[path.length - 1];
  const lib = libraryIndexOf(step);
  if (lib !== null) {
    const library = [...parent.library.slice(0, lib + 1), renamed as SegmentNode, ...parent.library.slice(lib + 1)];
    return accept({ root: replaceMusicNodeAt(root, parentP, withMusic(parent, { library })), path: [...parentP, `lib${lib + 1}`] });
  }
  const at = (step as number) + 1;
  // A music switch's children are keyed by `value`, and a copy with the same value would lose to the original: the copy starts unset.
  const unkeyed = parent.type === "musicSwitch" && renamed.value !== undefined ? (({ value: _value, ...rest }) => rest as MusicNode)(renamed) : renamed;
  const children = [...parent.children.slice(0, at), unkeyed, ...parent.children.slice(at)];
  return accept({ root: replaceMusicNodeAt(root, parentP, withMusic(parent, { children })), path: [...parentP, at] });
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

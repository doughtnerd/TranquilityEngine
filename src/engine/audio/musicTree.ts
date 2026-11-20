// The music tree's addressing (ADR 0269): the one descent over a music node's `children` and `library`, under both
// addresses a node has, its id (unique in an event, library segments included) and its path from the root (`[]` the
// root, `[1]` the root's second child, `[1, "lib0"]` that child's first library segment). Find, replace with structural
// sharing, walk and list leaves go through here; editors and the runtime keep no descent of their own.
import { isMusicContainer, type MusicContainerNode, type MusicNode, type SegmentNode } from "./musicFormat";

/** A container's `library` segment `n` (`"lib0"`): the step to it from the container, beside its numeric `children` steps. */
export type MusicLibraryStep = `lib${number}`;

/** One step down a music tree: an index into a container's `children`, or a `library` segment. */
export type MusicStep = number | MusicLibraryStep;

/** A music node's address from the tree's root. */
export type MusicPath = readonly MusicStep[];

const LIBRARY_STEP = /^lib(0|[1-9][0-9]*)$/;

/** True when `step` is a library step (`"lib0"`, `"lib12"`; not `"lib01"`). */
export const isLibraryStep = (step: unknown): step is MusicLibraryStep => typeof step === "string" && LIBRARY_STEP.test(step);

/** The library index a step names, or null when it is not a library step. */
export const libraryIndexOf = (step: unknown): number | null => (isLibraryStep(step) ? Number(step.slice(3)) : null);

/** The step to `library[n]`. */
export const libraryStep = (n: number): MusicLibraryStep => `lib${n}`;

/** Whether the node at `path` is one of its container's `library` segments. */
export const isLibraryPath = (path: readonly unknown[]): boolean => path.length > 0 && libraryIndexOf(path[path.length - 1]) !== null;

// --- one level ------------------------------------------------------------------------------------------------------

/** A node's music children: a container's `children`, none for a segment (library segments are not children). */
export const musicChildrenOf = (node: MusicNode): readonly MusicNode[] => (isMusicContainer(node) ? node.children : []);

/** The child of `node` with this id (direct children only), or undefined. */
export const musicChildById = (node: MusicNode, id: string): MusicNode | undefined => musicChildrenOf(node).find((c) => c.id === id);

/** The steps from a node to its children, then its library segments. */
export function musicStepsOf(node: MusicNode): MusicStep[] {
  if (!isMusicContainer(node)) return [];
  return [...node.children.map((_, i): MusicStep => i), ...node.library.map((_, i) => libraryStep(i))];
}

/** The node one `step` below `node`, or undefined. */
export function musicChildAt(node: MusicNode, step: unknown): MusicNode | undefined {
  if (!isMusicContainer(node)) return undefined;
  if (typeof step === "number") return node.children[step];
  const i = libraryIndexOf(step);
  return i === null ? undefined : node.library[i];
}

// --- walking --------------------------------------------------------------------------------------------------------

/** What a walk takes in: `library: false` leaves the library segments out (only what a container can play in turn). */
export interface MusicWalkOptions {
  readonly library?: boolean;
}

/**
 * Every node under `root` (itself first) with its path, depth first: children, then the library segments. `visit`
 * returning `false` skips that node's subtree; returning `true` stops the walk.
 */
function walk(root: MusicNode, options: MusicWalkOptions, visit: (node: MusicNode, path: MusicPath) => boolean | void): void {
  const library = options.library !== false;
  const go = (node: MusicNode, path: MusicStep[]): boolean => {
    const r = visit(node, path);
    if (r === true) return true;
    if (r === false || !isMusicContainer(node)) return false;
    for (let i = 0; i < node.children.length; i++) if (go(node.children[i]!, [...path, i])) return true;
    if (library) for (let i = 0; i < node.library.length; i++) if (go(node.library[i]!, [...path, libraryStep(i)])) return true;
    return false;
  };
  go(root, []);
}

/** Every node of the tree with its path, depth first: children, then the library (as `eventNodes` walks them). */
export function musicEntries(root: MusicNode, options: MusicWalkOptions = {}): { path: MusicPath; node: MusicNode }[] {
  const out: { path: MusicPath; node: MusicNode }[] = [];
  walk(root, options, (node, path) => void out.push({ path, node }));
  return out;
}

/** Every segment under `node` (itself when it is one), in walk order. Default: children only, the segments a container plays in turn. */
export function musicLeaves(node: MusicNode, options: MusicWalkOptions = { library: false }): SegmentNode[] {
  const out: SegmentNode[] = [];
  walk(node, options, (n) => void (n.type === "segment" && out.push(n)));
  return out;
}

/** How many nodes the tree holds, library segments included. */
export const musicNodeCount = (root: MusicNode): number => musicEntries(root).length;

// --- finding --------------------------------------------------------------------------------------------------------

/** The node at `path` (`[]` is the root), or undefined. A step that is not a music step (a sustain slot of an event path) leads nowhere. */
export function musicNodeAt(root: MusicNode, path: readonly unknown[]): MusicNode | undefined {
  let node: MusicNode | undefined = root;
  for (const step of path) {
    if (!node) return undefined;
    node = musicChildAt(node, step);
  }
  return node;
}

/** The path of the node with `id` (children, then the library), or null. */
export function musicPathOf(root: MusicNode, id: string): MusicPath | null {
  let found: MusicPath | null = null;
  walk(root, {}, (node, path) => {
    if (node.id !== id) return undefined;
    found = path;
    return true;
  });
  return found;
}

/** The node with `id` anywhere under `root` (library included), or undefined. */
export function findMusicNode(root: MusicNode | undefined, id: string): MusicNode | undefined {
  if (!root) return undefined;
  const path = musicPathOf(root, id);
  return path ? musicNodeAt(root, path) : undefined;
}

/** The segment with `id` anywhere under `root` (library included), or null. */
export function findMusicSegment(root: MusicNode | undefined, id: string): SegmentNode | null {
  const node = findMusicNode(root, id);
  return node?.type === "segment" ? node : null;
}

/** The playlist or music switch with `id` anywhere under `root`, or null. */
export function findMusicContainer(root: MusicNode | undefined, id: string): MusicContainerNode | null {
  const node = findMusicNode(root, id);
  return node && isMusicContainer(node) ? node : null;
}

// --- replacing ------------------------------------------------------------------------------------------------------

/** `node` with `fields` set, as a shallow copy of the same type. */
const withFields = <T extends MusicNode>(node: T, fields: Partial<T>): T => ({ ...node, ...fields });

/**
 * A new root with the node at `path` replaced by `node`: the ancestors along the path are copied, everything else is
 * shared. A library step takes only a segment. Throws `RangeError` when `path` leads nowhere.
 */
export function replaceMusicNodeAt(root: MusicNode, path: readonly unknown[], node: MusicNode): MusicNode {
  if (musicNodeAt(root, path) === undefined) throw new RangeError(`no music node at "${path.join("/")}"`);
  const at = (current: MusicNode, i: number): MusicNode => {
    if (i === path.length) return node;
    const step = path[i];
    const container = current as MusicContainerNode;
    const child = at(musicChildAt(current, step)!, i + 1);
    if (typeof step === "number") return withFields(container, { children: container.children.map((c, j) => (j === step ? child : c)) });
    if (child.type !== "segment") throw new RangeError(`a library holds only segments ("${path.join("/")}")`);
    const n = libraryIndexOf(step)!;
    return withFields(container, { library: container.library.map((c, j) => (j === n ? child : c)) });
  };
  return at(root, 0);
}

/** `root` with the node `id` replaced by `next` (structure shared elsewhere); `root` itself when `id` is not there. */
export function replaceMusicNode(root: MusicNode, id: string, next: MusicNode): MusicNode {
  const path = musicPathOf(root, id);
  return path ? replaceMusicNodeAt(root, path, next) : root;
}

/** `fn` applied to every node of the tree (library included), bottom up; nodes `fn` leaves alone (same object) and their unchanged ancestors are shared. */
export function mapMusicTree(node: MusicNode, fn: (n: MusicNode) => MusicNode): MusicNode {
  if (!isMusicContainer(node)) return fn(node);
  const children = node.children.map((c) => mapMusicTree(c, fn));
  const library = node.library.map((c) => {
    const m = mapMusicTree(c, fn);
    if (m.type !== "segment") throw new RangeError("a library holds only segments");
    return m;
  });
  const same = children.every((c, i) => c === node.children[i]) && library.every((c, i) => c === node.library[i]);
  return fn(same ? node : withFields(node, { children, library }));
}

// Multi-selection rules (ADR 0022): combining a box or click with the current selection, the
// hierarchy's row order (for Shift ranges and the Alt+click list), and trimming a selection to
// its topmost nodes (so moving or deleting a parent and its child doesn't act on the child twice).
import { pathKey, type SceneDocument } from "./document";
import { instanceInnerNodes, type InnerNode } from "./prefabs";

/** How a box or click combines with the current selection: replace it, add to it (Shift), or toggle (Ctrl/Cmd). */
export type SelectMode = "replace" | "add" | "toggle";

/** The selection mode for a gesture's modifier keys. Ctrl/Cmd wins over Shift. */
export function selectModeFor(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectMode {
  return e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "add" : "replace";
}

/** `current` combined with `hits` under `mode`, keeping selection order (new keys go last). */
export function combineSelection(current: readonly string[], hits: readonly string[], mode: SelectMode): string[] {
  if (mode === "replace") return [...new Set(hits)];
  if (mode === "add") return [...new Set([...current, ...hits])];
  const toggled = new Set(hits);
  return [...current.filter((k) => !toggled.has(k)), ...[...toggled].filter((k) => !current.includes(k))];
}

/** One hierarchy row: a scene node or a node inside a prefab instance. */
export interface HierarchyEntry {
  readonly key: string;
  readonly name: string;
  readonly depth: number;
  /** Inside a prefab instance. */
  readonly inner: boolean;
}

/** Every hierarchy row in display order (parents before children), expanded or not. */
export function hierarchyEntries(doc: SceneDocument): HierarchyEntry[] {
  const out: HierarchyEntry[] = [];
  const visitInner = (n: InnerNode, depth: number): void => {
    out.push({ key: pathKey(n.path), name: n.name, depth, inner: true });
    for (const c of n.children) visitInner(c, depth + 1);
  };
  const visit = (id: string, depth: number): void => {
    const node = doc.node(id);
    out.push({ key: id, name: node.name ?? id, depth, inner: false });
    if (node.prefab) for (const n of instanceInnerNodes(doc, id)) visitInner(n, depth + 1);
    else for (const c of doc.children(id)) visit(c, depth + 1);
  };
  for (const id of doc.roots()) visit(id, 0);
  return out;
}

/** Keys of the hierarchy ancestors of `key`, nearest first. */
export function ancestorKeys(doc: SceneDocument, key: string): string[] {
  const path = key.split("/");
  const out: string[] = [];
  // Inside a prefab instance, a node's path doesn't name its plain-node parents, so walk the instance's tree.
  const chain = path.length > 1 && doc.has(path[0]) && doc.isPrefabInstance(path[0]) ? innerChain(instanceInnerNodes(doc, path[0]), key) : null;
  if (chain) out.push(...chain.reverse(), path[0]);
  else for (let i = path.length - 1; i > 0; i--) out.push(pathKey(path.slice(0, i)));
  if (!doc.has(path[0])) return out;
  for (let p = doc.parentOf(path[0]); p !== null; p = doc.parentOf(p)) out.push(p);
  return out;
}

/** Keys of the inner nodes from the top of `level` down to (not including) `key`, or null if it isn't there. */
function innerChain(level: readonly InnerNode[], key: string): string[] | null {
  for (const n of level) {
    const k = pathKey(n.path);
    if (k === key) return [];
    const below = innerChain(n.children, key);
    if (below) return [k, ...below];
  }
  return null;
}

/** `keys` without those that have an ancestor in `keys`, in their original order. */
export function topmostKeys(doc: SceneDocument, keys: readonly string[]): string[] {
  const set = new Set(keys);
  return keys.filter((k) => !ancestorKeys(doc, k).some((a) => set.has(a)));
}

/** `keys` plus every hierarchy descendant of them, in hierarchy order. */
export function withDescendants(doc: SceneDocument, keys: Iterable<string>): HierarchyEntry[] {
  const wanted = new Set(keys);
  const out: HierarchyEntry[] = [];
  let within = -1; // depth of the wanted row we're inside, or -1
  for (const e of hierarchyEntries(doc)) {
    if (within >= 0 && e.depth <= within) within = -1;
    if (within >= 0 || wanted.has(e.key)) {
      out.push(e);
      if (within < 0) within = e.depth;
    }
  }
  return out;
}

/** Keys from `anchor` to `to` inclusive in `order` (a Shift range); just `to` if the anchor isn't there. */
export function rangeBetween(order: readonly string[], anchor: string | null, to: string): string[] {
  const a = anchor === null ? -1 : order.indexOf(anchor), b = order.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

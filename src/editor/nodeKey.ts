// The editor's node keys (ADR 0453): how a selection, a Hierarchy row or a drop names a node of the open scene. A
// key is a document path joined with "/" (`pathKey`): `id` for a scene node, `instanceId/innerId…` for a node inside a
// prefab instance. This module is the one place that reads keys back: splitting them, telling inner ones apart, and
// asking whether the node a key names is still in the document (an inner node can go while its instance stays: an
// undo of an `addNodes` override, a prefab edited in another tab). The selection itself stays a list of keys in its
// own signal (ADR 0242).
//
// The nodes inside a prefab instance (`instanceInnerNodes`) are the tree an inner key is looked up in, so walking it
// lives here too: one walk (`innerTrail`) answers which node a key names, its inner ancestors and its parent row.
import type { ResolvedNode } from "../engine/scene/resolvedScene";
import { pathKey, type NodePath, type OverrideEntry, type SceneDocument } from "./document";

/** A node inside a prefab instance, from the prefab file (nested prefabs included) and the instance's overrides. */
export interface InnerNode {
  /**
   * Full document path: `[instanceId, innerId]`, with one more id per nested instance on the way
   * (`[instanceId, nestedId, innerId]`), the same shape as an override `target` after the instance id.
   */
  readonly path: NodePath;
  readonly name: string;
  /** The node's own active flag, with overrides (ADR 0122). */
  readonly active: boolean;
  /** Set when this inner node is itself an instance of another prefab. */
  readonly prefab?: string;
  /** True for a node the instance (or a nested instance in a prefab file) added with `addNodes` (ADR 0086). */
  readonly added?: boolean;
  readonly children: readonly InnerNode[];
}

/**
 * The inner nodes of instance `id` in the document, with `overrides` in place of its own: the
 * children of the node it stands for (a prefab's root, or a sub-scene's node), nested instances
 * expanded, names, active flags, added and removed nodes as the game makes them. They come from
 * the document's resolved view (ADR 0122, 0280).
 */
export function instanceInnerNodes(doc: SceneDocument, id: string, overrides: readonly OverrideEntry[] = doc.overrides(id)): InnerNode[] {
  if (!doc.node(id).prefab) return [];
  const { nodes } = doc.resolve(id, overrides);
  const top = nodes.find((n) => n.parent === undefined);
  if (!top) return [];
  const byParent = new Map<string, ResolvedNode[]>();
  for (const n of nodes) if (n.parent !== undefined) byParent.set(n.parent, [...(byParent.get(n.parent) ?? []), n]);
  const build = (n: ResolvedNode): InnerNode => ({
    path: n.path,
    name: n.name ?? n.path[n.path.length - 1],
    active: n.active,
    ...(n.prefab ? { prefab: n.prefab } : {}),
    ...(n.added ? { added: true } : {}),
    children: (byParent.get(n.id) ?? []).map(build),
  });
  return (byParent.get(top.id) ?? []).map(build);
}

/** The inner nodes from the top of `level` down to the one whose key is `key`, inclusive, or null if it isn't there. */
function trailIn(level: readonly InnerNode[], key: string): InnerNode[] | null {
  for (const n of level) {
    if (pathKey(n.path) === key) return [n];
    const below = trailIn(n.children, key);
    if (below) return [n, ...below];
  }
  return null;
}

/**
 * The inner nodes of the instance `path[0]` from its top level down to the node at `path` (length ≥ 2), inclusive:
 * the node is last, its inner ancestors before it. Null when `path[0]` isn't a prefab instance or the node isn't in it.
 */
function innerTrail(doc: SceneDocument, path: NodePath): InnerNode[] | null {
  const instance = doc.has(path[0]) ? doc.node(path[0]) : null;
  if (!instance?.prefab || path.length < 2) return null;
  return trailIn(instanceInnerNodes(doc, path[0]), pathKey(path));
}

/** The inner node at `path` (length ≥ 2), or null. */
export function findInner(doc: SceneDocument, path: NodePath): InnerNode | null {
  return innerTrail(doc, path)?.at(-1) ?? null;
}

/** The document path a key names. */
export const parseKey = (key: string): NodePath => key.split("/");

/** The scene node a key starts at: the node itself, or the prefab instance an inner key points into. */
export function rootOf(key: string): string {
  const slash = key.indexOf("/");
  return slash < 0 ? key : key.slice(0, slash);
}

/** True for a key that points inside a prefab instance (`pipe/top`). */
export const isInnerKey = (key: string): boolean => key.includes("/");

/** An inner node a key names: the node, its inner ancestors' keys (topmost first) and its parent row's key (its inner parent, or the instance). */
export interface InnerAt {
  readonly node: InnerNode;
  readonly ancestors: readonly string[];
  readonly parent: string;
}

/** The inner node `key` names, or null when it's gone or `key` isn't inner. */
export function innerAt(doc: SceneDocument, key: string): InnerAt | null {
  if (!isInnerKey(key)) return null;
  const trail = innerTrail(doc, parseKey(key));
  if (!trail) return null;
  const ancestors = trail.slice(0, -1).map((n) => pathKey(n.path));
  return { node: trail[trail.length - 1], ancestors, parent: ancestors.at(-1) ?? rootOf(key) };
}

/** True while the node `key` names is in `doc`: the scene node, or the inner node inside its instance. */
export function keyExists(doc: SceneDocument, key: string): boolean {
  return isInnerKey(key) ? innerAt(doc, key) !== null : doc.has(key);
}

/** The keys of `keys` whose nodes are still in `doc`, in their order. */
export function liveKeys(doc: SceneDocument, keys: Iterable<string>): string[] {
  return [...keys].filter((k) => keyExists(doc, k));
}

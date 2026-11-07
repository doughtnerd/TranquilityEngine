// Structural edits to a live World while playing (ADR 0124): create, rename, delete and reparent
// nodes in the live Hierarchy; add and remove components and set node references in the live
// Inspector. They go through the public GameObject API, as game code would (same hooks, same
// isolation checks), change the running World only, aren't undoable and are gone on Stop.
import { GameObject, type Component } from "../engine";
import { getComponentClass } from "../engine/core/registry";
import { getDataComponentDef } from "../engine/core/data";
import type { World } from "../engine/core/World";
import { applyDestroys, isEditableComponent, listComponents, listNodes, setSiblingIndex, writeField, type ComponentInfo } from "../engine/editor";
import { newComponentEntry, whyNotAddable } from "./componentEdits";

const shortName = (type: string) => type.replace(/^[^.]*\./, "");

/** Where top-level nodes go in a live World: under its active scene, else its root (as `GameObject.create` does). */
export function topLevelOf(world: World): GameObject {
  return world.activeScene ?? world.root;
}

/**
 * Create an empty node in a live World: under `parent` (null: the top level), at `index` among
 * its children (default: last). Returns the node.
 */
export function createLiveNode(world: World, parent: GameObject | null, index?: number, name = "GameObject"): GameObject {
  const node = GameObject.create(name, { parent: parent ?? topLevelOf(world) });
  if (index !== undefined) setSiblingIndex(node, index);
  return node;
}

/** Create an empty node right after `row` among its siblings. */
export function createLiveSibling(row: GameObject, name = "GameObject"): GameObject {
  const parent = row.parent ?? row.world.root;
  return createLiveNode(row.world, parent, parent.children.indexOf(row) + 1, name);
}

/** Rename a live node. Empty names are refused (false). */
export function renameLive(node: GameObject, name: string): boolean {
  const trimmed = name.trim();
  if (!node.isValid || !trimmed) return false;
  node.name = trimmed;
  return true;
}

/** Why `node` can't be deleted, or null. */
export function whyNotDeleteLive(node: GameObject): string | null {
  if (!node.isValid) return "it has been destroyed";
  if (node === node.world.root) return "it's the World root";
  return null;
}

/** Destroy a live node and its subtree now (its scripts get onDisable/onDestroy). Returns why not, or null. */
export function deleteLive(node: GameObject): string | null {
  const reason = whyNotDeleteLive(node);
  if (reason) return reason;
  const world = node.world;
  GameObject.destroy(node);
  applyDestroys(world); // shows while paused too
  return null;
}

/** Why `node` can't move under `parent` (null: the top level), or null. */
export function whyNotMoveLive(node: GameObject, parent: GameObject | null): string | null {
  if (!node.isValid) return "it has been destroyed";
  const world = node.world;
  if (node === world.root) return "it's the World root";
  if (node.isSceneNode) return "a loaded scene stays at the top of its World";
  const to = parent ?? topLevelOf(world);
  if (!to.isValid) return "the new parent has been destroyed";
  if (to.world !== world) return "nodes can't move between Worlds";
  for (let n: GameObject | null = to; n; n = n.parent) if (n === node) return "it can't go inside itself";
  return null;
}

/** Reparent a live node under `parent` (null: the top level), keeping its world transform. Returns why not, or null. */
export function moveLive(node: GameObject, parent: GameObject | null): string | null {
  const reason = whyNotMoveLive(node, parent);
  if (reason) return reason;
  const to = parent ?? topLevelOf(node.world);
  if (node.parent === to) return null;
  return node.setParent(to) ? null : "it can't go inside itself";
}

/**
 * Add a component of `type` to a live node, as `addBehavior` (or `addData`) does in a game: a
 * behavior's awake and onEnable run now. Colliders start fitted to the sprite or mesh, as in edit
 * mode. Returns the new component's info, or why it can't be added.
 */
export function addLiveComponent(node: GameObject, type: string): ComponentInfo | string {
  if (!node.isValid) return "the node has been destroyed";
  const reason = whyNotAddable(node, type);
  if (reason) return reason;
  const def = getDataComponentDef(type);
  const before = listComponents(node).filter((c) => c.type === type).length;
  if (def) node.addData(def);
  else {
    const cls = getComponentClass(type) as (new () => Component) | undefined;
    if (!cls) return `${shortName(type)} isn't registered`;
    const entry = newComponentEntry(node, type); // read before adding, while the sprite or mesh is the only thing measured
    node.addBehavior(cls);
    const added = listComponents(node).filter((c) => c.type === type);
    if (added.length === before) return `${shortName(type)} doesn't run in World ${node.world.name}`; // registered for other Worlds (ADR 0033)
    for (const [field, value] of Object.entries(entry.data ?? {})) writeField(node, type, before, field, value);
  }
  return listComponents(node).find((c) => c.type === type && c.index === before) ?? `${shortName(type)} wasn't added`;
}

/** Why a live component can't be removed, or null. */
export function whyNotRemoveLive(info: ComponentInfo): string | null {
  if (info.kind === "transform") return "every node has a Transform";
  if (!isEditableComponent(info.type)) return `${shortName(info.type)} is managed by the engine`;
  return null;
}

/** Remove a component from a live node now (a behavior gets onDisable/onDestroy). Returns why not, or null. */
export function removeLiveComponent(node: GameObject, info: ComponentInfo): string | null {
  if (!node.isValid) return "the node has been destroyed";
  const reason = whyNotRemoveLive(info);
  if (reason) return reason;
  if (info.kind === "data") {
    const def = getDataComponentDef(info.type);
    if (!def) return `${shortName(info.type)} isn't registered`;
    node.removeData(def);
    return null;
  }
  if (!info.component) return `${shortName(info.type)} has no live instance`;
  node.removeBehavior(info.component);
  applyDestroys(node.world);
  return null;
}

/** A node a live node reference can point to: every node of the same World below its root, parents first. */
export interface LiveNodeChoice {
  readonly node: GameObject;
  readonly name: string;
  /** Depth below the World root's children. */
  readonly depth: number;
}

/** The nodes a reference field on a node of `world` may point to (ADR 0032: only its own World's). */
export function liveNodeChoices(world: World): LiveNodeChoice[] {
  return listNodes(world)
    .filter((n) => n.depth > 0)
    .map((n) => ({ node: n.node, name: n.name, depth: n.depth - 1 }));
}

/** Point a node-reference field of a live component at `target` (null: None). Returns why not, or null. */
export function setLiveNodeRef(node: GameObject, info: ComponentInfo, field: string, target: GameObject | null): string | null {
  if (!node.isValid) return "the node has been destroyed";
  if (target && !target.isValid) return "that node has been destroyed";
  if (target && target.world !== node.world) return "a reference can't point into another World";
  const ok = writeField(node, info.type, info.index, field, target ? { $node: "live" } : null, () => target);
  return ok ? null : `${shortName(info.type)} has no field ${field}`;
}

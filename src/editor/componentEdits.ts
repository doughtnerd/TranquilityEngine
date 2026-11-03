// Adding, removing, enabling and reordering components from the Inspector (ADR 0022, 0026,
// 0028). On a plain node these edit the node's components list; on a prefab instance, or a node
// inside one, they become overrides (`addComponent`, `removeComponent`, `enabled`), and
// overrides pointing at a removed component are dropped or renumbered so the scene still loads.
// Each edit is one undo step, across every selected node. Reordering moves entries in a plain
// node's list (data components too); on an instance it's an `order` override (ADR 0029) of its
// scripts and engine components.
import { Assets, type GameObject } from "../engine";
import { componentCatalog, isDataComponent, isEditableComponent, listComponents, meshLocalBounds, spriteSize, type ComponentInfo } from "../engine/editor";
import { isScenePath } from "../engine/scene/SceneLoader";
import {
  AddComponent,
  MoveComponent,
  RemoveComponent,
  SetComponentEnabled,
  SetOverrides,
  sameTarget,
  type ComponentEntry,
  type NodeEntry,
  type NodePath,
  type OverrideEntry,
  type SceneDocument,
  type SceneFile,
} from "./document";
import type { OpenScene } from "./state";

/** Components a node can have only one of. Colliders, audio sources and scripts can repeat. */
const SINGLE = new Set(["engine.RigidBody2D", "engine.SpriteRenderer", "engine.Camera", "engine.Text"]);

const shortName = (type: string) => type.replace(/^[^.]*\./, "");

/** Why `type` can't be added to `node`, or null if it can. */
export function whyNotAddable(node: GameObject, type: string): string | null {
  if (!isEditableComponent(type)) return `${shortName(type)} is managed by the engine`;
  const existing = listComponents(node).find((c) => c.type === type);
  if (existing && (SINGLE.has(type) || existing.kind === "data")) return `it already has a ${shortName(type)}`;
  return null;
}

/**
 * The entry to add for `type` on `node`. A collider added beside a sprite or mesh starts out
 * fitted to it, as in Unity: a box the sprite's size, a circle around its larger side; a 3D box
 * around the mesh, a sphere around its largest side, an upright capsule around it (ADR 0045).
 */
export function newComponentEntry(node: GameObject, type: string): ComponentEntry {
  const size = type === "engine.BoxCollider2D" || type === "engine.CircleCollider2D" ? spriteSize(node) : null;
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  if (size && type === "engine.BoxCollider2D") return { type, data: { size: size.map(round) } };
  if (size && type === "engine.CircleCollider2D") return { type, data: { radius: round(Math.max(...size) / 2) } };
  const bounds = type === "engine.BoxCollider" || type === "engine.SphereCollider" || type === "engine.CapsuleCollider" ? meshLocalBounds(node) : null;
  if (bounds) {
    const extent = bounds.max.map((v, i) => v - bounds.min[i]);
    const center = bounds.max.map((v, i) => round((v + bounds.min[i]) / 2));
    if (type === "engine.BoxCollider") return { type, data: { center, size: extent.map(round) } };
    if (type === "engine.SphereCollider") return { type, data: { center, radius: round(Math.max(...extent) / 2) } };
    return { type, data: { center, radius: round(Math.max(extent[0], extent[2]) / 2), height: round(extent[1]) } };
  }
  return { type };
}

/** Overrides at `target` that add a component of `type`, as indexes into `list`. */
const addedBy = (list: readonly OverrideEntry[], target: readonly string[], type: string) =>
  list.flatMap((o, i) => (o.addComponent?.type === type && sameTarget(o.target, target) ? [i] : []));

/**
 * Why the component `info` can't be removed from the node at `path` (whose live node has
 * `liveCount` components of that type), or null if it can. On a prefab instance only components
 * added in this scene, and the first of a type the prefab has, can go: a `removeComponent`
 * override always removes the first.
 */
export function whyNotRemovable(doc: SceneDocument, path: NodePath, info: ComponentInfo, liveCount: number): string | null {
  if (!isEditableComponent(info.type)) return `every node has a ${shortName(info.type)}`;
  const [id, ...target] = path;
  if (!doc.isPrefabInstance(id)) {
    const inFile = (doc.node(id).components ?? []).filter((c) => c.type === info.type).length;
    return info.index < inFile ? null : "it isn't in the scene file (added by a script?)";
  }
  const fromPrefab = liveCount - addedBy(doc.node(id).overrides ?? [], target, info.type).length;
  if (info.index < fromPrefab && info.index > 0) return `only the first ${shortName(info.type)} from the prefab can be removed here; edit the prefab for the others`;
  return null;
}

/** Add a `type` component to each node (the ones that can take it), as one undo step. Returns how many got one. */
export function addComponentTo(scene: OpenScene, targets: readonly { path: NodePath; node: GameObject }[], type: string): number {
  const able = targets.filter((t) => whyNotAddable(t.node, type) === null);
  if (able.length === 0) return 0;
  const { doc, stack } = scene;
  stack.beginGroup(able.length === 1 ? `Add ${shortName(type)}` : `Add ${shortName(type)} to ${able.length} nodes`);
  try {
    for (const { path, node } of able) {
      const [id, ...target] = path;
      const entry = newComponentEntry(node, type);
      if (!doc.isPrefabInstance(id)) {
        stack.execute(new AddComponent(id, entry));
      } else {
        const add: OverrideEntry = target.length > 0 ? { target, addComponent: entry } : { addComponent: entry };
        stack.execute(new SetOverrides(id, `Add ${shortName(type)}`, [...structuredClone(doc.node(id).overrides ?? []), add]));
      }
    }
  } finally {
    stack.endGroup();
  }
  return able.length;
}

/**
 * The overrides after removing component `index` of `type` at `target`: the override that added
 * it is dropped (or, for one from the prefab, a `removeComponent` override is added), and field
 * overrides for that component go while later ones of the type shift down by one.
 */
export function overridesWithout(list: readonly OverrideEntry[], target: readonly string[], type: string, index: number, liveCount: number): OverrideEntry[] {
  const added = addedBy(list, target, type);
  const fromPrefab = liveCount - added.length;
  const dropAt = index >= fromPrefab ? added[index - fromPrefab] : -1;
  const out: OverrideEntry[] = [];
  list.forEach((o, i) => {
    if (i === dropAt) return;
    if (o.order && sameTarget(o.target, target)) {
      // Take the removed component's entry out of the order (its index-th occurrence of the type).
      const at = o.order.flatMap((t, j) => (t === type ? [j] : []))[index];
      const order = o.order.filter((_, j) => j !== at);
      if (order.length > 0) out.push({ ...structuredClone(o), order });
      return;
    }
    if (o.component === type && (o.field !== undefined || o.enabled !== undefined || o.worlds !== undefined) && sameTarget(o.target, target)) {
      const at = o.index ?? 0;
      if (at === index) return;
      if (at > index) {
        const shifted: OverrideEntry = { ...structuredClone(o), index: at - 1 };
        if (shifted.index === 0) delete shifted.index;
        out.push(shifted);
        return;
      }
    }
    out.push(structuredClone(o));
  });
  if (dropAt < 0) out.push(target.length > 0 ? { target: [...target], removeComponent: type } : { removeComponent: type });
  return out;
}

/** Remove a component from each node (`info` is that node's copy), as one undo step. Returns how many were removed. */
export function removeComponentFrom(scene: OpenScene, targets: readonly { path: NodePath; node: GameObject; info: ComponentInfo }[]): number {
  const { doc, stack } = scene;
  const able = targets.filter((t) => whyNotRemovable(doc, t.path, t.info, countOf(t.node, t.info.type)) === null);
  if (able.length === 0) return 0;
  const type = shortName(able[0].info.type);
  stack.beginGroup(able.length === 1 ? `Remove ${type}` : `Remove ${type} from ${able.length} nodes`);
  try {
    for (const { path, node, info } of able) {
      const [id, ...target] = path;
      if (!doc.isPrefabInstance(id)) {
        // The info's index counts components of its type; find that entry in the node's list.
        const list = doc.node(id).components ?? [];
        const positions = list.flatMap((c, i) => (c.type === info.type ? [i] : []));
        stack.execute(new RemoveComponent(id, positions[info.index]));
      } else {
        const next = overridesWithout(doc.node(id).overrides ?? [], target, info.type, info.index, countOf(node, info.type));
        stack.execute(new SetOverrides(id, `Remove ${type}`, next));
      }
    }
  } finally {
    stack.endGroup();
  }
  return able.length;
}

const countOf = (node: GameObject, type: string) => listComponents(node).filter((c) => c.type === type).length;

/** Where a live component comes from: an entry in the node's own list, the prefab, or an `addComponent` override. */
export type Origin = { kind: "file"; position: number } | { kind: "prefab" } | { kind: "added"; at: number } | null;

export function originOf(doc: SceneDocument, path: NodePath, info: ComponentInfo, liveCount: number): Origin {
  const [id, ...target] = path;
  if (!doc.isPrefabInstance(id)) {
    const positions = (doc.node(id).components ?? []).flatMap((c, i) => (c.type === info.type ? [i] : []));
    return info.index < positions.length ? { kind: "file", position: positions[info.index] } : null;
  }
  const added = addedBy(doc.node(id).overrides ?? [], target, info.type);
  const fromPrefab = liveCount - added.length;
  return info.index < fromPrefab ? { kind: "prefab" } : { kind: "added", at: added[info.index - fromPrefab] };
}

/** Why the component `info` can't be switched on or off, or null if it can. */
export function whyNotToggleable(doc: SceneDocument, path: NodePath, info: ComponentInfo, liveCount: number): string | null {
  if (info.kind !== "behavior") return `${shortName(info.type)} is always on`;
  return originOf(doc, path, info, liveCount) ? null : "it isn't in the scene file (added by a script?)";
}

/** Start each component enabled or disabled, as one undo step. Returns how many changed. */
export function setComponentEnabled(scene: OpenScene, targets: readonly { path: NodePath; node: GameObject; info: ComponentInfo }[], enabled: boolean): number {
  const { doc, stack } = scene;
  const able = targets.filter((t) => t.info.enabled !== enabled && whyNotToggleable(doc, t.path, t.info, countOf(t.node, t.info.type)) === null);
  if (able.length === 0) return 0;
  const type = shortName(able[0].info.type);
  const label = `${enabled ? "Enable" : "Disable"} ${type}${able.length > 1 ? ` on ${able.length} nodes` : ""}`;
  stack.beginGroup(label);
  try {
    for (const { path, node, info } of able) {
      const [id, ...target] = path;
      const origin = originOf(doc, path, info, countOf(node, info.type))!;
      if (origin.kind === "file") {
        stack.execute(new SetComponentEnabled(id, origin.position, enabled));
        continue;
      }
      const list = structuredClone(doc.node(id).overrides ?? []);
      if (origin.kind === "added") {
        // Added in this scene: the flag goes on the added entry itself.
        const entry = list[origin.at].addComponent!;
        if (enabled) delete entry.enabled;
        else list[origin.at].addComponent = { type: entry.type, enabled: false, ...(entry.data ? { data: entry.data } : {}) };
      } else {
        // From the prefab: an override that differs from it, which toggling back simply removes.
        const at = list.findIndex((o) => o.component === info.type && o.field === undefined && o.enabled !== undefined && (o.index ?? 0) === info.index && sameTarget(o.target, target));
        if (at >= 0) list.splice(at, 1);
        else list.push({ ...(target.length > 0 ? { target } : {}), component: info.type, ...(info.index > 0 ? { index: info.index } : {}), enabled });
      }
      stack.execute(new SetOverrides(id, label, list));
    }
  } finally {
    stack.endGroup();
  }
  return able.length;
}

/** Why component `info` of the node at `path` can't be reordered, or null if it can. */
export function whyNotReorderable(doc: SceneDocument, path: NodePath, info: ComponentInfo): string | null {
  if (info.kind === "transform") return "Transform always comes first";
  if (doc.isPrefabInstance(path[0]) && info.kind === "data") return "data components of a prefab instance stay where the prefab has them";
  return null;
}

/**
 * A plain node's components in the order its file lists them (Transform first; components the
 * file doesn't have, such as ones a script added, last). The World keeps data components apart,
 * so this, not the live order, is what the Inspector shows and reorders.
 */
export function inFileOrder(doc: SceneDocument, id: string, infos: readonly ComponentInfo[]): ComponentInfo[] {
  if (doc.isPrefabInstance(id)) return [...infos];
  const list = doc.node(id).components ?? [];
  const position = (c: ComponentInfo) => (c.kind === "transform" ? -1 : (list.flatMap((e, i) => (e.type === c.type ? [i] : []))[c.index] ?? Infinity));
  return [...infos].sort((a, b) => position(a) - position(b));
}

/**
 * Move component `info` of the node at `path` next to `anchor` (before it, or after it with
 * `after`), as one undo step: within a plain node's list, or as an `order` override on a prefab
 * instance. False if nothing moved.
 */
export function moveComponent(scene: OpenScene, path: NodePath, node: GameObject, info: ComponentInfo, anchor: ComponentInfo, after: boolean): boolean {
  const { doc, stack } = scene;
  if (whyNotReorderable(doc, path, info) || whyNotReorderable(doc, path, anchor)) return false;
  const same = (a: ComponentInfo, b: ComponentInfo) => a.type === b.type && a.index === b.index;
  if (same(info, anchor)) return false;
  const [id, ...target] = path;
  if (!doc.isPrefabInstance(id)) {
    const list = doc.node(id).components ?? [];
    const position = (c: ComponentInfo) => list.flatMap((e, i) => (e.type === c.type ? [i] : []))[c.index];
    const from = position(info), at = position(anchor);
    if (from === undefined || at === undefined) return false;
    const to = (at > from ? at - 1 : at) + (after ? 1 : 0); // the anchor's place once `info` is out of the list
    if (to === from) return false;
    stack.execute(new MoveComponent(id, from, to));
    return true;
  }
  // An instance: write the new order of its scripts and engine components.
  const live = listComponents(node).filter((c) => c.kind === "behavior");
  const rest = live.filter((c) => !same(c, info));
  const at = rest.findIndex((c) => same(c, anchor));
  if (at < 0) return false;
  const next = [...rest];
  next.splice(at + (after ? 1 : 0), 0, info);
  if (next.every((c, i) => same(c, live[i]))) return false;
  const order = next.map((c) => c.type);
  const list = (doc.node(id).overrides ?? []).filter((o) => !(o.order && sameTarget(o.target, target))).map((o) => structuredClone(o));
  // Back in the prefab's own order: no override needed.
  const natural = prefabOrder(doc, id, target, list);
  if (!natural || natural.length !== order.length || natural.some((t, i) => t !== order[i])) list.push({ ...(target.length > 0 ? { target: [...target] } : {}), order });
  stack.execute(new SetOverrides(id, "Reorder components", list));
  return true;
}

/**
 * Why the `k`-th missing component of `type` on the node at `path` (one whose script is gone,
 * ADR 0030; `missingCount` of that type) can't be removed, or null if it can: ones written in
 * this scene can go, ones that come from a prefab file are removed in the prefab.
 */
export function whyNotRemovableMissing(doc: SceneDocument, path: NodePath, type: string, k: number, missingCount: number): string | null {
  const [id, ...target] = path;
  if (!doc.isPrefabInstance(id)) return null;
  const added = addedBy(doc.node(id).overrides ?? [], target, type).length;
  return k >= missingCount - added ? null : "it comes from the prefab; remove it there";
}

/** Remove the `k`-th missing component of `type` from the node at `path`, as one undo step. */
export function removeMissingComponent(scene: OpenScene, path: NodePath, type: string, k: number, missingCount: number): boolean {
  const { doc, stack } = scene;
  if (whyNotRemovableMissing(doc, path, type, k, missingCount)) return false;
  const [id, ...target] = path;
  const label = `Remove missing ${shortName(type)}`;
  if (!doc.isPrefabInstance(id)) {
    const at = (doc.node(id).components ?? []).flatMap((c, i) => (c.type === type ? [i] : []))[k];
    if (at === undefined) return false;
    stack.execute(new RemoveComponent(id, at));
  } else {
    stack.execute(new SetOverrides(id, label, overridesWithout(doc.node(id).overrides ?? [], target, type, k, missingCount)));
  }
  return true;
}

/**
 * The order an instance's node at `target` has without an order override: its components in the
 * prefab file, then `overrides` (removals take the first of a type, additions go last). Null when
 * that can't be told from the file alone (a node inside a nested instance that has overrides of
 * its own, or a missing file).
 */
function prefabOrder(doc: SceneDocument, id: string, target: readonly string[], overrides: readonly OverrideEntry[]): string[] | null {
  const node = prefabNodeEntry(doc, id, target);
  if (!node) return null;
  const order = (node.components ?? []).map((c) => c.type).filter((t) => t !== "engine.Transform" && !isDataComponent(t));
  for (const o of overrides) {
    if (!sameTarget(o.target, target)) continue;
    if (o.removeComponent && order.includes(o.removeComponent)) order.splice(order.indexOf(o.removeComponent), 1);
    if (o.addComponent && !isDataComponent(o.addComponent.type)) order.push(o.addComponent.type);
  }
  return order;
}

/**
 * The plain node entry in a prefab file that the node at `target` inside instance `id` comes
 * from, following nested instances. Null when that can't be told from the files alone (a node
 * inside a nested instance that has overrides of its own, a sub-scene's own node, a missing file).
 */
export function prefabNodeEntry(doc: SceneDocument, id: string, target: readonly string[]): NodeEntry | null {
  let path = doc.node(id).prefab!;
  const ids = [...target];
  for (;;) {
    if (!Assets.has(path)) return null;
    const file = Assets.json<SceneFile>(path);
    const top = file.nodes.filter((n) => !n.parent);
    if (isScenePath(path) && ids.length === 0) return null; // a sub-scene's own node: not in its file
    let node = isScenePath(path) ? top.find((n) => n.id === ids.shift()) : top[0];
    while (node && ids.length > 0 && !node.prefab) {
      const next = ids.shift();
      node = file.nodes.find((n) => n.id === next && n.parent === node!.id);
    }
    if (!node) return null;
    if (node.prefab) {
      if (ids.length === 0 || node.overrides?.length) return null;
      path = node.prefab;
      continue;
    }
    return node;
  }
}

export { componentCatalog };

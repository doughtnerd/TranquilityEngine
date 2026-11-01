// Adding, removing, enabling and reordering components from the Inspector (ADR 0022, 0026,
// 0028). On a plain node these edit the node's components list; on a prefab instance, or a node
// inside one, they become overrides (`addComponent`, `removeComponent`, `enabled`), and
// overrides pointing at a removed component are dropped or renumbered so the scene still loads.
// Each edit is one undo step, across every selected node. Reordering is for plain nodes only
// (the override format has no way to say it).
import type { GameObject } from "../engine";
import { componentCatalog, isEditableComponent, listComponents, spriteSize, type ComponentInfo } from "../engine/editor";
import {
  AddComponent,
  MoveComponent,
  RemoveComponent,
  SetComponentEnabled,
  SetOverrides,
  sameTarget,
  type ComponentEntry,
  type NodePath,
  type OverrideEntry,
  type SceneDocument,
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
 * The entry to add for `type` on `node`. A collider added beside a sprite starts out fitted to
 * it, as in Unity: a box the sprite's size, a circle around its larger side.
 */
export function newComponentEntry(node: GameObject, type: string): ComponentEntry {
  const size = type === "engine.BoxCollider2D" || type === "engine.CircleCollider2D" ? spriteSize(node) : null;
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  if (size && type === "engine.BoxCollider2D") return { type, data: { size: size.map(round) } };
  if (size && type === "engine.CircleCollider2D") return { type, data: { radius: round(Math.max(...size) / 2) } };
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
    if (o.component === type && (o.field !== undefined || o.enabled !== undefined) && sameTarget(o.target, target)) {
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
type Origin = { kind: "file"; position: number } | { kind: "prefab" } | { kind: "added"; at: number } | null;

function originOf(doc: SceneDocument, path: NodePath, info: ComponentInfo, liveCount: number): Origin {
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

/** Why the components of the node at `path` can't be reordered, or null if they can. */
export function whyNotReorderable(doc: SceneDocument, path: NodePath): string | null {
  return doc.isPrefabInstance(path[0]) ? "components of a prefab instance are reordered in the prefab" : null;
}

/**
 * Move component `info` of the plain node `id` next to `anchor` (before it, or after it with
 * `after`), as one undo step. False if nothing moved.
 */
export function moveComponent(scene: OpenScene, id: string, info: ComponentInfo, anchor: ComponentInfo, after: boolean): boolean {
  const { doc, stack } = scene;
  if (whyNotReorderable(doc, [id]) || (info.type === anchor.type && info.index === anchor.index)) return false;
  const list = doc.node(id).components ?? [];
  const position = (c: ComponentInfo) => list.flatMap((e, i) => (e.type === c.type ? [i] : []))[c.index];
  const from = position(info), at = position(anchor);
  if (from === undefined || at === undefined) return false;
  const to = (at > from ? at - 1 : at) + (after ? 1 : 0); // the anchor's place once `info` is out of the list
  if (to === from) return false;
  stack.execute(new MoveComponent(id, from, to));
  return true;
}

export { componentCatalog };

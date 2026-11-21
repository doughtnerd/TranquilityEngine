// Adding, removing, enabling and reordering components from the Inspector (ADR 0022, 0026,
// 0028). On a plain node these edit the node's components list; on a prefab instance, or a node
// inside one, they become overrides (`addComponent`, `removeComponent`, `enabled`), and
// overrides pointing at a removed component are dropped or renumbered so the scene still loads.
// Each edit is one undo step, across every selected node. Reordering moves entries in a plain
// node's list (data components too); on an instance it's an `order` override (ADR 0029) of its
// scripts and engine components.
import { pluginTitle } from "../plugins/manifest";
import { isRuntimePluginActive, pluginOfComponent, runtimePluginManifest } from "../plugins/runtimeContext";
import type { GameObject } from "../engine";
import { componentCatalog, type ComponentInfo, isDataComponent, isEditableComponent, listComponents, meshLocalBounds, viewport } from "../engine/editor";
import type { ResolvedNode } from "../engine/scene/resolvedScene";
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
import { editableNow } from "./editGate";
import { undoStep } from "./undoStep";

/** Components a node can have only one of. Colliders, audio sources and scripts can repeat. */
const SINGLE = new Set(["engine.RigidBody2D", "engine.SpriteRenderer", "engine.Camera", "engine.Text", "engine.UICanvas", "engine.UIPanel", "engine.UIText", "engine.UIImage", "engine.UIButton", "engine.UIInputField"]);

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
  const size = type === "engine.BoxCollider2D" || type === "engine.CircleCollider2D" ? viewport(node.world).spriteSize(node) : null;
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

/**
 * The node at `path` inside instance `path[0]` as the game makes it (the document's resolved view,
 * ADR 0280), with `overrides` in place of the instance's own when given; null when it isn't there.
 */
function resolvedNode(doc: SceneDocument, path: NodePath, overrides?: readonly OverrideEntry[]): ResolvedNode | null {
  return doc.resolve(path[0], overrides).nodes.find((n) => sameTarget(n.path, path)) ?? null;
}

/**
 * Why the component `info` can't be removed from the node at `path`, or null if it can. On a
 * prefab instance only components added in this scene, and the first of a type the prefab has,
 * can go: a `removeComponent` override always removes the first.
 */
export function whyNotRemovable(doc: SceneDocument, path: NodePath, info: ComponentInfo): string | null {
  if (!isEditableComponent(info.type)) return `every node has a ${shortName(info.type)}`;
  const origin = originOf(doc, path, info);
  if (!origin) return "it isn't in the scene file (added by a script?)";
  if (origin.kind === "prefab" && info.index > 0) return `only the first ${shortName(info.type)} from the prefab can be removed here; edit the prefab for the others`;
  return null;
}

/** Add a `type` component to each node (the ones that can take it), as one undo step. Returns how many got one. */
export function addComponentTo(scene: OpenScene, targets: readonly { path: NodePath; node: GameObject }[], type: string): number {
  if (!editableNow({ kind: "scene", scene })) return 0;
  const able = targets.filter((t) => whyNotAddable(t.node, type) === null);
  if (able.length === 0) return 0;
  const { doc, stack } = scene;
  undoStep(stack, able.length === 1 ? `Add ${shortName(type)}` : `Add ${shortName(type)} to ${able.length} nodes`, () => {
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
  });
  return able.length;
}

/**
 * The overrides after removing component `index` of `type` at `target` (which comes from
 * `origin`): the override that added it is dropped (or, for one from the prefab, a
 * `removeComponent` override is added), and field overrides for that component go while later
 * ones of the type shift down by one.
 */
function overridesWithout(list: readonly OverrideEntry[], target: readonly string[], type: string, index: number, origin: Origin): OverrideEntry[] {
  const dropAt = origin?.kind === "added" ? origin.at : -1;
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
  if (!editableNow({ kind: "scene", scene })) return 0;
  const { doc, stack } = scene;
  const able = targets.filter((t) => whyNotRemovable(doc, t.path, t.info) === null);
  if (able.length === 0) return 0;
  const type = shortName(able[0].info.type);
  undoStep(stack, able.length === 1 ? `Remove ${type}` : `Remove ${type} from ${able.length} nodes`, () => {
    for (const { path, info } of able) {
      const [id, ...target] = path;
      if (!doc.isPrefabInstance(id)) {
        // The info's index counts components of its type; find that entry in the node's list.
        const list = doc.node(id).components ?? [];
        const positions = list.flatMap((c, i) => (c.type === info.type ? [i] : []));
        stack.execute(new RemoveComponent(id, positions[info.index]));
      } else {
        const next = overridesWithout(doc.node(id).overrides ?? [], target, info.type, info.index, originOf(doc, path, info));
        stack.execute(new SetOverrides(id, `Remove ${type}`, next));
      }
    }
  });
  return able.length;
}

/** Where a live component comes from: an entry in the node's own list, the prefab, or an `addComponent` override. */
export type Origin = { kind: "file"; position: number } | { kind: "prefab" } | { kind: "added"; at: number } | null;

/**
 * Where component `info` (the `index`-th of its type) of the node at `path` comes from. Inside a
 * prefab instance this is the resolved view's word on it (ADR 0280): added by one of this
 * instance's `addComponent` overrides, or from the prefab files (their own overrides included).
 * Null when the file doesn't have it (a script added it).
 */
export function originOf(doc: SceneDocument, path: NodePath, info: Pick<ComponentInfo, "type" | "index">): Origin {
  const [id] = path;
  if (!doc.isPrefabInstance(id)) {
    const positions = (doc.node(id).components ?? []).flatMap((c, i) => (c.type === info.type ? [i] : []));
    return info.index < positions.length ? { kind: "file", position: positions[info.index] } : null;
  }
  const c = resolvedNode(doc, path)?.components.filter((x) => x.type === info.type)[info.index];
  if (!c) return null;
  return c.added && sameTarget(c.added.instance, [id]) ? { kind: "added", at: c.added.override } : { kind: "prefab" };
}

/** Why the component `info` can't be switched on or off, or null if it can. */
export function whyNotToggleable(doc: SceneDocument, path: NodePath, info: ComponentInfo): string | null {
  if (info.kind !== "behavior") return `${shortName(info.type)} is always on`;
  return originOf(doc, path, info) ? null : "it isn't in the scene file (added by a script?)";
}

/** Start each component enabled or disabled, as one undo step. Returns how many changed. */
export function setComponentEnabled(scene: OpenScene, targets: readonly { path: NodePath; node: GameObject; info: ComponentInfo }[], enabled: boolean): number {
  if (!editableNow({ kind: "scene", scene })) return 0;
  const { doc, stack } = scene;
  const able = targets.filter((t) => t.info.enabled !== enabled && whyNotToggleable(doc, t.path, t.info) === null);
  if (able.length === 0) return 0;
  const type = shortName(able[0].info.type);
  const label = `${enabled ? "Enable" : "Disable"} ${type}${able.length > 1 ? ` on ${able.length} nodes` : ""}`;
  undoStep(stack, label, () => {
    for (const { path, info } of able) {
      const [id, ...target] = path;
      const origin = originOf(doc, path, info)!;
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
  });
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
  if (!editableNow({ kind: "scene", scene })) return false;
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
 * The title of the disabled plugin the Component `type` belongs to (ADR 0133), or null when no
 * disabled plugin claims it (its script is gone instead, ADR 0030).
 */
export function disabledPluginOf(type: string): string | null {
  const name = pluginOfComponent(type);
  if (name === undefined || isRuntimePluginActive(name)) return null;
  const manifest = runtimePluginManifest(name);
  return manifest ? pluginTitle(manifest) : name;
}

/** The badge on a missing Component's card: "missing script", or which disabled plugin it is missing with. */
export const missingBadge = (type: string): string => {
  const plugin = disabledPluginOf(type);
  return plugin === null ? "missing script" : `missing (plugin ${plugin} is disabled)`;
};

/**
 * Why the `k`-th missing component of `type` on the node at `path` (one whose script is gone,
 * ADR 0030) can't be removed, or null if it can: ones written in this scene can go, ones that
 * come from a prefab file are removed in the prefab.
 */
export function whyNotRemovableMissing(doc: SceneDocument, path: NodePath, type: string, k: number): string | null {
  if (!doc.isPrefabInstance(path[0])) return null;
  return originOf(doc, path, { type, index: k })?.kind === "added" ? null : "it comes from the prefab; remove it there";
}

/** Remove the `k`-th missing component of `type` from the node at `path`, as one undo step. */
export function removeMissingComponent(scene: OpenScene, path: NodePath, type: string, k: number): boolean {
  if (!editableNow({ kind: "scene", scene })) return false;
  const { doc, stack } = scene;
  if (whyNotRemovableMissing(doc, path, type, k)) return false;
  const [id, ...target] = path;
  const label = `Remove missing ${shortName(type)}`;
  if (!doc.isPrefabInstance(id)) {
    const at = (doc.node(id).components ?? []).flatMap((c, i) => (c.type === type ? [i] : []))[k];
    if (at === undefined) return false;
    stack.execute(new RemoveComponent(id, at));
  } else {
    stack.execute(new SetOverrides(id, label, overridesWithout(doc.node(id).overrides ?? [], target, type, k, originOf(doc, path, { type, index: k }))));
  }
  return true;
}

/**
 * The order of the behaviours of the node at `target` inside instance `id` with `overrides` in
 * place of the instance's own (the resolved view, ADR 0280). Null when the node isn't there.
 */
function prefabOrder(doc: SceneDocument, id: string, target: readonly string[], overrides: readonly OverrideEntry[]): string[] | null {
  const node = resolvedNode(doc, [id, ...target], overrides);
  return node ? node.components.map((c) => c.type).filter((t) => t !== "engine.Transform" && !isDataComponent(t)) : null;
}

export { componentCatalog };

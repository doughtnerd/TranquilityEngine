// Adding, removing, enabling and reordering components from the Inspector (ADR 0022, 0026,
// 0028). On a plain node these edit the node's components list; on a prefab instance, or a node
// inside one, they become overrides (`addComponent`, `removeComponent`, `enabled`), written by the
// override writer (ADR 0287), which also drops or renumbers the overrides pointing at a removed
// component so the scene still loads. This module keeps the edit gate, the labels and the
// multi-select: each edit is one undo step, across every selected node. Reordering moves entries
// in a plain node's list (data components too); on an instance it's an `order` override (ADR 0029)
// of its scripts and engine components.
import { pluginTitle } from "../plugins/manifest";
import { isRuntimePluginActive, pluginOfComponent, runtimePluginManifest } from "../plugins/runtimeContext";
import type { GameObject } from "../engine";
import { componentCatalog as engineCatalog, type ComponentInfo, type ComponentTypeInfo, isEditableComponent, listComponents, meshLocalBounds, viewport } from "../engine/editor";
import { MoveComponent, type ComponentEntry, type NodePath, type SceneDocument } from "./document";
import { originOf, writeAddComponent, writeProperty, writeRemoveComponent } from "./overrideWriter";
import type { OpenScene } from "./state";
import { editableNow } from "./editGate";
import { undoStep } from "./undoStep";

/** Components a node can have only one of. Colliders, audio sources and scripts can repeat. */
const SINGLE = new Set(["engine.RigidBody2D", "engine.SpriteRenderer", "engine.Camera"]);

/** The UI element types only a UI document builds (ADR 0417): never added by hand. */
const DOCUMENT_ONLY = new Set(["engine.UICanvas", "engine.UIPanel", "engine.UIText", "engine.UIImage", "engine.UIButton", "engine.UIInputField"]);

const shortName = (type: string) => type.replace(/^[^.]*\./, "");

/** Why `type` can't be added to `node`, or null if it can. */
export function whyNotAddable(node: GameObject, type: string): string | null {
  if (!isEditableComponent(type)) return `${shortName(type)} is managed by the engine`;
  if (DOCUMENT_ONLY.has(type)) return `${shortName(type)} comes from UI documents: add the element to a *.ui.xml document`;
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
    for (const { path, node } of able) stack.execute(writeAddComponent(doc, path, newComponentEntry(node, type)));
  });
  return able.length;
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
      const command = writeRemoveComponent(doc, path, info.type, info.index, `Remove ${type}`);
      if (command) stack.execute(command);
    }
  });
  return able.length;
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
      const command = writeProperty(doc, path, { kind: "enabled", type: info.type, index: info.index }, enabled, label);
      if (command) stack.execute(command);
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
  const [id] = path;
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
  // Back in the prefab's own order, the writer drops the override instead.
  const command = writeProperty(doc, path, { kind: "order" }, next.map((c) => c.type), "Reorder components");
  if (!command) return false;
  stack.execute(command);
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
  const command = writeRemoveComponent(doc, path, type, k, `Remove missing ${shortName(type)}`);
  if (!command) return false;
  stack.execute(command);
  return true;
}

/** The types Add Component offers: the engine's catalog without the UI element types documents build (ADR 0417). */
export function componentCatalog(): ComponentTypeInfo[] {
  return engineCatalog().filter((t) => !DOCUMENT_ONLY.has(t.id));
}

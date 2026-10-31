/**
 * Editor-only access to engine internals (ADR 0026). Not exported from `src/engine/index.ts` and
 * not part of the engine library's type declarations: game code must never import this. The
 * scene editor (`src/editor/`) imports it by path.
 */
import { Component } from "../core/Component";
import { getDataComponentDef, type DataComponentDef, type ScalarType } from "../core/data";
import { Vector3 } from "../core/math";
import { getComponentClass, getComponentId, getFields, type ComponentClass, type FieldType } from "../core/registry";
import type { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import { SceneInstance, applyTransform, assignField, instantiateFile, type InstantiateHooks, type SceneFile } from "../scene/SceneLoader";

export type { InstantiateHooks } from "../scene/SceneLoader";

/** One node of a World, as listed by `listNodes`. */
export interface NodeInfo {
  readonly node: GameObject;
  readonly entity: number;
  /** Depth below the listing root (the root itself is 0). */
  readonly depth: number;
  readonly name: string;
  /** Scene-file id the node was created from ("" for nodes made in code). */
  readonly id: string;
  readonly active: boolean;
  readonly activeInHierarchy: boolean;
  readonly parent: GameObject | null;
  readonly children: readonly GameObject[];
  readonly isSceneNode: boolean;
  readonly isComponentNode: boolean;
}

/** Every node under `root` (default: the World root, included), parents before children. */
export function listNodes(world: World, root: GameObject = world.root): NodeInfo[] {
  const out: NodeInfo[] = [];
  const visit = (node: GameObject, depth: number): void => {
    const e = node.entity;
    if (world.isPendingDestroy(e)) return;
    const children = node.children;
    out.push({
      node,
      entity: e,
      depth,
      name: node.name,
      id: node.id,
      active: node.active,
      activeInHierarchy: node.activeInHierarchy,
      parent: node.parent,
      children,
      isSceneNode: node.isSceneNode,
      isComponentNode: node.isComponentNode,
    });
    for (const c of children) visit(c, depth + 1);
  };
  visit(root, 0);
  return out;
}

/** A field of a component with its declared type and live value. */
export interface FieldValue {
  readonly name: string;
  /** Declared type: a field type (`Number`, `Vector3`, `GameObject`, `AssetRef`…) or a data component scalar type. */
  readonly type: FieldType | ScalarType;
  readonly value: unknown;
}

export type ComponentKind = "transform" | "behavior" | "data";

/** One component on a node, as listed by `listComponents`. */
export interface ComponentInfo {
  readonly kind: ComponentKind;
  /** Registered id, e.g. `engine.Transform`, `engine.SpriteRenderer`, `game.Scroller`. */
  readonly type: string;
  /** Which component of this type on the node (0 for the first). */
  readonly index: number;
  /** The live instance for behaviors and built-ins; null for Transform and data components. */
  readonly component: Component | null;
  readonly enabled: boolean;
  readonly fields: readonly FieldValue[];
}

/**
 * Transform first (if any), then attached components in order, then data components. Values are
 * live references for engine objects (vectors, nodes) and copies for Transform values.
 */
export function listComponents(node: GameObject): ComponentInfo[] {
  const world = node.world;
  const out: ComponentInfo[] = [];
  const t = node.transform;
  if (t) {
    out.push({
      kind: "transform",
      type: "engine.Transform",
      index: 0,
      component: null,
      enabled: true,
      fields: [
        { name: "position", type: Vector3, value: t.position.clone() },
        { name: "rotation", type: Vector3, value: t.eulerAngles },
        { name: "scale", type: Vector3, value: t.scale.clone() },
      ],
    });
  }
  const counts = new Map<string, number>();
  for (const c of world._componentsOf(node.entity)) {
    const cls = c.constructor as ComponentClass;
    if (c instanceof SceneInstance) continue;
    const type = getComponentId(cls) ?? cls.name;
    const index = counts.get(type) ?? 0;
    counts.set(type, index + 1);
    const values = c as unknown as Record<string, unknown>;
    out.push({
      kind: "behavior",
      type,
      index,
      component: c,
      enabled: c.enabled,
      fields: getFields(cls).map((f) => ({ name: f.name, type: f.type, value: values[f.name] })),
    });
  }
  for (const def of world._dataComponentsOf(node.entity)) {
    const view = node.getData(def) as Record<string, number>;
    out.push({
      kind: "data",
      type: def.id,
      index: 0,
      component: null,
      enabled: true,
      fields: def.fields.map((f) => ({ name: f, type: def.schema[f], value: view[f] })),
    });
  }
  return out;
}

/** Mark `node` as the root of a scene being edited: scripts, systems and audio stay still inside it. */
export function setEditMode(node: GameObject, value = true): void {
  node.world.setEditMode(node.entity, value);
}

/**
 * Create a scene node under the World root for `file` and instantiate it in edit mode (no
 * scripts run). Physics isn't created. `hooks.onNode` reports each node's document path.
 */
export function instantiateDocument(world: World, file: SceneFile, path: string, hooks?: InstantiateHooks): GameObject {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.(scene\.|prefab\.)?json$/, "");
  const sceneNode = world._createNode(name, world.root.entity, { transform: false });
  world.setSceneNode(sceneNode.entity);
  world.setEditMode(sceneNode.entity, true);
  world._batch(() => sceneNode.addBehavior(SceneInstance, { source: path }));
  instantiateFile(world, file, sceneNode, path, hooks);
  return sceneNode;
}

/** Instantiate the nodes of `file` under `parent` (used to rebuild part of an edited scene). */
export function instantiateNodes(world: World, file: SceneFile, parent: GameObject, path: string, hooks?: InstantiateHooks): GameObject[] {
  return instantiateFile(world, file, parent, path, hooks);
}

/** Destroy a node and its subtree right away. Only call between frames (editor commands). */
export function destroyNow(node: GameObject): void {
  if (!node.isValid) return;
  node.world._destroyNode(node.entity);
  node.world._flushDestroyed();
}

/** Reparent without changing the local transform, then move to `index` among the new siblings. */
export function moveNode(node: GameObject, parent: GameObject, index: number): void {
  node.world._setParent(node.entity, parent.entity, false);
  node.world._setSiblingIndex(node.entity, index);
}

/** Move a node to `index` among its siblings. */
export function setSiblingIndex(node: GameObject, index: number): void {
  node.world._setSiblingIndex(node.entity, index);
}

/**
 * Write one serialized field value (scene-file JSON) onto a live component of `node`, the same
 * way the scene loader would. `type` is a component id; `index` picks among several of that type.
 * `$node` references go through `resolve`. Returns false if the component or field isn't there.
 */
export function writeField(
  node: GameObject,
  type: string,
  index: number,
  field: string,
  raw: unknown,
  resolve: (id: string) => GameObject | null = () => null,
): boolean {
  if (type === "engine.Transform") {
    if (!node.transform) return false;
    applyTransform(node, { [field]: raw });
    return true;
  }
  const def: DataComponentDef | undefined = getDataComponentDef(type);
  if (def) {
    const view = node.getData(def) as Record<string, number> | null;
    if (!view || !def.fields.includes(field)) return false;
    view[field] = Number(raw);
    return true;
  }
  const cls = getComponentClass(type) as (abstract new () => Component) | undefined;
  const c = cls ? node.getBehaviors(cls)[index] : undefined;
  if (!c) return false;
  const info = getFields(c.constructor as ComponentClass).find((f) => f.name === field);
  if (!info) return false;
  assignField(c, info, raw, (id, assign) => assign(resolve(id)));
  return true;
}

// --- Viewport (ADR 0022) -----------------------------------------------------------------------

/** The canvas the World renders into, or null when headless. */
export function viewportCanvas(world: World): HTMLCanvasElement | null {
  return world.render?.canvas ?? null;
}

/**
 * Nodes whose renderers lie under a canvas point (CSS pixels, origin top-left), topmost first.
 * Only nodes with a SpriteRenderer or Text are pickable. Empty when headless.
 */
export function pick(world: World, x: number, y: number): GameObject[] {
  return world.render?.pick(world, x, y) ?? [];
}

/** Outline the renderers of these nodes (and their descendants) in the viewport until changed. */
export function setSelectionOutline(world: World, nodes: readonly GameObject[]): void {
  world.render?.setSelectionOutline(nodes);
}

import { Component } from "../core/Component";
import type { DataComponentDef, DataView, Schema } from "../core/data";
import { Vector3, type Vec3Input } from "../core/math";
import { getComponentId, getComponentOptions, type ComponentClass } from "../core/registry";
import { World } from "../core/World";
import { worldsMatch, type WorldTag } from "../core/worlds";
import type { Transform } from "./Transform";

type ComponentType<T extends Component> = abstract new () => T;
type ConcreteComponentType<T extends Component> = new () => T;

/** Writable fields of a component, for initializers. */
export type ComponentInit<T> = { [K in keyof T]?: T[K] extends (...args: never[]) => unknown ? never : T[K] };

export interface InstantiateOptions {
  /** Parent node. Defaults to the active scene node (or the World root if no scene is loaded). */
  parent?: GameObject | null;
  /** Local position of the new node's root. */
  position?: Vec3Input;
  /** Local Z rotation in degrees. */
  rotation2D?: number;
  name?: string;
}

/**
 * A node in the scene graph (ADR 0008). A lightweight handle to an internal entity; game code
 * never sees the entity id. Handles become invalid once the node is destroyed (at the end of
 * the frame `destroy` was called in).
 */
export class GameObject {
  /** @internal */
  constructor(
    /** @internal */ readonly world: World,
    /** @internal */ readonly entity: number,
    /** @internal */ readonly generation: number,
  ) {}

  // --- static API -------------------------------------------------------------------------

  /**
   * Create an empty node: in the `parent`'s World when one is given, else in the current World
   * (ADR 0032, 0034). Passing a parent is how code after an `await` stays in its own World.
   */
  static create(name = "GameObject", options: { parent?: GameObject | null; transform?: boolean } = {}): GameObject {
    const world = options.parent?.world ?? World.require();
    const parent = options.parent ?? world.activeScene ?? world.root;
    return world._createNode(name, parent.entity, { transform: options.transform ?? true });
  }

  /**
   * Instantiate a prefab file (a scene file with one root node, ADR 0013/0016) and return its
   * root: in the `parent`'s World when one is given, else in the current World (ADR 0032, 0034).
   * awake/onEnable run before this returns; start runs next frame. In a behavior,
   * `this.instantiate` always uses the behavior's own World.
   */
  static instantiate(prefabPath: string, options: InstantiateOptions = {}): GameObject {
    return (options.parent?.world ?? World.require())._instantiatePrefab(prefabPath, options);
  }

  /** Queue a node (with its subtree) or a component for destruction at the end of the frame. */
  static destroy(target: GameObject | Component): void {
    if (target instanceof Component) target._world._removeComponent(target);
    else if (target.isValid) target.world._destroyNode(target.entity);
  }

  /** Move a node directly under the World root so it survives scene loads (ADR 0016). */
  static makePersistent(node: GameObject): void {
    node.setParent(node.world.root);
  }

  /** First active component of `type` in the active world. */
  static findObjectOfType<T extends Component>(type: ComponentType<T>): T | null {
    return World.require()._componentsOfType(type).find((c) => c.isActiveAndEnabled) ?? null;
  }

  /** All active components of `type` in the active world. */
  static findObjectsOfType<T extends Component>(type: ComponentType<T>): T[] {
    return World.require()._componentsOfType(type).filter((c) => c.isActiveAndEnabled);
  }

  // --- identity & state ----------------------------------------------------------------------

  /** False once the node has been destroyed. */
  get isValid(): boolean {
    return this.world.isAlive(this.entity, this.generation);
  }

  private check(): void {
    if (!this.isValid) throw new Error("This GameObject has been destroyed.");
  }

  /** Stable id from scene data (empty for nodes created at runtime). */
  get id(): string { this.check(); return this.world.ids[this.entity]; }

  get name(): string { this.check(); return this.world.names[this.entity]; }
  set name(value: string) { this.check(); this.world.names[this.entity] = value; }

  get tags(): string[] { this.check(); return this.world.tags[this.entity]; }
  set tags(value: string[]) { this.check(); this.world.tags[this.entity] = [...value]; }
  hasTag(tag: string): boolean { return this.tags.includes(tag); }

  /** The node's own active flag. */
  get active(): boolean { this.check(); return this.world.activeSelf[this.entity] === 1; }
  setActive(active: boolean): void { this.check(); this.world._setActive(this.entity, active); }

  /** Active only if this node and all its ancestors are active. */
  get activeInHierarchy(): boolean { this.check(); return this.world.activeInHierarchy[this.entity] === 1; }

  /** True for component nodes: child nodes that host components on behalf of their parent (ADR 0009). */
  get isComponentNode(): boolean { this.check(); return this.world.isComponentNode(this.entity); }

  get isSceneNode(): boolean { this.check(); return this.world.isSceneNode(this.entity); }

  /** The nearest ancestor scene node, or null for persistent nodes and the root (ADR 0016). */
  get scene(): GameObject | null {
    this.check();
    for (let e = this.entity; e >= 0; e = this.world.parentEntity(e)) {
      if (this.world.isSceneNode(e)) return this.world.handle(e);
    }
    return null;
  }

  // --- hierarchy ----------------------------------------------------------------------------

  get transform(): Transform | null {
    this.check();
    return this.world.transformOf(this.entity);
  }

  get parent(): GameObject | null {
    this.check();
    const p = this.world.parentEntity(this.entity);
    return p < 0 ? null : this.world.handle(p);
  }

  get children(): GameObject[] {
    this.check();
    return this.world.childEntities(this.entity).map((c) => this.world.handle(c));
  }

  /**
   * Reparent. By default the world transform is kept. Returns false if it would create a cycle.
   * Throws for a parent in another World (ADR 0032).
   */
  setParent(parent: GameObject, options: { keepWorldTransform?: boolean } = {}): boolean {
    this.check();
    this.world._assertOwns(parent, `${this}.setParent`);
    return this.world._setParent(this.entity, parent.entity, options.keepWorldTransform ?? true);
  }

  /** Find a descendant by slash-separated name path, e.g. `"Weapon/Muzzle"`. */
  find(path: string): GameObject | null {
    let current: GameObject | null = this;
    for (const part of path.split("/").filter(Boolean)) {
      current = current.children.find((c) => c.name === part) ?? null;
      if (!current) return null;
    }
    return current;
  }

  // --- components ---------------------------------------------------------------------------

  /**
   * Attach a component to this node. `init` values that are another World's nodes or components
   * throw (ADR 0032). A component registered for other Worlds (`@behavior(id, { worlds })`, ADR
   * 0033) isn't attached: you get a detached instance that never runs and that `getBehavior`
   * doesn't find (see `_componentAllowedIn`).
   */
  addBehavior<T extends Component>(type: ConcreteComponentType<T>, init?: ComponentInit<T>): T {
    this.check();
    if (init) this.world._assertOwnsAll(init, `${this}.addBehavior(${type.name})`);
    if (!_componentAllowedIn(this.world, type)) return detachedComponent(this, type, init);
    return this.world._addComponent(this.entity, type, init as Partial<T>);
  }

  /**
   * Attach a component on a new component node under this node (ADR 0009). The component's
   * `owner` is this node; the component node has its own transform for offsets.
   */
  addChildBehavior<T extends Component>(type: ConcreteComponentType<T>, options: { name?: string; position?: Vec3Input; init?: ComponentInit<T> } = {}): T {
    this.check();
    if (!_componentAllowedIn(this.world, type)) return detachedComponent(this, type, options.init);
    const child = this.world._createNode(options.name ?? type.name, this.entity);
    this.world.setComponentNode(child.entity, true);
    if (options.position) child.transform!.position = Vector3.from(options.position);
    return child.addBehavior(type, options.init);
  }

  /** First component of `type` attached directly to this node. */
  getBehavior<T extends Component>(type: ComponentType<T>): T | null {
    this.check();
    for (const c of this.world._componentsOf(this.entity)) if (c instanceof type) return c;
    return null;
  }

  /** All components of `type` attached directly to this node. */
  getBehaviors<T extends Component>(type: ComponentType<T>): T[] {
    this.check();
    return this.world._componentsOf(this.entity).filter((c): c is T => c instanceof type);
  }

  /** Attached components plus those on this node's component-node children (ADR 0009). */
  getBehaviorInComponents<T extends Component>(type: ComponentType<T>): T | null {
    const own = this.getBehavior(type);
    if (own) return own;
    for (const child of this.children) {
      if (!child.isComponentNode) continue;
      const found = child.getBehavior(type);
      if (found) return found;
    }
    return null;
  }

  /** First component of `type` on this node or any descendant (depth-first). */
  getBehaviorInChildren<T extends Component>(type: ComponentType<T>, includeInactive = false): T | null {
    if (includeInactive || this.activeInHierarchy) {
      const own = this.getBehavior(type);
      if (own) return own;
    }
    for (const child of this.children) {
      const found = child.getBehaviorInChildren(type, includeInactive);
      if (found) return found;
    }
    return null;
  }

  /** First component of `type` on this node or any ancestor. */
  getBehaviorInParent<T extends Component>(type: ComponentType<T>): T | null {
    for (let n: GameObject | null = this; n; n = n.parent) {
      const found = n.getBehavior(type);
      if (found) return found;
    }
    return null;
  }

  /** Queue a component on this node for removal at the end of the frame. */
  removeBehavior(component: Component): void {
    if (component.node.world !== this.world || component.node.entity !== this.entity) throw new Error("Component is not attached to this node.");
    this.world._removeComponent(component);
  }

  // Unity-style aliases (ADR 0019).
  addComponent<T extends Component>(type: ConcreteComponentType<T>, init?: ComponentInit<T>): T { return this.addBehavior(type, init); }
  getComponent<T extends Component>(type: ComponentType<T>): T | null { return this.getBehavior(type); }
  getComponents<T extends Component>(type: ComponentType<T>): T[] { return this.getBehaviors(type); }
  getComponentInChildren<T extends Component>(type: ComponentType<T>, includeInactive = false): T | null { return this.getBehaviorInChildren(type, includeInactive); }
  getComponentInParent<T extends Component>(type: ComponentType<T>): T | null { return this.getBehaviorInParent(type); }

  // --- data components (ADR 0017) ---------------------------------------------------------------

  addData<S extends Schema>(def: DataComponentDef<S>, init?: Partial<Record<keyof S, number | boolean>>): DataView<S> {
    this.check();
    const store = this.world._dataStore(def as DataComponentDef);
    store.add(this.entity, init as Record<string, number | boolean>);
    return store.view(this.entity) as DataView<S>;
  }

  getData<S extends Schema>(def: DataComponentDef<S>): DataView<S> | null {
    this.check();
    const store = this.world._dataStore(def as DataComponentDef);
    return store.present[this.entity] ? (store.view(this.entity) as DataView<S>) : null;
  }

  hasData(def: DataComponentDef): boolean {
    this.check();
    return this.world._dataStore(def).present[this.entity] === 1;
  }

  removeData(def: DataComponentDef): void {
    this.check();
    this.world._dataStore(def).remove(this.entity);
  }

  toString(): string {
    return this.isValid ? `GameObject(${this.name})` : "GameObject(destroyed)";
  }
}

// --- per-World components (ADR 0033 §3) ---------------------------------------------------------

/** Component ids already noted as skipped, per World, so each is noted once. */
const skippedNoted = new WeakMap<World, Set<string>>();

/**
 * @internal Whether a component may be created in `world` (ADR 0033 §3): its class's `worlds`
 * option, or an instance's own `worlds` (a scene file's component entry), must match the World's
 * tags. Without either it's created everywhere, so engine built-ins work in every World. Editor
 * Worlds take every component, so a scene edits whole. A skip is by design, not a problem, so it's
 * noted once per World and component id on `console.debug` rather than warned.
 */
export function _componentAllowedIn(world: World, type: ComponentClass | undefined, instanceWorlds?: readonly WorldTag[], id?: string): boolean {
  if (world.kind === "editor") return true;
  const filter = instanceWorlds ?? (type ? getComponentOptions(type).worlds : undefined);
  if (filter === undefined || worldsMatch(filter, world.worldTags)) return true;
  const name = id ?? (type ? (getComponentId(type) ?? type.name) : "?");
  let noted = skippedNoted.get(world);
  if (!noted) skippedNoted.set(world, (noted = new Set()));
  if (!noted.has(name)) {
    noted.add(name);
    console.debug(`[myco] "${name}" isn't created in World "${world.name}": it's for Worlds tagged ${filter.map((t) => `"${t}"`).join(", ") || "(none)"}.`);
  }
  return false;
}

/** A component that isn't attached (it's for other Worlds): it knows its node, but never runs. */
function detachedComponent<T extends Component>(node: GameObject, type: ConcreteComponentType<T>, init?: ComponentInit<T>): T {
  const c = new type();
  c._node = node;
  c._destroyed = true;
  if (init) Object.assign(c, init);
  return c;
}

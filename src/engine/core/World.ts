/**
 * The World: one self-contained runtime with its own root node, entity storage, systems and
 * physics worlds (ADR 0016). Game code never touches this class directly; it goes through
 * GameObject, GameBehavior, SceneManager and the static facades.
 *
 * Storage follows ADR 0012: entities are generational indices, hierarchy and transforms live in
 * typed arrays indexed by entity, components are indexed per entity and per type.
 */
import { GameObject, type InstantiateOptions } from "../scene/GameObject";
import { instantiatePrefab } from "../scene/SceneLoader";
import { Transform } from "../scene/Transform";
import { Component, GameBehavior, type FrameHook, type PendingWait } from "./Component";
import { DataStore, type BufferDef, type DataComponentDef } from "./data";
import { Mat4 } from "./math";
import { QueryRows, type Rows } from "./rows";
import { Scheduler, defineBuiltinSystem, type QueryTerm } from "./systems";
import { resolveSettings, type ProjectSettings, type ProjectSettingsInput } from "./settings";
import type { RenderSurface } from "../render/RenderSurface";
import type { NetworkTime } from "../net/time";
import type { WorldTag } from "./worlds";
import { _disposeWorldServices, _interpolateWorldServices, _onComponentAttached, _worldServiceOf } from "./worldServices";

export type WorldKind = "runtime" | "editor" | "server";

/** @internal What one `World.step` draws to and reports (ADR 0160). */
export interface WorldFrame {
  /** The surface the World draws to this frame (its view); none: it runs without drawing. */
  surface?: RenderSurface | null;
  /** Gets the fixed (with start()), update (with lateUpdate and transform propagation) and render phases' durations, in milliseconds. */
  timings?: (fixedMs: number, updateMs: number, renderMs: number) => void;
}

export interface TimeState {
  /** Scaled game time in seconds since the world started. */
  time: number;
  /** Scaled seconds since the last frame (0 while paused). */
  deltaTime: number;
  /** Real seconds since the last frame, clamped to `maxFrameTime`. */
  unscaledDeltaTime: number;
  fixedDeltaTime: number;
  /** Scaled time at the current fixed step. */
  fixedTime: number;
  /** 0..1 progress between the last fixed step and the next; used for interpolation. */
  fixedAlpha: number;
  timeScale: number;
  frameCount: number;
  fixedStepCount: number;
  realtimeSinceStartup: number;
  /** Network ticks and round-trip time, on Worlds linked by a transport (ADR 0033); undefined otherwise. */
  network?: NetworkTime;
}

/** What a World is called and tagged (ADR 0032). */
export interface WorldIdentity {
  /** Unique within its Engine. */
  name?: string;
  tags?: readonly WorldTag[];
}

/** The name and tags a World of `kind` gets when none are given (until tags replace WorldKind, ADR 0032). */
const KIND_IDENTITY: Record<WorldKind, { name: string; tags: readonly WorldTag[] }> = {
  runtime: { name: "Default", tags: ["default", "local"] },
  editor: { name: "Editor", tags: ["editor"] },
  server: { name: "Server", tags: ["server"] },
};

const NONE = -1;
const FLAG_COMPONENT_NODE = 1;
const FLAG_SCENE_NODE = 2;
const FLAG_PENDING_DESTROY = 4;
const FLAG_EDIT_MODE = 8;

const FRAME_HOOKS: FrameHook[] = ["fixedUpdate", "update", "lateUpdate"];
/** A component's engine state, never copied when a reloaded script's component is swapped (ADR 0125). */
const SWAP_SKIPPED = new Set(["_node", "_enabled", "_active", "_awoken", "_started", "_destroyed", "_seq", "_wait", "_abort"]);

export class World {
  /** The world static facades (Time, Input, GameObject.instantiate…) act on. */
  static active: World | null = null;

  /** Add a catalog system to this World by name (ADR 0032; T2). */
  addSystem(name: string): void {
    this.scheduler.addSystem(name);
  }

  /** Take a system out of this World (T2). */
  removeSystem(name: string): void {
    this.scheduler.removeSystem(name);
  }

  /** The systems this World runs, by name, in execution order per phase. */
  systemNames(): string[] {
    return this.scheduler.names();
  }

  /** @internal */
  static require(): World {
    if (!World.active) throw new Error("No active World. Create an Engine first.");
    return World.active;
  }

  /**
   * @internal Run `fn` with `world` as the current World (ADR 0032), then put the previous one
   * back. The Engine uses it for each World's frame, handles for work done on a World's behalf.
   */
  static _runIn<T>(world: World, fn: () => T): T {
    const previous = World.active;
    World.active = world;
    try {
      return fn();
    } finally {
      World.active = previous;
    }
  }

  readonly kind: WorldKind;
  /** Unique within its Engine (ADR 0032). */
  readonly name: string;
  /**
   * The World's tags: they decide which systems bootstraps add and which per-World components load
   * (ADR 0032, 0033). (Not `tags`: that's the per-node tag storage.)
   */
  readonly worldTags: readonly WorldTag[];
  readonly settings: ProjectSettings;
  readonly time: TimeState;
  readonly root: GameObject;

  /** @internal */ readonly scheduler: Scheduler;
  /** @internal */ _waits: PendingWait[] = [];
  /** @internal The Engine that owns this World (ADR 0032): set by the Engine (T1), used by `Engine.createWorld`/`findWorld`. */
  _engine: unknown = null;
  /** @internal Transports this World owns (ADR 0033), closed when it's destroyed: see `createWorldTransport`. */
  readonly _transports = new Set<{ close(): void }>();
  /** @internal Whether local input reaches this World (`WorldConfig.input`): set by the Engine (T1), read by Input (T3). */
  _takesInput = true;
  /** @internal Real time not yet consumed by fixed steps (ADR 0011, 0032): each World has its own. */
  _accumulator = 0;
  /** @internal A paused World skips its frames (`WorldHandle.pause`). */
  _paused = false;
  /** @internal */ render: RenderSurface | null = null;
  /** True while this World's frame runs (`step`); structural scene changes wait for its end. */
  private framing = false;
  /** Work deferred to the end of the frame (ADR 0011 step 10): scene loads and unloads, World tear-down. */
  private frameEndOps: (() => void)[] = [];

  // --- entity storage -------------------------------------------------------------------
  private capacity = 0;
  private highWater = 0;
  private free: number[] = [];
  /** @internal */ generations = new Uint32Array(0);
  /** @internal */ alive = new Uint8Array(0);

  // hierarchy
  /** @internal */ parentOf = new Int32Array(0);
  private firstChild = new Int32Array(0);
  private lastChild = new Int32Array(0);
  private nextSibling = new Int32Array(0);
  private prevSibling = new Int32Array(0);
  private flags = new Uint8Array(0);
  /** @internal */ activeSelf = new Uint8Array(0);
  /** @internal */ activeInHierarchy = new Uint8Array(0);
  /** @internal */ inWorld = new Uint8Array(0);
  /** @internal */ names: string[] = [];
  /** @internal */ ids: string[] = [];
  /** @internal */ tags: string[][] = [];
  private handles: (GameObject | undefined)[] = [];

  // transforms (struct of arrays)
  /** @internal */ hasTransform = new Uint8Array(0);
  /** @internal */ tPos = new Float32Array(0);
  /** @internal */ tRot = new Float32Array(0);
  /** @internal */ tScl = new Float32Array(0);
  /** @internal */ tWorld = new Float32Array(0);
  private worldDirty = new Uint8Array(0);
  /** @internal Incremented whenever a node's world transform may have changed. */ tVersion = new Uint32Array(0);
  private transformFacades: (Transform | undefined)[] = [];
  private readonly scratch = new Float32Array(16);

  // components
  private componentsOf: Component[][] = [];
  private byType = new Map<Function, Component[]>();
  private hookLists: Record<FrameHook, GameBehavior[]> = { fixedUpdate: [], update: [], lateUpdate: [] };
  private pendingStart: GameBehavior[] = [];
  private order = new Int32Array(0);
  private orderDirty = false;
  private seq = 0;
  private suspendDepth = 0;
  private deferred: Component[] = [];
  private destroyQueue: (GameObject | Component)[] = [];
  private hasEditMode = false;

  // data components and buffers
  private dataStores = new Map<DataComponentDef, DataStore>();
  private buffers = new Map<BufferDef<unknown>, unknown[]>();
  /** Each system query's row buffer, reused run to run (`_query`). */
  private rowBuffers = new Map<readonly QueryTerm[], Int32Array>();
  /** Nodes flagged as scenes, alive (so `activeScene` needn't look when there are none). */
  private sceneNodeCount = 0;

  constructor(kind: WorldKind = "runtime", settings: ProjectSettingsInput | ProjectSettings = {}, identity: WorldIdentity = {}) {
    this.kind = kind;
    this.name = identity.name ?? KIND_IDENTITY[kind].name;
    this.worldTags = [...(identity.tags ?? KIND_IDENTITY[kind].tags)];
    this.settings = resolveSettings(settings as ProjectSettingsInput);
    this.time = {
      time: 0,
      deltaTime: 0,
      unscaledDeltaTime: 0,
      fixedDeltaTime: this.settings.time.fixedDeltaTime,
      fixedTime: 0,
      fixedAlpha: 0,
      timeScale: 1,
      frameCount: 0,
      fixedStepCount: 0,
      realtimeSinceStartup: 0,
    };
    this.scheduler = new Scheduler(this);
    this.grow(256);
    const root = this.allocate(kind === "runtime" ? "Runtime" : kind === "editor" ? "Editor" : "Server", false);
    this.inWorld[root] = 1;
    this.activeInHierarchy[root] = 1;
    this.root = this.handle(root);
  }

  // --- nodes ----------------------------------------------------------------------------

  /** @internal Create a node under `parent` (an entity index). */
  _createNode(name: string, parent: number, options: { transform?: boolean; id?: string } = {}): GameObject {
    const e = this.allocate(name, options.transform ?? true);
    if (options.id) this.ids[e] = options.id;
    this.link(e, parent);
    this.refreshActive(e);
    return this.handle(e);
  }

  /** @internal */
  handle(e: number): GameObject {
    let h = this.handles[e];
    if (!h || h.generation !== this.generations[e]) {
      h = new GameObject(this, e, this.generations[e]);
      this.handles[e] = h;
    }
    return h;
  }

  /** @internal */
  isAlive(e: number, generation: number): boolean {
    return e >= 0 && e < this.capacity && this.alive[e] === 1 && this.generations[e] === generation;
  }

  /** @internal */ parentEntity(e: number): number { return this.parentOf[e]; }

  /** @internal */
  childEntities(e: number): number[] {
    const out: number[] = [];
    for (let c = this.firstChild[e]; c !== NONE; c = this.nextSibling[c]) out.push(c);
    return out;
  }

  /** @internal */ isComponentNode(e: number): boolean { return (this.flags[e] & FLAG_COMPONENT_NODE) !== 0; }
  /** @internal */ setComponentNode(e: number, value: boolean): void {
    this.flags[e] = value ? this.flags[e] | FLAG_COMPONENT_NODE : this.flags[e] & ~FLAG_COMPONENT_NODE;
  }
  /** @internal */ isSceneNode(e: number): boolean { return (this.flags[e] & FLAG_SCENE_NODE) !== 0; }
  /** @internal */ setSceneNode(e: number): void {
    if (!this.isSceneNode(e)) this.sceneNodeCount++;
    this.flags[e] |= FLAG_SCENE_NODE;
  }
  /** @internal */ isPendingDestroy(e: number): boolean { return (this.flags[e] & FLAG_PENDING_DESTROY) !== 0; }

  /**
   * @internal Mark a node as the root of a subtree being edited (ADR 0026). Inside it, GameBehavior
   * hooks don't run, built-in activation side effects (e.g. audio playback) are skipped (unless the
   * component opts in with `_activatesInEditMode`, as UIDocument does) and user
   * systems don't see its nodes, so a scene open in the editor stays still. Editor tools outside
   * the subtree keep running.
   */
  setEditMode(e: number, value: boolean): void {
    this.flags[e] = value ? this.flags[e] | FLAG_EDIT_MODE : this.flags[e] & ~FLAG_EDIT_MODE;
    if (value) this.hasEditMode = true;
  }

  /** @internal True if the node or an ancestor is an edit-mode root. */
  inEditMode(e: number): boolean {
    if (!this.hasEditMode) return false;
    for (let n = e; n !== NONE; n = this.parentOf[n]) if (this.flags[n] & FLAG_EDIT_MODE) return true;
    return false;
  }

  /** @internal Move a node to `index` among its siblings (clamped). */
  _setSiblingIndex(e: number, index: number): void {
    const parent = this.parentOf[e];
    if (parent === NONE) return;
    const siblings = this.childEntities(parent).filter((c) => c !== e);
    const i = Math.max(0, Math.min(index, siblings.length));
    this.unlink(e);
    this.parentOf[e] = parent;
    const next = i < siblings.length ? siblings[i] : NONE;
    const prev = i > 0 ? siblings[i - 1] : NONE;
    this.prevSibling[e] = prev;
    this.nextSibling[e] = next;
    if (prev === NONE) this.firstChild[parent] = e;
    else this.nextSibling[prev] = e;
    if (next === NONE) this.lastChild[parent] = e;
    else this.prevSibling[next] = e;
    this.orderDirty = true;
  }

  /** @internal Data components present on a node, in definition order of their stores. */
  _dataComponentsOf(e: number): DataComponentDef[] {
    const out: DataComponentDef[] = [];
    for (const [def, store] of this.dataStores) if (store.present[e]) out.push(def);
    return out;
  }

  /** Scene nodes directly under the root, oldest first (ADR 0016). */
  get sceneNodes(): GameObject[] {
    return this.childEntities(this.handle(0).entity)
      .filter((c) => this.isSceneNode(c) && !this.isPendingDestroy(c))
      .map((c) => this.handle(c));
  }

  /** The most recently loaded scene node, or null. */
  get activeScene(): GameObject | null {
    if (this.sceneNodeCount === 0) return null;
    // From the last child back, without listing them: every GameObject.create without a parent asks.
    for (let c = this.lastChild[0]; c !== NONE; c = this.prevSibling[c]) if (this.isSceneNode(c) && !this.isPendingDestroy(c)) return this.handle(c);
    return null;
  }

  /** @internal Reparent; returns false if it would create a cycle. */
  _setParent(e: number, parent: number, keepWorldTransform: boolean): boolean {
    for (let p = parent; p !== NONE; p = this.parentOf[p]) if (p === e) return false;
    if (this.parentOf[e] === parent) return true;
    if (keepWorldTransform && this.hasTransform[e]) {
      // Not `this.scratch`: computing the new parent's world matrix below uses it.
      const world = new Float32Array(16);
      Mat4.copy(world, 0, this.worldMatrix(e), e * 16);
      this.unlink(e);
      this.link(e, parent);
      const parentInv = new Float32Array(16);
      const local = new Float32Array(16);
      Mat4.invert(parentInv, 0, this.worldMatrix(parent), parent * 16);
      Mat4.multiply(local, 0, parentInv, 0, world, 0);
      Mat4.decompose(local, 0, this.tPos, e * 3, this.tRot, e * 4, this.tScl, e * 3);
    } else {
      this.unlink(e);
      this.link(e, parent);
    }
    // A component node moved away from its owner becomes a normal node (ADR 0009).
    if (this.isComponentNode(e)) {
      this.setComponentNode(e, false);
      console.warn(`[myco] Component node "${this.names[e]}" was reparented and is now a normal node.`);
    }
    this.markTransformDirty(e);
    this.orderDirty = true;
    this.refreshActive(e);
    return true;
  }

  /** @internal */
  _setActive(e: number, active: boolean): void {
    if (!!this.activeSelf[e] === active) return;
    this.activeSelf[e] = active ? 1 : 0;
    this.refreshActive(e);
  }

  /** @internal The World's instance of World service `id` (ADR 0135), or null while it isn't running here. */
  service<T = unknown>(id: string): T | null {
    return _worldServiceOf(this, id) as T | null;
  }

  /** @internal Queue a node (and its subtree) for destruction at the end of the frame. */
  _destroyNode(e: number): void {
    if (e === 0) throw new Error("The World root cannot be destroyed.");
    if (this.isPendingDestroy(e)) return;
    this.flags[e] |= FLAG_PENDING_DESTROY;
    this.destroyQueue.push(this.handle(e));
  }

  // --- components -----------------------------------------------------------------------

  /** @internal */
  _addComponent<T extends Component>(e: number, type: new () => T, init?: Partial<T>): T {
    const c = new type();
    c._node = this.handle(e);
    c._seq = ++this.seq;
    this.componentsOf[e].push(c);
    for (let t: Function | null = type; t && t !== Component && t !== Object; t = Object.getPrototypeOf(t)) {
      let list = this.byType.get(t);
      if (!list) this.byType.set(t, (list = []));
      list.push(c);
    }
    if (c instanceof GameBehavior) {
      for (const hook of FRAME_HOOKS) {
        if (typeof (c as unknown as Record<string, unknown>)[hook] === "function") this.hookLists[hook].push(c);
      }
      this.orderDirty = true;
    }
    if (init) Object.assign(c, init);
    c._onAttach();
    _onComponentAttached(this, type); // a World service it needs starts (ADR 0135)
    if (this.suspendDepth > 0) this.deferred.push(c);
    else this._refreshComponent(c);
    return c;
  }

  /**
   * @internal Editor (ADR 0125): swap script types reloaded while this World runs. `classFor` gives
   * the class now registered for an old component class (undefined: keep it); `dataFor` the new
   * definition for an old data component definition. Each component of a replaced class is replaced
   * by an instance of the new class that takes its place, with every own property copied (references
   * to other replaced components re-pointed), not awoken or started again; the old one gets
   * onDisable first and the new one onEnable. Data stores move to the new definitions, keeping the
   * fields both have. Returns how many components were swapped.
   */
  _swapScriptTypes(classFor: (old: Function) => (new () => Component) | undefined, dataFor: (old: DataComponentDef) => DataComponentDef | undefined): number {
    // Data components: move each store to its new definition.
    for (const [def, store] of [...this.dataStores]) {
      const next = dataFor(def);
      if (!next || next === def) continue;
      const moved = new DataStore(next, this.capacity);
      for (const e of store.dense) {
        const init: Record<string, number> = {};
        for (const f of next.fields) if (store.arrays[f]) init[f] = store.arrays[f][e];
        moved.add(e, init);
      }
      this.dataStores.delete(def);
      this.dataStores.set(next, moved);
    }
    this.rowBuffers.clear();

    // Components: make the replacements first, so references between them can be re-pointed.
    const replaced = new Map<Component, Component>();
    const classes = new Map<Function, Function>();
    for (const list of this.componentsOf) {
      if (!list) continue;
      for (const c of list) {
        if (c._destroyed) continue;
        const next = classFor(c.constructor);
        if (!next || next === c.constructor) continue;
        replaced.set(c, new next());
        classes.set(c.constructor, next);
      }
    }
    if (replaced.size === 0) return 0;
    const remap = (value: unknown): unknown => {
      if (value instanceof Component) return replaced.get(value) ?? value;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) if (value[i] instanceof Component && replaced.has(value[i])) value[i] = replaced.get(value[i]);
      } else if (value instanceof Map) {
        for (const [k, v] of value) if (v instanceof Component && replaced.has(v)) value.set(k, replaced.get(v));
      } else if (value instanceof Set) {
        for (const v of [...value]) if (v instanceof Component && replaced.has(v)) (value.delete(v), value.add(replaced.get(v)));
      }
      return value;
    };
    // Static properties (`static instance`) carry over to the new class, re-pointed the same way.
    for (const [old, next] of classes) {
      for (const key of Object.keys(old)) {
        try {
          (next as unknown as Record<string, unknown>)[key] = remap((old as unknown as Record<string, unknown>)[key]);
        } catch {
          // a read-only static: the new class keeps its own
        }
      }
    }
    for (const [old, next] of replaced) {
      // The old instance stops as if disabled (its waits and async flows end with it).
      if (old._active) {
        old._active = false;
        if (!this.inEditMode(old._node.entity) || old._activatesInEditMode) old._onDeactivate();
        if (old instanceof GameBehavior) {
          if (old.onDisable) this.invoke(old, "onDisable");
          this.cancelAsync(old);
        }
      } else if (old instanceof GameBehavior) this.cancelAsync(old);
      old._onDetach();
      for (const key of Object.keys(old)) {
        if (SWAP_SKIPPED.has(key)) continue;
        try {
          (next as unknown as Record<string, unknown>)[key] = remap((old as unknown as Record<string, unknown>)[key]);
        } catch {
          // an accessor-only property on the new class: it keeps its own
        }
      }
      next._node = old._node;
      next._enabled = old._enabled;
      next._awoken = old._awoken;
      next._started = old._started;
      next._seq = old._seq;
      old._destroyed = true;
      const e = old._node.entity;
      const list = this.componentsOf[e];
      list[list.indexOf(old)] = next;
      for (let t: Function | null = old.constructor; t && t !== Component && t !== Object; t = Object.getPrototypeOf(t)) {
        const of = this.byType.get(t);
        if (of) removeItem(of, old);
      }
      for (let t: Function | null = next.constructor; t && t !== Component && t !== Object; t = Object.getPrototypeOf(t)) {
        let of = this.byType.get(t);
        if (!of) this.byType.set(t, (of = []));
        of.push(next);
        of.sort((a, b) => a._seq - b._seq);
      }
      if (old instanceof GameBehavior) {
        for (const hook of FRAME_HOOKS) removeItem(this.hookLists[hook], old);
        removeItem(this.pendingStart, old);
      }
      if (next instanceof GameBehavior) {
        for (const hook of FRAME_HOOKS) if (typeof (next as unknown as Record<string, unknown>)[hook] === "function") this.hookLists[hook].push(next);
      }
      const queued = this.destroyQueue.indexOf(old);
      if (queued >= 0) this.destroyQueue[queued] = next;
      const deferred = this.deferred.indexOf(old);
      if (deferred >= 0) this.deferred[deferred] = next;
    }
    this.orderDirty = true;
    // Then each replacement starts where its old instance was: onEnable, and start() if it hadn't run.
    for (const next of replaced.values()) {
      next._onAttach();
      if (!this.deferred.includes(next)) this._refreshComponent(next);
    }
    return replaced.size;
  }

  /** @internal Queue a component for removal at the end of the frame. */
  _removeComponent(c: Component): void {
    if (c._destroyed || this.destroyQueue.includes(c)) return;
    this.destroyQueue.push(c);
  }

  /** @internal Remove a component right away. Only safe outside script iteration (e.g. while loading). */
  _removeComponentImmediate(c: Component): void {
    this.reallyRemoveComponent(c);
  }

  /** @internal Backs GameObject.instantiate. */
  _instantiatePrefab(path: string, options: InstantiateOptions): GameObject {
    return instantiatePrefab(this, path, options);
  }

  /** @internal */
  _componentsOf(e: number): readonly Component[] {
    return this.componentsOf[e];
  }

  /**
   * @internal Put a node's components in the order of `ordered` (the same components): its list,
   * and the creation sequence that orders hooks within one node (ADR 0007, 0029).
   */
  _reorderComponents(e: number, ordered: readonly Component[]): void {
    const current = this.componentsOf[e];
    if (ordered.length !== current.length || !ordered.every((c) => current.includes(c))) throw new Error("_reorderComponents: not the same components.");
    const seqs = current.map((c) => c._seq).sort((a, b) => a - b);
    ordered.forEach((c, i) => (c._seq = seqs[i]));
    this.componentsOf[e] = [...ordered];
    this.orderDirty = true;
  }

  /** @internal All live components of a type (including subclasses), in creation order. */
  _componentsOfType<T extends Component>(type: abstract new () => T): readonly T[] {
    return (this.byType.get(type) ?? []) as T[];
  }

  /**
   * @internal Bring a component's lifecycle state up to date: awake on first activation, then
   * onEnable/onDisable on transitions. The single place lifecycle transitions happen.
   */
  _refreshComponent(c: Component): void {
    if (c._destroyed || this.suspendDepth > 0) return;
    const e = c._node.entity;
    const nodeActive = this.activeInHierarchy[e] === 1 && this.inWorld[e] === 1;
    if (!c._awoken) {
      if (!nodeActive) return; // Unity semantics: awake waits until the node is first active.
      c._awoken = true;
      if (c instanceof GameBehavior && c.awake) this.invoke(c, "awake");
      if (c._destroyed) return;
    }
    const active = nodeActive && c._enabled;
    if (active === c._active) return;
    c._active = active;
    const editing = this.inEditMode(e);
    if (active) {
      if (!editing || c._activatesInEditMode) c._onActivate();
      if (c instanceof GameBehavior) {
        if (c.onEnable) this.invoke(c, "onEnable");
        if (!c._started && !this.pendingStart.includes(c)) {
          this.pendingStart.push(c);
          this.orderDirty = true;
        }
      }
    } else {
      if (!editing || c._activatesInEditMode) c._onDeactivate();
      if (c instanceof GameBehavior) {
        if (c.onDisable) this.invoke(c, "onDisable");
        this.cancelAsync(c);
      }
    }
  }

  /**
   * @internal Defer awake/onEnable for components created inside `fn` until it returns, then
   * run them in tree order. Used by the scene loader so references resolve before awake.
   */
  _batch<T>(fn: () => T): T {
    this.suspendDepth++;
    let result: T;
    try {
      result = fn();
    } finally {
      this.suspendDepth--;
    }
    if (this.suspendDepth === 0 && this.deferred.length) {
      const list = this.deferred;
      this.deferred = [];
      this.computeOrder();
      list.sort((a, b) => this.order[a._node.entity] - this.order[b._node.entity] || a._seq - b._seq);
      for (const c of list) this._refreshComponent(c);
    }
    return result;
  }

  // --- the frame (ADR 0011, 0160) ---------------------------------------------------------------

  /**
   * @internal Run one frame of this World by `dt` real seconds, with it as the current World, in
   * ADR 0011's order: begin frame (the clock), start() for new behaviors, fixed steps at the World's
   * own rate, update and lateUpdate, transform propagation, render sync and render to `surface`
   * (if any), then the end of frame: deferred destroys, buffers, and the work `atFrameEnd` queued.
   * The input snapshot (step 2) is the Engine's: one per Engine frame, shared by its Worlds.
   * `timings`, when given, gets the fixed, update and render phases' durations in milliseconds.
   */
  step(dt: number, frame: WorldFrame = {}): void {
    const { surface, timings } = frame;
    const time = this.time;
    const settings = this.settings.time;
    const previous = World.active;
    World.active = this;
    this.framing = true;
    let mark = timings ? performance.now() : 0, fixedMs = 0, updateMs = 0;
    try {
      // 1. Begin frame
      this.advanceClock(dt);

      // 3. start() for newly enabled behaviors
      this._runPendingStarts();

      // 4. Fixed steps, at this World's own rate
      const fdt = time.fixedDeltaTime;
      if (time.timeScale > 0) {
        this._accumulator += time.deltaTime;
        let steps = 0;
        while (this._accumulator >= fdt && steps < settings.maxSubSteps) {
          time.fixedStepCount++;
          time.fixedTime += fdt;
          this._resolveWaits("fixed");
          this.scheduler.run("fixedUpdate", fdt);
          this._accumulator -= fdt;
          steps++;
        }
        if (steps === settings.maxSubSteps) this._accumulator = Math.min(this._accumulator, fdt);
      }
      time.fixedAlpha = fdt > 0 ? this._accumulator / fdt : 0;
      // Rendered Worlds show interpolating bodies between their last two fixed steps (ADR 0093).
      if (surface) _interpolateWorldServices(this, time.fixedAlpha);
      if (timings) [fixedMs, mark] = [performance.now() - mark, performance.now()];

      // 5–6. update and lateUpdate
      this._resolveWaits("update");
      this.scheduler.run("update", time.deltaTime);
      this.scheduler.run("lateUpdate", time.deltaTime);

      // 7. Transform propagation
      this._propagateTransforms();
      if (timings) [updateMs, mark] = [performance.now() - mark, performance.now()];

      // 8–9. Render sync and render
      if (surface) {
        surface.sync(this);
        surface.render(this);
      }
      timings?.(fixedMs, updateMs, performance.now() - mark);
    } finally {
      // 10. End of frame: deferred destroys, buffers, then scene loads and other deferred work
      this._flushDestroyed();
      this._clearBuffers();
      const ops = this.frameEndOps;
      this.frameEndOps = [];
      this.framing = false;
      try {
        for (const op of ops) op();
      } finally {
        World.active = previous;
      }
    }
  }

  /**
   * @internal Step 1 alone: advance the clock by `dt` real seconds (clamped to `maxFrameTime`, scaled
   * by `timeScale`) without running anything. `step` does this first; a World that's drawn but never
   * stepped (a thumbnail's) uses it so time-driven drawing (particles) moves.
   */
  advanceClock(dt: number): void {
    const time = this.time;
    time.realtimeSinceStartup += dt;
    time.unscaledDeltaTime = Math.min(Math.max(dt, 0), this.settings.time.maxFrameTime);
    time.deltaTime = time.unscaledDeltaTime * time.timeScale;
    time.time += time.deltaTime;
    time.frameCount++;
  }

  /**
   * @internal Draw this World to `surface` again without stepping (an edit while the game is paused):
   * transforms are propagated, then the surface is synced and rendered, with this World current.
   */
  redraw(surface: RenderSurface): void {
    World._runIn(this, () => {
      this._propagateTransforms();
      surface.sync(this);
      surface.render(this);
    });
  }

  /** @internal True while this World's frame runs: structural changes made now wait for its end. */
  get inFrame(): boolean {
    return this.framing;
  }

  /**
   * @internal Run `op` at the end of this World's frame (step 10, after deferred destroys) if its frame
   * is running, else now, with this World current. Scene loads, World tear-down.
   */
  atFrameEnd(op: () => void): void {
    if (this.framing) this.frameEndOps.push(op);
    else World._runIn(this, op);
  }

  /**
   * @internal Apply the deferred destroys and component removals requested so far: now outside a frame
   * (the editor, tests, between frames), at the end of the frame inside one, where step 10 applies them.
   */
  applyDestroys(): void {
    if (!this.framing) this._flushDestroyed();
  }

  /** @internal Step 3: call start() on behaviors enabled since the last frame. */
  _runPendingStarts(): void {
    if (!this.pendingStart.length) return;
    this.sortIfDirty();
    const list = this.pendingStart;
    this.pendingStart = [];
    for (const b of list) {
      if (b._destroyed || !b._active || b._started) continue;
      b._started = true;
      if (b.start) this.invoke(b, "start");
    }
  }

  /** @internal Run one per-frame hook on all active, started behaviors. */
  _runHook(hook: FrameHook): void {
    this.sortIfDirty();
    const list = this.hookLists[hook];
    const n = list.length; // behaviors added during this pass wait for the next one
    for (let i = 0; i < n; i++) {
      const b = list[i];
      if (b._active && b._started && !b._destroyed) this.invoke(b, hook);
    }
  }

  /** @internal Resolve engine-scheduled waits for a phase (ADR 0018). */
  _resolveWaits(phase: "update" | "fixed"): void {
    if (!this._waits.length) return;
    const t = this.time;
    const keep: PendingWait[] = [];
    const ready: PendingWait[] = [];
    for (const w of this._waits) {
      if (w.owner._destroyed || !w.owner._active) continue; // cancelled
      let done: boolean;
      if (phase === "fixed") done = w.kind === "fixed" && t.fixedStepCount > w.target;
      else if (w.kind === "seconds") done = t.time >= w.target;
      else if (w.kind === "realtime") done = t.realtimeSinceStartup >= w.target;
      else if (w.kind === "frame") done = t.frameCount > w.target;
      else if (w.kind === "until") done = safePredicate(w);
      else done = false;
      (done ? ready : keep).push(w);
    }
    this._waits = keep;
    for (const w of ready) w.resolve();
  }

  /**
   * @internal Tear the World down: destroy every node under the root now (scripts get
   * onDisable/onDestroy, audio stops, renderers release) and free the physics world.
   */
  _destroyAll(): void {
    for (const e of this.childEntities(0)) this._destroyNode(e);
    this._flushDestroyed();
    _disposeWorldServices(this); // reverse start order; a load finishing later starts nothing (ADR 0135)
    // Its connections and listen addresses go with it (a loopback address is page-wide).
    for (const t of this._transports) t.close();
    this._transports.clear();
  }

  /** @internal Step 10: apply deferred destroys and component removals. */
  _flushDestroyed(): void {
    while (this.destroyQueue.length) {
      const queue = this.destroyQueue;
      this.destroyQueue = [];
      for (const item of queue) {
        if (item instanceof Component) this.reallyRemoveComponent(item);
        else if (item.isValid) this.reallyDestroyNode(item.entity);
      }
    }
  }

  /** @internal Step 7: compute world matrices for every dirty transform. */
  _propagateTransforms(): void {
    for (let e = 0; e < this.highWater; e++) if (this.alive[e] && this.worldDirty[e]) this.computeWorld(e);
  }

  /** @internal */
  _clearBuffers(): void {
    for (const list of this.buffers.values()) list.length = 0;
  }

  // --- isolation (ADR 0032, T3) ---------------------------------------------------------------

  /**
   * @internal Throw if `value` is a node or component of another World. Engine APIs that store or
   * link a reference call this, since Worlds can't reach each other's nodes (ADR 0032).
   */
  _assertOwns(value: unknown, what: string): void {
    const other = value instanceof GameObject ? value.world : value instanceof Component ? value._node?.world : undefined;
    if (!other || other === this) return;
    const label = value instanceof GameObject ? String(value) : `${value!.constructor.name} component`;
    throw new Error(`${what}: ${label} belongs to World "${other.name}", not "${this.name}". Worlds are isolated; they exchange data only through a transport (ADR 0032).`);
  }

  /** @internal `_assertOwns` on each value of a record or array, one level deep (buffer records, component inits). */
  _assertOwnsAll(record: unknown, what: string): void {
    if (typeof record !== "object" || record === null) return;
    this._assertOwns(record, what);
    // No arrays allocated: this runs on every buffer push (physics events, gameplay records).
    const values = record as Record<string, unknown>;
    for (const key in values) {
      const v = values[key];
      if (typeof v !== "object" || v === null) continue;
      if (Array.isArray(v)) for (const item of v) this._assertOwns(item, what);
      else this._assertOwns(v, what);
    }
  }

  // --- transforms -------------------------------------------------------------------------

  /** @internal Mark a node's transform (and its subtree's world transforms) as changed. */
  markTransformDirty(e: number): void {
    if (this.firstChild[e] === NONE) {
      // A leaf (most moving nodes): no subtree to walk, so no stack to allocate.
      this.worldDirty[e] = 1;
      this.tVersion[e]++;
      return;
    }
    const stack = [e];
    while (stack.length) {
      const n = stack.pop()!;
      this.worldDirty[n] = 1;
      this.tVersion[n]++;
      for (let c = this.firstChild[n]; c !== NONE; c = this.nextSibling[c]) stack.push(c);
    }
  }

  /** @internal The world matrix storage (`array`, read at `e * 16`), computed on demand. */
  worldMatrix(e: number): Float32Array {
    if (this.worldDirty[e]) this.computeWorld(e);
    return this.tWorld;
  }

  /** @internal */
  transformOf(e: number): Transform | null {
    if (!this.hasTransform[e]) return null;
    let t = this.transformFacades[e];
    if (!t) this.transformFacades[e] = t = new Transform(this, e);
    return t;
  }

  /** @internal */
  _addTransform(e: number): Transform {
    if (!this.hasTransform[e]) {
      this.hasTransform[e] = 1;
      this.resetTransform(e);
      this.markTransformDirty(e);
    }
    return this.transformOf(e)!;
  }

  private computeWorld(e: number): void {
    const p = this.parentOf[e];
    if (p !== NONE && this.worldDirty[p]) this.computeWorld(p);
    const o = e * 16;
    if (this.hasTransform[e]) {
      if (p === NONE) {
        Mat4.compose(this.tWorld, o, this.tPos, e * 3, this.tRot, e * 4, this.tScl, e * 3);
      } else {
        Mat4.compose(this.scratch, 0, this.tPos, e * 3, this.tRot, e * 4, this.tScl, e * 3);
        Mat4.multiplyAffine(this.tWorld, o, this.tWorld, p * 16, this.scratch, 0);
      }
    } else if (p === NONE) {
      Mat4.identity(this.tWorld, o);
    } else {
      Mat4.copy(this.tWorld, o, this.tWorld, p * 16);
    }
    this.worldDirty[e] = 0;
  }

  // --- data components & buffers ------------------------------------------------------------

  /** @internal */
  _dataStore(def: DataComponentDef): DataStore {
    let s = this.dataStores.get(def);
    if (!s) this.dataStores.set(def, (s = new DataStore(def, this.capacity)));
    return s;
  }

  /** @internal */
  _singleData(def: DataComponentDef): object | null {
    const s = this.dataStores.get(def);
    if (!s) return null;
    for (const e of s.dense) if (this.inWorld[e]) return s.view(e);
    return null;
  }

  /** @internal */
  _buffer<T>(def: BufferDef<T>): T[] {
    let b = this.buffers.get(def as BufferDef<unknown>);
    if (!b) this.buffers.set(def as BufferDef<unknown>, (b = []));
    return b as T[];
  }

  /**
   * @internal A system query's rows (ADR 0064): the nodes active in the hierarchy (outside edit mode)
   * with every term, and accepted by `includes` (predicted systems), collected once into a buffer
   * reused by the same query next run.
   */
  _query(terms: readonly QueryTerm[], includes?: (node: GameObject) => boolean): Rows {
    const dataTerms = terms.filter((t): t is DataComponentDef => t !== Transform);
    const needsTransform = terms.includes(Transform);
    const stores = dataTerms.map((d) => this._dataStore(d));
    return new QueryRows(this, dataTerms, stores, () => {
      const smallest = stores.length ? stores.reduce((a, b) => (b.dense.length < a.dense.length ? b : a)) : null;
      const bound = smallest ? smallest.dense.length : this.highWater;
      let buffer = this.rowBuffers.get(terms);
      if (!buffer || buffer.length < bound) this.rowBuffers.set(terms, (buffer = new Int32Array(Math.max(16, bound * 1.5) | 0)));
      const out = buffer;
      let count = 0;
      const take = (e: number): void => {
        if (!this.alive[e] || !this.inWorld[e] || !this.activeInHierarchy[e]) return;
        if (needsTransform && !this.hasTransform[e]) return;
        for (const s of stores) if (!s.present[e]) return;
        if (this.inEditMode(e)) return;
        if (includes && !includes(this.handle(e))) return;
        out[count++] = e;
      };
      if (smallest) for (const e of smallest.dense) take(e);
      else for (let e = 1; e < this.highWater; e++) if (this.hasTransform[e]) take(e);
      return out.subarray(0, count);
    });
  }

  /** @internal For `QueryRows`: whether a collected row's node still exists. */
  isRowAlive(e: number): boolean {
    return this.alive[e] === 1;
  }

  // --- internals ----------------------------------------------------------------------------

  private invoke(b: GameBehavior, hook: keyof GameBehavior): void {
    if (this.inEditMode(b._node.entity)) return; // scripts don't run in a scene being edited (ADR 0026)
    try {
      const result = (b[hook] as () => unknown).call(b);
      if (result instanceof Promise) {
        result.catch((err) => console.error(`[myco] ${b.constructor.name}.${String(hook)} rejected:`, err));
      }
    } catch (err) {
      console.error(`[myco] ${b.constructor.name}.${String(hook)} threw:`, err);
    }
  }

  private cancelAsync(b: GameBehavior): void {
    if (this._waits.length) this._waits = this._waits.filter((w) => w.owner !== b);
    if (b._abort) {
      b._abort.abort();
      b._abort = null;
    }
  }

  private reallyRemoveComponent(c: Component): void {
    if (c._destroyed) return;
    if (c._active) {
      c._active = false;
      if (!this.inEditMode(c._node.entity) || c._activatesInEditMode) c._onDeactivate();
      if (c instanceof GameBehavior && c.onDisable) this.invoke(c, "onDisable");
    }
    if (c instanceof GameBehavior) {
      if (c._awoken && c.onDestroy) this.invoke(c, "onDestroy");
      this.cancelAsync(c);
      for (const hook of FRAME_HOOKS) removeItem(this.hookLists[hook], c);
      removeItem(this.pendingStart, c);
    }
    c._onDetach();
    c._destroyed = true;
    const e = c._node.entity;
    removeItem(this.componentsOf[e], c);
    for (let t: Function | null = c.constructor; t && t !== Component && t !== Object; t = Object.getPrototypeOf(t)) {
      const list = this.byType.get(t);
      if (list) removeItem(list, c);
    }
  }

  private reallyDestroyNode(e: number): void {
    for (const child of this.childEntities(e)) this.reallyDestroyNode(child);
    if (this.isSceneNode(e)) this.sceneNodeCount--;
    const comps = this.componentsOf[e];
    for (let i = comps.length - 1; i >= 0; i--) this.reallyRemoveComponent(comps[i]);
    for (const store of this.dataStores.values()) store.remove(e);
    this.unlink(e);
    this.alive[e] = 0;
    this.generations[e]++;
    this.handles[e] = undefined;
    this.transformFacades[e] = undefined;
    this.componentsOf[e] = [];
    this.free.push(e);
    this.orderDirty = true;
  }

  private allocate(name: string, transform: boolean): number {
    let e = this.free.pop();
    if (e === undefined) {
      if (this.highWater >= this.capacity) this.grow(this.capacity * 2);
      e = this.highWater++;
    }
    this.alive[e] = 1;
    this.parentOf[e] = this.firstChild[e] = this.lastChild[e] = this.nextSibling[e] = this.prevSibling[e] = NONE;
    this.flags[e] = 0;
    this.activeSelf[e] = 1;
    this.activeInHierarchy[e] = 0;
    this.inWorld[e] = 0;
    this.names[e] = name;
    this.ids[e] = "";
    this.tags[e] = [];
    this.componentsOf[e] = [];
    this.hasTransform[e] = transform ? 1 : 0;
    this.resetTransform(e);
    this.worldDirty[e] = 1;
    return e;
  }

  private resetTransform(e: number): void {
    this.tPos.fill(0, e * 3, e * 3 + 3);
    this.tRot.fill(0, e * 4, e * 4 + 4);
    this.tRot[e * 4 + 3] = 1;
    this.tScl.fill(1, e * 3, e * 3 + 3);
  }

  private link(e: number, parent: number): void {
    this.parentOf[e] = parent;
    if (parent === NONE) return;
    const last = this.lastChild[parent];
    this.prevSibling[e] = last;
    this.nextSibling[e] = NONE;
    if (last === NONE) this.firstChild[parent] = e;
    else this.nextSibling[last] = e;
    this.lastChild[parent] = e;
    this.orderDirty = true;
  }

  private unlink(e: number): void {
    const p = this.parentOf[e];
    if (p === NONE) return;
    const prev = this.prevSibling[e], next = this.nextSibling[e];
    if (prev === NONE) this.firstChild[p] = next;
    else this.nextSibling[prev] = next;
    if (next === NONE) this.lastChild[p] = prev;
    else this.prevSibling[next] = prev;
    this.parentOf[e] = this.prevSibling[e] = this.nextSibling[e] = NONE;
  }

  /** Recompute activeInHierarchy / inWorld for a subtree and refresh component states. */
  private refreshActive(e: number): void {
    const stack = [e];
    const changed: number[] = [];
    while (stack.length) {
      const n = stack.pop()!;
      const p = this.parentOf[n];
      const inWorld = n === 0 ? 1 : p !== NONE && this.inWorld[p] ? 1 : 0;
      const active = this.activeSelf[n] && (n === 0 || (p !== NONE && this.activeInHierarchy[p])) ? 1 : 0;
      if (inWorld !== this.inWorld[n] || active !== this.activeInHierarchy[n]) {
        this.inWorld[n] = inWorld;
        this.activeInHierarchy[n] = active;
        changed.push(n);
      }
      for (let c = this.firstChild[n]; c !== NONE; c = this.nextSibling[c]) stack.push(c);
    }
    for (const n of changed) for (const c of [...this.componentsOf[n]]) this._refreshComponent(c);
  }

  private computeOrder(): void {
    let i = 0;
    const stack = [0];
    while (stack.length) {
      const n = stack.pop()!;
      this.order[n] = i++;
      const kids = this.childEntities(n);
      for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
    }
    this.orderDirty = false;
  }

  private sortIfDirty(): void {
    if (!this.orderDirty) return;
    this.computeOrder();
    const cmp = (a: GameBehavior, b: GameBehavior) =>
      ((a.constructor as typeof GameBehavior).executionOrder - (b.constructor as typeof GameBehavior).executionOrder) ||
      this.order[a._node.entity] - this.order[b._node.entity] ||
      a._seq - b._seq;
    for (const hook of FRAME_HOOKS) this.hookLists[hook].sort(cmp);
    this.pendingStart.sort(cmp);
  }

  private grow(capacity: number): void {
    const u8 = (a: Uint8Array) => { const n = new Uint8Array(capacity); n.set(a); return n; };
    const i32 = (a: Int32Array) => { const n = new Int32Array(capacity).fill(NONE); n.set(a); return n; };
    const f32 = (a: Float32Array, stride: number) => { const n = new Float32Array(capacity * stride); n.set(a); return n; };
    this.generations = (() => { const n = new Uint32Array(capacity); n.set(this.generations); return n; })();
    this.tVersion = (() => { const n = new Uint32Array(capacity); n.set(this.tVersion); return n; })();
    this.alive = u8(this.alive);
    this.flags = u8(this.flags);
    this.activeSelf = u8(this.activeSelf);
    this.activeInHierarchy = u8(this.activeInHierarchy);
    this.inWorld = u8(this.inWorld);
    this.hasTransform = u8(this.hasTransform);
    this.worldDirty = u8(this.worldDirty);
    this.parentOf = i32(this.parentOf);
    this.firstChild = i32(this.firstChild);
    this.lastChild = i32(this.lastChild);
    this.nextSibling = i32(this.nextSibling);
    this.prevSibling = i32(this.prevSibling);
    this.order = i32(this.order);
    this.tPos = f32(this.tPos, 3);
    this.tRot = f32(this.tRot, 4);
    this.tScl = f32(this.tScl, 3);
    this.tWorld = f32(this.tWorld, 16);
    this.capacity = capacity;
    for (const t of this.transformFacades) t?._rebind();
    for (const s of this.dataStores.values()) s.grow(capacity);
  }
}

// Script hooks as built-in catalog systems, in every World (ADR 0011, 0032).
defineBuiltinSystem({ name: "engine.FixedUpdateScripts", phase: "fixedUpdate", run: (w) => w._runHook("fixedUpdate") });
defineBuiltinSystem({ name: "engine.UpdateScripts", phase: "update", run: (w) => w._runHook("update") });
defineBuiltinSystem({ name: "engine.LateUpdateScripts", phase: "lateUpdate", run: (w) => w._runHook("lateUpdate") });

function removeItem<T>(list: T[], item: T): void {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
}

function safePredicate(w: PendingWait): boolean {
  try {
    return !!w.predicate?.();
  } catch (err) {
    console.error("[myco] wait.until predicate threw:", err);
    return true;
  }
}

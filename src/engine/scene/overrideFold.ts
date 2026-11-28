/**
 * The prefab-override fold (ADR 0280): the one place that knows what a scene or prefab file plus
 * its instances' overrides (ADR 0013, 0028, 0029, 0033, 0042, 0086, 0122) come to. It walks a
 * node list, expands prefab and scene instances, and applies every override kind, telling an
 * adapter each step: make this node, give it this component, rename it, drop that component...
 *
 * The fold owns the rules; adapters only build:
 *
 * - **Targeting.** An override's `target` names nodes by id, one id per instance level. A step into
 *   a nested instance is that instance's own override, applied after its own (`[n, x]` on the
 *   outer instance is `[x]` on instance `n`); an empty target, or one ending at a nested instance,
 *   is the instance's root.
 * - **Root aliasing.** A prefab's root is created at `[instance, rootId]` but addressed as
 *   `[instance]`; `worlds` overrides, which must be known before components exist, are matched
 *   through that alias.
 * - **`removeNode` / `addNodes` scope.** Removing a node drops it from its instance's id map; added
 *   nodes join the id map of the instance their target node belongs to, so later overrides of that
 *   instance can target them, and their ids must be new there.
 * - **Component index.** `index` counts the node's entries of that type as they stand when the
 *   override applies (after earlier `addComponent` and `removeComponent`), including entries an
 *   adapter left out (a per-World component, a missing script), so an index means the same in
 *   every World. `removeComponent` removes the first of its type; `addComponent` appends.
 * - **Order.** An `order` override arranges the node's behaviours (scripts and engine components);
 *   Transform and data components keep their slots.
 * - **Within one override:** `addNodes`, then name, tags, active, `removeComponent`,
 *   `addComponent`, `order`, `enabled`/`worlds`, then a field value.
 *
 * Adapters: the resolved scene view (`resolvedScene.ts`, plain entries), instantiation
 * (`SceneLoader.ts`, GameObjects and components) and the editor's prefab Apply (document commands).
 */
import { getDataComponentDef } from "../core/data";
import type { ComponentEntry, NodeEntry, OverrideEntry, SceneFile } from "./SceneLoader";
import { isScenePath } from "./scenePath";

/** A node's place in the fold: its id prefixed by the ids of the instances it sits in (`[instance, inner…]`). */
export type FoldPath = readonly string[];

/** Where an override is written: the instance entry's path and the override's position in its list. */
export interface OverrideHome {
  readonly instance: FoldPath;
  readonly override: number;
}

/** One id map of the fold (a file's nodes, an instance's inner nodes): what `{"$node"}` references and override targets resolve in. */
export type FoldScope<N> = ReadonlyMap<string, { readonly node: N }>;

/** How the fold was reached for one node entry. */
export interface NodeStep<N> {
  readonly entry: NodeEntry;
  readonly parent: N | undefined;
  readonly at: FoldPath;
  /** The file the entry is written in. */
  readonly source: string;
  /** True for an entry of an `addNodes` override. */
  readonly added: boolean;
}

/**
 * What one fold builds. `N` is the adapter's node, `C` its handle on one component entry. Every
 * step but `node` and `component` has a no-op default.
 */
export interface FoldAdapter<N, C> {
  /** The parsed file at `path` (a prefab or scene an entry instances), or undefined when it can't be read. */
  load(path: string, step: NodeStep<N>): SceneFile | { nodes?: unknown } | undefined;
  /** A plain node, with its entry's own name, active flag and tags. */
  node(step: NodeStep<N>): N;
  /** The node a scene-file instance stands for (it holds the scene's top-level nodes). */
  sceneNode?(step: NodeStep<N>, scene: string): N | undefined;
  /** In place of an instance whose file can't be read: a node, or undefined to leave it out. */
  missing?(step: NodeStep<N>, file: string): N | undefined;
  /**
   * False to keep an instance entry folded: its file isn't expanded, and overrides aimed into it
   * go to `deferred` (the editor's Apply, which writes them onto that entry). Default: expand.
   */
  expand?(step: NodeStep<N>): boolean;
  /** A kept instance entry's node (when `expand` said false). */
  folded?(step: NodeStep<N>): N;
  /** An override aimed at or into a folded instance; `o.target` is relative to it. */
  deferred?(node: N, o: OverrideEntry, home: OverrideHome): void;
  /** Called once a node entry is done (an instance: after its overrides), with its path; an instance's root is reported as the instance. */
  placed?(node: N, at: FoldPath, step: NodeStep<N>): void;
  /**
   * A component entry: the handle the fold keeps for it, or undefined when it was left out (not in
   * this World, an unknown type). `worlds` is the entry's, or an instance's override for it.
   * `at` is the node's path (for problems); `home` is set for an `addComponent` override.
   */
  component(node: N, entry: ComponentEntry, worlds: readonly string[] | undefined, scope: FoldScope<N>, source: string, at: FoldPath, home?: OverrideHome): C | undefined;
  name?(node: N, name: string): void;
  tags?(node: N, tags: string[]): void;
  active?(node: N, active: boolean): void;
  removeNode?(node: N): void;
  removeComponent?(node: N, c: C): void;
  /** The node's component handles in their new order (an `order` override). */
  order?(node: N, ordered: readonly C[]): void;
  enabled?(node: N, c: C, enabled: boolean): void;
  worlds?(node: N, c: C, worlds: string[]): void;
  /** A field value. `c` is undefined for a Transform field on a node with no Transform entry (a scene node, a node with an implicit Transform). */
  field?(node: N, c: C | undefined, type: string, index: number, field: string, value: unknown, scope: FoldScope<N>, source: string): void;
  /** A problem a game stops on and the editor skips past (a missing target or component). */
  problem?(message: string, at: FoldPath, component?: ComponentEntry): void;
  /** A malformed file (duplicate ids, a missing parent, a prefab without one root, a prefab that contains itself). */
  invalid?(message: string): void;
}

interface Inst<N> {
  readonly node: N;
  /** The node it was created under (set by `file`), so removing a node can drop its descendants from the id map too. */
  parent?: N;
  /** The instance's id map (an instance only). */
  nested?: Map<string, Inst<N>>;
  /** Set on a folded instance entry (see `FoldAdapter.expand`). */
  readonly folded?: boolean;
  /** The path of the instance (an instance only): what its added nodes' paths start with. */
  readonly at?: FoldPath;
  /** For a prefab instance whose prefab's root is itself a folded instance: that one. */
  readonly root?: Inst<N>;
}

interface Slot<C> {
  readonly type: string;
  readonly handle: C | undefined;
}

/** The result of a fold: the top-level nodes and the id map of the file folded. */
export interface FoldResult<N> {
  readonly roots: N[];
  readonly scope: FoldScope<N>;
}

/**
 * A property one override sets on the node its target names (ADR 0287): the node's own name,
 * active flag, tags or behaviour order, or a switch, Worlds or field of its `index`-th component of
 * `type`. The fold applies overrides by these rules and the editor's override writer finds the
 * override to change by them, so the two can't disagree about which override sets what.
 */
export type OverrideProperty =
  | { readonly kind: "name" }
  | { readonly kind: "active" }
  | { readonly kind: "tags" }
  | { readonly kind: "order" }
  | { readonly kind: "enabled"; readonly type: string; readonly index: number }
  | { readonly kind: "worlds"; readonly type: string; readonly index: number }
  | { readonly kind: "field"; readonly type: string; readonly index: number; readonly field: string };

/** True if two override targets are the same (an omitted target equals `[]`). */
export function sameTarget(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [], y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** The component an override names (`component`, and `index`, 0 when absent), or undefined. */
export function overrideComponent(o: OverrideEntry): { readonly type: string; readonly index: number } | undefined {
  return typeof o.component === "string" ? { type: o.component, index: typeof o.index === "number" ? o.index : 0 } : undefined;
}

/**
 * True if override `o` sets property `p` (whatever its target). A switch or Worlds is read only
 * from an override without a `field`: with one, the override sets that field and nothing else of
 * the component.
 */
export function setsProperty(o: OverrideEntry, p: OverrideProperty): boolean {
  switch (p.kind) {
    case "name":
      return typeof o.name === "string";
    case "active":
      return typeof o.active === "boolean";
    case "tags":
      return Array.isArray(o.tags);
    case "order":
      return Array.isArray(o.order);
  }
  const c = overrideComponent(o);
  if (!c || c.type !== p.type || c.index !== p.index) return false;
  if (p.kind === "field") return o.field === p.field;
  if (o.field !== undefined) return false;
  return p.kind === "enabled" ? typeof o.enabled === "boolean" : Array.isArray(o.worlds);
}

const NAME = { kind: "name" } as const;
const ACTIVE = { kind: "active" } as const;
const TAGS = { kind: "tags" } as const;
const ORDER = { kind: "order" } as const;

const MAX_DEPTH = 32;
const TRANSFORM = "engine.Transform";
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** True for component types an `order` override arranges: behaviours, not Transform or data components. */
const ordered = (type: string) => type !== TRANSFORM && getDataComponentDef(type) === undefined;

/**
 * `list` arranged by an `order` override: the listed types first in that order (a type repeated
 * for several entries), then the rest in their order, all in the slots behaviours fill.
 */
function arrange<T extends { type: string }>(list: readonly T[], order: readonly string[]): T[] {
  const slots = list.flatMap((c, i) => (ordered(c.type) ? [i] : []));
  const pool = slots.map((i) => list[i]);
  const first: T[] = [];
  for (const type of order) {
    const at = pool.findIndex((c) => c.type === type);
    if (at >= 0) first.push(...pool.splice(at, 1));
  }
  const next = [...list];
  [...first, ...pool].forEach((c, k) => (next[slots[k]] = c));
  return next;
}

class Fold<N, C> {
  private prefix: string[] = [];
  /** Files being expanded, outermost first (a prefab that contains itself is refused). */
  private stack: string[] = [];
  /** `worlds` overrides by node path, component type and index (`a/b#type#0`); outer instances' are recorded first and win. */
  private readonly worldsOverrides = new Map<string, string[]>();
  /** A prefab root's node path → its instance's path, which overrides address with an empty target. */
  private readonly rootAliases = new Map<string, string>();
  /** Each node's component entries as the fold has applied them. */
  private readonly slots = new Map<N, Slot<C>[]>();

  constructor(private readonly a: FoldAdapter<N, C>, top: string) {
    this.stack.push(top);
  }

  private problem(message: string, at: FoldPath, component?: ComponentEntry): void {
    this.a.problem?.(message, at, component);
  }

  /** Create the nodes of `list` under `parent`. */
  file(list: readonly unknown[], parent: N | undefined, path: string, added = false): { roots: N[]; ids: Map<string, Inst<N>> } {
    const ids = new Map<string, Inst<N>>();
    const roots: N[] = [];
    const pending = list.filter((n): n is NodeEntry => isObject(n) && typeof n.id === "string");
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      for (let i = 0; i < pending.length; i++) {
        const entry = pending[i];
        const parentId = typeof entry.parent === "string" && entry.parent ? entry.parent : undefined;
        if (parentId !== undefined && !ids.has(parentId)) continue; // parent not created yet
        pending.splice(i--, 1);
        progress = true;
        if (ids.has(entry.id)) {
          this.a.invalid?.(`${path}: duplicate node id "${entry.id}".`);
          continue;
        }
        const step: NodeStep<N> = { entry, parent: parentId !== undefined ? ids.get(parentId)!.node : parent, at: [...this.prefix, entry.id], source: path, added };
        const inst = this.node(step, ids);
        if (!inst) continue;
        inst.parent = step.parent;
        ids.set(entry.id, inst);
        this.a.placed?.(inst.node, step.at, step);
        if (parentId === undefined) roots.push(inst.node);
      }
    }
    if (pending.length) this.a.invalid?.(`${path}: node(s) ${pending.map((n) => `"${n.id}"`).join(", ")} reference a missing parent.`);
    return { roots, ids };
  }

  private node(step: NodeStep<N>, scope: Map<string, Inst<N>>): Inst<N> | undefined {
    const { entry, at } = step;
    if (typeof entry.prefab !== "string") {
      const node = this.a.node(step);
      this.slots.set(node, []);
      const counts = new Map<string, number>();
      for (const c of Array.isArray(entry.components) ? entry.components : []) {
        if (!isObject(c) || typeof c.type !== "string") continue;
        const index = counts.get(c.type) ?? 0;
        counts.set(c.type, index + 1);
        this.add(node, c, this.worldsOverride(at, c.type, index) ?? c.worlds, scope, step.source, at);
      }
      return { node };
    }
    const prefabPath = entry.prefab;
    if (this.a.expand?.(step) === false) {
      const node = this.a.folded!(step);
      return { node, folded: true };
    }
    if (this.stack.includes(prefabPath) || this.stack.length >= MAX_DEPTH) {
      this.a.invalid?.(`${prefabPath}: a prefab can't contain itself (through "${step.source}").`);
      return undefined;
    }
    const prefab = this.a.load(prefabPath, step);
    if (!isObject(prefab) || !Array.isArray(prefab.nodes)) {
      const node = this.a.missing?.(step, prefabPath);
      return node === undefined ? undefined : { node };
    }
    const nodes = prefab.nodes as unknown[];
    const scene = isScenePath(prefabPath);
    let container: N | undefined;
    if (scene) {
      container = this.a.sceneNode?.(step, prefabPath);
      if (container === undefined) return undefined;
      this.slots.set(container, []);
    }
    this.noteWorldsOverrides(entry, nodes, at, scene);
    this.prefix.push(entry.id);
    this.stack.push(prefabPath);
    let created: { roots: N[]; ids: Map<string, Inst<N>> };
    try {
      created = this.file(nodes, container ?? step.parent, prefabPath);
    } finally {
      this.prefix.pop();
      this.stack.pop();
    }
    const { roots, ids } = created;
    if (!scene && roots.length !== 1) this.a.invalid?.(`${prefabPath}: a prefab must have exactly one top-level node (has ${roots.length}).`);
    const node = container ?? roots[0];
    if (node === undefined) return undefined;
    if (entry.name) this.a.name?.(node, entry.name);
    if (entry.tags) this.a.tags?.(node, entry.tags);
    if (entry.active === false) this.a.active?.(node, false);
    const rootInst = scene ? undefined : [...ids.values()].find((i) => i.node === node && i.folded);
    const inst: Inst<N> = { node, nested: ids, at, ...(rootInst ? { root: rootInst } : {}) };
    const overrides = Array.isArray(entry.overrides) ? entry.overrides : [];
    overrides.forEach((o, i) => {
      if (isObject(o)) this.route(inst, o, { instance: at, override: i }, scope, step.source);
    });
    return inst;
  }

  /**
   * Record an instance's `worlds` overrides before its prefab's nodes are created, since they
   * decide whether a component is created at all. Outer instances' overrides win over nested
   * ones (they're recorded first).
   */
  private noteWorldsOverrides(entry: NodeEntry, nodes: readonly unknown[], at: FoldPath, scene: boolean): void {
    if (!scene) {
      const root = nodes.find((n): n is NodeEntry => isObject(n) && typeof n.id === "string" && !n.parent);
      if (root) this.rootAliases.set([...at, root.id].join("/"), at.join("/"));
    }
    for (const o of Array.isArray(entry.overrides) ? entry.overrides : []) {
      const c = isObject(o) ? overrideComponent(o) : undefined;
      if (!c || !setsProperty(o, { kind: "worlds", ...c })) continue;
      const key = `${[...at, ...(Array.isArray(o.target) ? (o.target as string[]) : [])].join("/")}#${c.type}#${c.index}`;
      if (!this.worldsOverrides.has(key)) this.worldsOverrides.set(key, o.worlds!);
    }
  }

  /** A `worlds` override for component `index` of `type` on the node at `at`, if an instance set one. */
  private worldsOverride(at: FoldPath, type: string, index: number): string[] | undefined {
    if (this.worldsOverrides.size === 0) return undefined;
    let key: string | undefined = at.join("/");
    while (key !== undefined) {
      const found = this.worldsOverrides.get(`${key}#${type}#${index}`);
      if (found) return found;
      key = this.rootAliases.get(key);
    }
    return undefined;
  }

  private add(node: N, c: ComponentEntry, worlds: readonly string[] | undefined, scope: FoldScope<N>, source: string, at: FoldPath, home?: OverrideHome): void {
    const handle = this.a.component(node, c, worlds, scope, source, at, home);
    this.slots.get(node)?.push({ type: c.type, handle });
  }

  /** Send override `o` (target relative to `inst`) to the node it names. */
  private route(inst: Inst<N>, o: OverrideEntry, home: OverrideHome, scope: Map<string, Inst<N>>, source: string): void {
    if (inst.folded) return this.a.deferred?.(inst.node, o, home);
    const target = Array.isArray(o.target) ? o.target : [];
    const at = [...inst.at!, ...target];
    if (target.length === 0) {
      if (o.removeNode === true) return this.problem(`${source}: a removeNode override needs a target (the instance itself can't be removed this way).`, at);
      if (inst.root) return this.a.deferred?.(inst.root.node, o, home);
      return this.apply(inst, inst.node, o, home, scope, source, at);
    }
    const [first, ...rest] = target;
    const next = inst.nested?.get(first);
    if (!next || (rest.length > 0 && !next.nested && !next.folded)) return this.problem(`${source}: override target "${target.join("/")}" not found in prefab instance.`, at);
    if (rest.length === 0 && o.removeNode === true) {
      this.a.removeNode?.(next.node);
      dropSubtree(inst.nested!, first);
      return;
    }
    // Into a nested instance (or at its root): that instance's override, after its own.
    if (next.nested || next.folded) return this.route(next, { ...o, target: rest }, home, scope, source);
    this.apply(inst, next.node, o, home, scope, source, at);
  }

  /** Apply override `o` to `node`, which belongs to instance `container`. */
  private apply(container: Inst<N>, node: N, o: OverrideEntry, home: OverrideHome, scope: Map<string, Inst<N>>, source: string, at: FoldPath): void {
    if (Array.isArray(o.addNodes)) this.addNodes(o.addNodes, node, container, source, at);
    if (setsProperty(o, NAME)) this.a.name?.(node, o.name!);
    if (setsProperty(o, TAGS)) this.a.tags?.(node, o.tags!);
    if (setsProperty(o, ACTIVE)) this.a.active?.(node, o.active!);
    const list = this.slots.get(node) ?? [];
    if (typeof o.removeComponent === "string") {
      const i = list.findIndex((c) => c.type === o.removeComponent);
      if (i >= 0) {
        const [gone] = list.splice(i, 1);
        if (gone.handle !== undefined) this.a.removeComponent?.(node, gone.handle);
      }
    }
    if (isObject(o.addComponent) && typeof o.addComponent.type === "string") this.add(node, o.addComponent, o.addComponent.worlds, scope, source, at, home);
    if (setsProperty(o, ORDER)) {
      const next = arrange(list, o.order!);
      list.splice(0, list.length, ...next);
      this.a.order?.(node, next.flatMap((c) => (c.handle === undefined ? [] : [c.handle])));
    }
    const named = overrideComponent(o);
    if (!named) return;
    const { index } = named;
    const slot = list.filter((c) => c.type === named.type)[index];
    if (o.field === undefined) {
      const enabled = setsProperty(o, { kind: "enabled", ...named });
      if (!slot) {
        // A `worlds` override alone may name a component this file doesn't have in every case; only a switch is a problem.
        if (enabled) this.problem(`${source}: override targets missing component "${o.component}".`, at);
        return;
      }
      if (slot.handle === undefined) return;
      if (enabled) this.a.enabled?.(node, slot.handle, o.enabled!);
      if (setsProperty(o, { kind: "worlds", ...named })) this.a.worlds?.(node, slot.handle, o.worlds!);
      return;
    }
    if (typeof o.field !== "string") return;
    if (!slot) {
      if (named.type === TRANSFORM) this.a.field?.(node, undefined, named.type, index, o.field, o.value, scope, source);
      else if (getDataComponentDef(named.type) === undefined) this.problem(`${source}: override targets missing component "${named.type}".`, at);
      return;
    }
    if (slot.handle !== undefined) this.a.field?.(node, slot.handle, named.type, index, o.field, o.value, scope, source);
  }

  /** An `addNodes` override: create the nodes under `parent`, and register their ids in `container` so later overrides can target them. */
  private addNodes(nodes: readonly unknown[], parent: N, container: Inst<N>, source: string, at: FoldPath): void {
    container.nested ??= new Map();
    const taken = nodes.find((n): n is NodeEntry => isObject(n) && typeof n.id === "string" && container.nested!.has(n.id));
    if (taken) return this.problem(`${source}: added node id "${taken.id}" is already used in prefab instance.`, at);
    const previous = this.prefix;
    this.prefix = [...container.at!];
    try {
      const { ids } = this.file(nodes, parent, source, true);
      for (const [id, inst] of ids) container.nested.set(id, inst);
    } finally {
      this.prefix = previous;
    }
  }
}

/** Remove `id` and every entry under it (by `parent`, an added node's included) from an instance's id map. */
function dropSubtree<N>(ids: Map<string, Inst<N>>, id: string): void {
  const gone = new Set<N>([ids.get(id)!.node]);
  ids.delete(id);
  for (let more = true; more; ) {
    more = false;
    for (const [key, inst] of ids) {
      if (inst.parent === undefined || !gone.has(inst.parent)) continue;
      gone.add(inst.node);
      ids.delete(key);
      more = true;
    }
  }
}

/**
 * Fold the node list `nodes` of the file at `path` (its instances expanded, their overrides
 * applied) into `adapter`, under `parent`.
 */
export function foldNodes<N, C>(adapter: FoldAdapter<N, C>, nodes: readonly unknown[], parent: N | undefined, path: string): FoldResult<N> {
  const fold = new Fold(adapter, path);
  const { roots, ids } = fold.file(nodes, parent, path);
  return { roots, scope: ids };
}

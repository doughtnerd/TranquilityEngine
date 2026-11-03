/**
 * Scene and prefab files (ADR 0013, 0016). Scenes and prefabs share one JSON format; a prefab
 * is a scene file with a single root node, instanced inside another scene or at runtime.
 */
import { Component } from "../core/Component";
import { getDataComponentDef } from "../core/data";
import { Color, Quaternion, Vector2, Vector3 } from "../core/math";
import { AssetRef, PlainObject, component, field, getComponentClass, getComponentId, getFields, isListType, type ComponentClass, type FieldInfo, type ScalarFieldType } from "../core/registry";
import type { World } from "../core/World";
import { Assets } from "./Assets";
import { GameObject, _componentAllowedIn, type InstantiateOptions } from "./GameObject";

export const SCENE_FORMAT = "myco.scene";
export const CURRENT_FORMAT_VERSION = 1;

export interface ComponentEntry {
  type: string;
  /** Start disabled (GameBehaviors and built-ins). */
  enabled?: boolean;
  data?: Record<string, unknown>;
  /**
   * Tags of the Worlds this instance is created in (ADR 0033 §3), overriding the component's own
   * `worlds` option. Works for data components too. Omitted: the component's option, else every World.
   */
  worlds?: string[];
}

export interface OverrideEntry {
  /** Path of node ids inside the prefab instance; empty or omitted targets the instance root. */
  target?: string[];
  name?: string;
  active?: boolean;
  /** Component id for a field override, e.g. `engine.Transform`. */
  component?: string;
  /** Which component of that type, when a node has several. */
  index?: number;
  field?: string;
  value?: unknown;
  /** With `component` (and `index`) but no `field`: start that component enabled or disabled (ADR 0028). */
  enabled?: boolean;
  /**
   * With `component` (and `index`) but no `field`: the tags of the Worlds that component is
   * created in, replacing the prefab entry's `worlds` (ADR 0033 §3, 0038). `["*"]` is every World.
   */
  worlds?: string[];
  /** The node's tags, replacing the prefab's (ADR 0042). */
  tags?: string[];
  /**
   * The order of the node's components, as component ids (repeated for several of a type). Ones
   * not listed follow, in their order; listed ones that aren't there are skipped (ADR 0029).
   */
  order?: string[];
  addComponent?: ComponentEntry;
  removeComponent?: string;
}

export interface NodeEntry {
  id: string;
  name?: string;
  parent?: string | null;
  active?: boolean;
  tags?: string[];
  componentNode?: boolean;
  /** Set to false for nodes without a Transform (pure logic or grouping nodes). */
  transform?: boolean;
  components?: ComponentEntry[];
  prefab?: string;
  overrides?: OverrideEntry[];
}

export interface SceneFile {
  format: string;
  settings?: { physics?: "2d" | "3d" | "none" };
  nodes: NodeEntry[];
}

type Migration = (file: SceneFile) => SceneFile;
const migrations = new Map<number, Migration>();

/** Register an upgrade from format version `from` to `from + 1`. */
export function registerSceneMigration(from: number, migrate: Migration): void {
  migrations.set(from, migrate);
}

/** Parse the format header and run migrations up to the current version. */
export function migrateSceneFile(file: SceneFile, path = "<inline>"): SceneFile {
  // "tranquility.scene@N": the same format under the engine's former name (ADR 0037).
  const match = /^(?:myco|tranquility)\.scene@(\d+)$/.exec(file.format ?? "");
  if (!match) throw new Error(`${path}: missing or invalid "format" (expected "${SCENE_FORMAT}@${CURRENT_FORMAT_VERSION}").`);
  let version = Number(match[1]);
  if (version > CURRENT_FORMAT_VERSION) throw new Error(`${path}: format version ${version} is newer than this engine supports (${CURRENT_FORMAT_VERSION}).`);
  let out = file;
  while (version < CURRENT_FORMAT_VERSION) {
    const m = migrations.get(version);
    if (!m) throw new Error(`${path}: no migration registered from format version ${version}.`);
    out = m(out);
    version++;
  }
  return { ...out, format: `${SCENE_FORMAT}@${CURRENT_FORMAT_VERSION}` };
}

export function loadSceneFile(path: string): SceneFile {
  return migrateSceneFile(Assets.json<SceneFile>(path), path);
}

/**
 * True for scene files (`*.scene.json`). Instanced inside another scene, a scene becomes a scene
 * node holding its top-level nodes; any other file is a prefab, a single node instanced as itself.
 */
export function isScenePath(path: string): boolean {
  return path.toLowerCase().endsWith(".scene.json");
}

/** Display name for a scene file: `scenes/level-1.scene.json` → `level-1`. */
export function sceneName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.(scene\.)?json$/i, "");
}

/**
 * Marks a scene node: a node created from a scene file, holding that file's top-level nodes.
 * Loaded scenes sit under the World root; sub-scenes sit inside other scenes (ADR 0016).
 */
@component("engine.SceneInstance")
export class SceneInstance extends Component {
  @field(String) source = "";
}

interface Instance {
  node: GameObject;
  nested?: Map<string, Instance>;
}

interface Fixup {
  apply(resolve: (scope: Map<string, Instance>, id: string) => GameObject | null): void;
}

/** @internal Editor hooks for `instantiateFile` (ADR 0026). Runtime loads pass none. */
export interface InstantiateHooks {
  /**
   * Called for every node created, with its path of ids from the top-level file: `[id]` for a
   * node of the file itself, `[instanceId, innerId...]` for nodes inside a prefab instance (the
   * same shape as an override `target`, prefixed with the instance id). A prefab instance root
   * is reported again, last, as `[instanceId]`.
   */
  onNode?(node: GameObject, path: readonly string[]): void;
  /** Resolve a `$node` reference of the top-level file that isn't part of this instantiation. */
  resolveExternal?(id: string): GameObject | null;
  /**
   * When given, problems a game would stop on are reported here and skipped instead (the
   * editor, ADR 0030): a component of an unknown type (a script that was deleted or didn't load),
   * an override aimed at a missing component or node. `path` is the node's path, as for `onNode`.
   */
  onProblem?(message: string, path: readonly string[], component?: ComponentEntry): void;
}

class Instantiation {
  readonly fixups: Fixup[] = [];
  private prefix: string[] = [];
  private top: Map<string, Instance> | null = null;
  /** Path (as for `onNode`) of the node being filled in, for `onProblem`. */
  private at: readonly string[] = [];
  /** Components left out of this World (per-World components), by node. */
  private readonly skipped = new Map<GameObject, Set<string>>();
  /** `worlds` overrides from prefab instances, by node path, component id and index (`a/b#type#0`). */
  private readonly worldsOverrides = new Map<string, string[]>();
  /** A prefab root's node path → its instance's path, which overrides target with an empty `target`. */
  private readonly rootAliases = new Map<string, string>();
  constructor(readonly world: World, private readonly hooks: InstantiateHooks = {}) {}

  /** Stop on a problem, or (editor) report it so the caller can skip the thing and carry on. */
  private problem(message: string, component?: ComponentEntry): void {
    if (!this.hooks.onProblem) throw new Error(message);
    this.hooks.onProblem(message, this.at, component);
  }

  /** Create all nodes of `file` under `parent`; returns top-level nodes and the id map. */
  file(file: SceneFile, parent: GameObject, path: string): { roots: GameObject[]; ids: Map<string, Instance> } {
    const ids = new Map<string, Instance>();
    this.top ??= ids;
    const roots: GameObject[] = [];
    const pending = [...file.nodes];
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      for (let i = 0; i < pending.length; i++) {
        const entry = pending[i];
        if (entry.parent && !ids.has(entry.parent)) continue; // parent not created yet
        pending.splice(i--, 1);
        progress = true;
        const parentNode = entry.parent ? ids.get(entry.parent)!.node : parent;
        const inst = this.node(entry, parentNode, ids, path);
        if (ids.has(entry.id)) throw new Error(`${path}: duplicate node id "${entry.id}".`);
        ids.set(entry.id, inst);
        this.hooks.onNode?.(inst.node, [...this.prefix, entry.id]);
        if (!entry.parent) roots.push(inst.node);
      }
    }
    if (pending.length) throw new Error(`${path}: node(s) ${pending.map((n) => `"${n.id}"`).join(", ")} reference a missing parent.`);
    return { roots, ids };
  }

  private node(entry: NodeEntry, parent: GameObject, scope: Map<string, Instance>, path: string): Instance {
    if (entry.prefab && this.hooks.onProblem && !Assets.has(entry.prefab)) {
      // Editor: a prefab file that's gone shows as an empty node, so the rest of the scene loads.
      this.at = [...this.prefix, entry.id];
      this.problem(`${path}: prefab "${entry.prefab}" not found (deleted?); "${entry.name ?? entry.id}" shows as an empty node.`);
      const node = this.world._createNode(entry.name ?? entry.id, parent.entity, { transform: true, id: entry.id });
      if (entry.active === false) node.setActive(false);
      return { node };
    }
    if (entry.prefab) {
      const prefab = loadSceneFile(entry.prefab);
      // A prefab is a single node, and its instance is that node. A scene is not a node of its
      // own file: like SceneManager.load, its instance is a scene node holding the file's
      // top-level nodes (ADR 0016), here with a Transform so a sub-scene can be placed in its
      // parent scene. Overrides with an empty target apply to that scene node.
      let container: GameObject | null = null;
      if (isScenePath(entry.prefab)) {
        container = this.world._createNode(entry.name ?? sceneName(entry.prefab), parent.entity, { transform: true, id: entry.id });
        this.world.setSceneNode(container.entity);
        container.addBehavior(SceneInstance, { source: entry.prefab });
      }
      this.noteWorldsOverrides(entry, prefab);
      this.prefix.push(entry.id);
      let created: { roots: GameObject[]; ids: Map<string, Instance> };
      try {
        created = this.file(prefab, container ?? parent, entry.prefab);
      } finally {
        this.prefix.pop();
      }
      const { roots, ids } = created;
      if (!container && roots.length !== 1) throw new Error(`${entry.prefab}: a prefab must have exactly one top-level node (has ${roots.length}).`);
      const node = container ?? roots[0];
      this.world.ids[node.entity] = entry.id;
      if (entry.name) node.name = entry.name;
      if (entry.tags) node.tags = entry.tags;
      if (entry.active === false) node.setActive(false);
      const inst: Instance = { node, nested: ids };
      this.at = [...this.prefix, entry.id];
      for (const o of entry.overrides ?? []) this.override(inst, o, scope, path);
      return inst;
    }
    const node = this.world._createNode(entry.name ?? entry.id, parent.entity, { transform: entry.transform !== false, id: entry.id });
    if (entry.componentNode) this.world.setComponentNode(node.entity, true);
    if (entry.tags) node.tags = entry.tags;
    if (entry.active === false) node.setActive(false);
    this.at = [...this.prefix, entry.id];
    const counts = new Map<string, number>();
    for (const c of entry.components ?? []) {
      const index = counts.get(c.type) ?? 0;
      counts.set(c.type, index + 1);
      this.component(node, c, scope, path, this.worldsOverride(c.type, index));
    }
    return { node };
  }

  /**
   * Record an instance's `worlds` overrides before its prefab's nodes are created, since they
   * decide whether a component is created at all. Outer instances' overrides win over nested
   * ones (they're recorded first).
   */
  private noteWorldsOverrides(entry: NodeEntry, prefab: SceneFile): void {
    const base = [...this.prefix, entry.id];
    if (!isScenePath(entry.prefab!)) {
      const root = prefab.nodes.find((n) => !n.parent);
      if (root) this.rootAliases.set([...base, root.id].join("/"), base.join("/"));
    }
    for (const o of entry.overrides ?? []) {
      if (!o.component || o.field !== undefined || o.worlds === undefined) continue;
      const key = `${[...base, ...(o.target ?? [])].join("/")}#${o.component}#${o.index ?? 0}`;
      if (!this.worldsOverrides.has(key)) this.worldsOverrides.set(key, o.worlds);
    }
  }

  /** A `worlds` override for component `index` of `type` on the node being created, if an instance set one. */
  private worldsOverride(type: string, index: number): string[] | undefined {
    if (this.worldsOverrides.size === 0) return undefined;
    let key: string | undefined = this.at.join("/");
    while (key !== undefined) {
      const found = this.worldsOverrides.get(`${key}#${type}#${index}`);
      if (found) return found;
      key = this.rootAliases.get(key);
    }
    return undefined;
  }

  component(node: GameObject, entry: ComponentEntry, scope: Map<string, Instance>, path: string, worldsOverride?: readonly string[]): void {
    const data = entry.data ?? {};
    const worlds = worldsOverride ?? entry.worlds;
    if (entry.type === "engine.Transform") {
      applyTransform(node, data);
      return;
    }
    const def = getDataComponentDef(entry.type);
    if (def) {
      if (!_componentAllowedIn(this.world, undefined, worlds, entry.type)) return this.skip(node, entry.type);
      node.addData(def, data as Record<string, number>);
      return;
    }
    const type = getComponentClass(entry.type) as (new () => Component) | undefined;
    if (!type) {
      this.problem(`${path}: unknown component type "${entry.type}". Is the class imported and decorated with @behavior("${entry.type}")?`, entry);
      return;
    }
    // Per-World components (ADR 0033 §3): not created in other Worlds; overrides aimed at them are skipped too.
    if (!_componentAllowedIn(this.world, type, worlds, entry.type)) return this.skip(node, entry.type);
    const c = node.addBehavior(type);
    if (entry.enabled === false) c._enabled = false; // lifecycle is deferred until the batch ends
    this.fields(c, data, scope, path);
  }

  /** Note a component left out of this World, so overrides aimed at it are skipped rather than reported. */
  private skip(node: GameObject, id: string): void {
    let ids = this.skipped.get(node);
    if (!ids) this.skipped.set(node, (ids = new Set()));
    ids.add(id);
  }

  private wasSkipped(node: GameObject, id: string): boolean {
    return this.skipped.get(node)?.has(id) ?? false;
  }

  fields(c: Component, data: Record<string, unknown>, scope: Map<string, Instance>, path: string): void {
    const type = c.constructor as ComponentClass;
    const declared = getFields(type);
    for (const [key, raw] of Object.entries(data)) {
      const info = declared.find((f) => f.name === key);
      if (!info) {
        console.warn(`[myco] ${path}: "${key}" is not a declared field of ${getComponentId(type) ?? type.name}; ignored.`);
        continue;
      }
      assignField(c, info, raw, (id, assign) => this.fixups.push({ apply: (resolve) => assign(resolve(scope, id)) }), path);
    }
  }

  private override(inst: Instance, o: OverrideEntry, scope: Map<string, Instance>, path: string): void {
    let current = inst;
    for (const id of o.target ?? []) {
      const next = current.nested?.get(id);
      if (!next) {
        this.problem(`${path}: override target "${(o.target ?? []).join("/")}" not found in prefab instance.`);
        return;
      }
      current = next;
    }
    const node = current.node;
    const previous = this.at;
    this.at = [...this.at, ...(o.target ?? [])];
    try {
      this.applyOverride(node, o, scope, path);
    } finally {
      this.at = previous;
    }
  }

  private applyOverride(node: GameObject, o: OverrideEntry, scope: Map<string, Instance>, path: string): void {
    if (o.name !== undefined) node.name = o.name;
    if (o.tags !== undefined) node.tags = o.tags;
    if (o.active !== undefined) node.setActive(o.active);
    if (o.removeComponent) {
      const type = getComponentClass(o.removeComponent);
      const def = getDataComponentDef(o.removeComponent);
      if (def) node.removeData(def);
      else if (type) {
        const c = node.getBehavior(type as abstract new () => Component);
        if (c) this.world._removeComponentImmediate(c);
      }
    }
    if (o.addComponent) this.component(node, o.addComponent, scope, path);
    if (o.order) {
      const pool = [...this.world._componentsOf(node.entity)];
      const idOf = (c: Component) => getComponentId(c.constructor as ComponentClass);
      const ordered: Component[] = [];
      for (const id of o.order) {
        const at = pool.findIndex((c) => idOf(c) === id);
        if (at >= 0) ordered.push(...pool.splice(at, 1));
      }
      this.world._reorderComponents(node.entity, [...ordered, ...pool]);
    }
    if (o.component && o.field === undefined && o.enabled !== undefined) {
      const type = getComponentClass(o.component) as (abstract new () => Component) | undefined;
      const c = type ? node.getBehaviors(type)[o.index ?? 0] : undefined;
      if (c) c._enabled = o.enabled; // lifecycle is deferred until the batch ends
      else if (!this.wasSkipped(node, o.component)) this.problem(`${path}: override targets missing component "${o.component}".`);
    }
    if (o.component && o.field !== undefined) {
      if (o.component === "engine.Transform") {
        applyTransform(node, { [o.field]: o.value });
        return;
      }
      const def = getDataComponentDef(o.component);
      if (def) {
        const view = node.getData(def) as Record<string, number> | null;
        if (view) view[o.field] = Number(o.value);
        return;
      }
      const type = getComponentClass(o.component) as (abstract new () => Component) | undefined;
      const c = type ? node.getBehaviors(type)[o.index ?? 0] : undefined;
      if (c) this.fields(c, { [o.field]: o.value }, scope, path);
      else if (!this.wasSkipped(node, o.component)) this.problem(`${path}: override targets missing component "${o.component}".`);
    }
  }

  resolveFixups(): void {
    const resolve = (scope: Map<string, Instance>, id: string) => {
      const found = scope.get(id)?.node ?? (scope === this.top ? this.hooks.resolveExternal?.(id) : undefined);
      if (!found) console.warn(`[myco] node reference "${id}" not found.`);
      else this.world._assertOwns(found, `node reference "${id}"`); // never across Worlds (ADR 0032)
      return found ?? null;
    };
    for (const f of this.fixups) f.apply(resolve);
  }
}

/**
 * @internal Assign one serialized field value onto a component, converting it to the field's
 * declared type. `ref` receives `{"$node": id}` references and a setter to call with the node.
 */
export function assignField(
  c: Component,
  info: FieldInfo,
  raw: unknown,
  ref: (id: string, assign: (node: GameObject | null) => void) => void,
  path = "<inline>",
): void {
  const key = info.name;
  const target = c as unknown as Record<string, unknown>;
  const t = info.type;
  if (isListType(t)) {
    // A list field (ADR 0042): a new array, each item converted like a field of the item type.
    if (raw === null || raw === undefined) {
      target[key] = [];
      return;
    }
    if (!Array.isArray(raw)) {
      console.warn(`[myco] ${path}: field "${key}" expects a list (a JSON array).`);
      return;
    }
    const out: unknown[] = new Array(raw.length).fill(null);
    raw.forEach((item, i) => {
      // A reference may resolve right away (editor writes) or after the batch (loads); either way it fills its slot.
      const value = convertValue(t[0], item, null, (id) => ref(id, (node) => { out[i] = node; }), `${key}[${i}]`, path);
      if (value !== SKIP) out[i] = value;
    });
    target[key] = out;
    return;
  }
  const value = convertValue(t, raw, target[key], (id) => ref(id, (node) => { target[key] = node; }), key, path);
  if (value !== SKIP) target[key] = value;
}

/** Returned by `convertValue` when the field keeps its current value (updated in place, or a reference set later). */
const SKIP = Symbol("skip");

/**
 * One scene-file value converted to its declared type. Vectors and quaternions are copied into
 * `current` when it's a live view (the result is then SKIP); node references go to `ref`.
 */
function convertValue(t: ScalarFieldType, raw: unknown, current: unknown, ref: (id: string) => void, name: string, path: string): unknown {
  if (t === GameObject) {
    const r = raw as { $node?: string } | null;
    if (r === null || r === undefined) return null;
    if (typeof r.$node === "string") ref(r.$node);
    else console.warn(`[myco] ${path}: field "${name}" expects {"$node": "<id>"}.`);
    return SKIP;
  }
  if (t === Vector2) {
    if (raw === null) return null;
    if (current instanceof Vector2) return (current.copy(raw as number[]), SKIP);
    return Vector2.from(raw as number[]);
  }
  if (t === Vector3) {
    if (raw === null) return null;
    if (current instanceof Vector3) return (current.copy(raw as number[]), SKIP);
    return Vector3.from(raw as number[]);
  }
  if (t === Quaternion) {
    // Euler degrees `[x, y, z]` (as the editor writes it), or a raw quaternion `[x, y, z, w]`.
    if (raw === null) return null;
    const a = raw as number[];
    const q = a.length >= 4 ? new Quaternion(a[0], a[1], a[2], a[3]) : Quaternion.fromEuler(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
    if (current instanceof Quaternion) return (current.copy(q), SKIP);
    return q;
  }
  if (t === Color) return raw === null ? null : Color.from(raw as string);
  if (t === AssetRef) return typeof raw === "string" ? raw.replace(/^asset:/, "") : raw;
  if (t === PlainObject) return mergeDeep(current, raw);
  return raw;
}

/** @internal Apply Transform data from a scene file (`position`, `rotation`, `scale`). */
export function applyTransform(node: GameObject, data: Record<string, unknown>): void {
  const t = node.transform ?? node.world._addTransform(node.entity);
  if (data.position !== undefined) t.position = data.position as number[];
  if (data.rotation !== undefined) {
    // A number is a 2D angle; an array is Euler degrees [x, y, z].
    if (typeof data.rotation === "number") t.rotation2D = data.rotation;
    else t.eulerAngles = data.rotation as number[];
  }
  if (data.scale !== undefined) t.scale = data.scale as number[];
}

function mergeDeep(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return structuredClone(patch);
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = mergeDeep(out[k], v);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** @internal Instantiate every node of `file` under `parent`, then run awake/onEnable in tree order. */
export function instantiateFile(world: World, file: SceneFile, parent: GameObject, path: string, hooks?: InstantiateHooks): GameObject[] {
  world._assertOwns(parent, `${path}: parent`);
  return world._batch(() => {
    const job = new Instantiation(world, hooks);
    const { roots } = job.file(file, parent, path);
    job.resolveFixups();
    return roots;
  });
}

/** Roots of prefabs instantiated at runtime, and their prefab paths (handles are stable while a node lives). */
const instantiatedPrefabs = new WeakMap<GameObject, string>();

/**
 * @internal The prefab path `node` was instantiated from with `GameObject.instantiate`, if it's
 * the root of such an instance (replication spawns it on clients by that path, ADR 0033).
 */
export function _instantiatedPrefabOf(node: GameObject): string | undefined {
  return instantiatedPrefabs.get(node);
}

/** @internal Backs `GameObject.instantiate`. */
export function instantiatePrefab(world: World, path: string, options: InstantiateOptions): GameObject {
  world._assertOwns(options.parent, `${path}: parent`);
  const file = loadSceneFile(path);
  const parent = options.parent ?? world.activeScene ?? world.root;
  return world._batch(() => {
    const job = new Instantiation(world);
    const { roots } = job.file(file, parent, path);
    if (roots.length !== 1) throw new Error(`${path}: a prefab must have exactly one root node (has ${roots.length}).`);
    const root = roots[0];
    instantiatedPrefabs.set(root, path);
    if (options.name) root.name = options.name;
    const t = root.transform;
    if (t && options.position) t.position = Vector3.from(options.position);
    if (t && options.rotation2D !== undefined) t.rotation2D = options.rotation2D;
    job.resolveFixups();
    return root;
  });
}

/** Collect every `asset:` path referenced by a scene file and the prefabs it uses. */
export function collectAssetRefs(path: string, seen = new Set<string>(), out = new Set<string>()): Set<string> {
  if (seen.has(path)) return out;
  seen.add(path);
  const file = loadSceneFile(path);
  const walk = (v: unknown): void => {
    if (typeof v === "string" && v.startsWith("asset:")) out.add(v.slice(6));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isPlainObject(v)) Object.values(v).forEach(walk);
  };
  for (const n of file.nodes) {
    walk(n.components);
    walk(n.overrides);
    if (n.prefab) collectAssetRefs(n.prefab, seen, out);
  }
  return out;
}

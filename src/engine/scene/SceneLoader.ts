/**
 * Scene and prefab files (ADR 0013, 0016). Scenes and prefabs share one JSON format; a prefab
 * is a scene file with a single root node, instanced inside another scene or at runtime.
 */
import { migratePartPivots } from "./pivotMigration";
import { migrateRotationsToQuaternions } from "./rotationMigration";
import { migrateBallJointSwing } from "./ballJointMigration";
import { migrateToUnityCoordinates } from "./handednessMigration";
import { mapSceneFile } from "./sceneFileWalk";
import { Component } from "../core/Component";
import { getDataComponentDef, type DataComponentDef, type Schema } from "../core/data";
import { parseHex } from "../core/colorSpace";
import { Color, DEG2RAD, Quaternion, Vector2, Vector3 } from "../core/math";
import { AssetRef, PlainObject, _componentAliasVersion, component, field, getComponentClass, getComponentId, getFields, isListType, resolveComponentId, type ComponentClass, type FieldInfo, type ScalarFieldType } from "../core/registry";
import type { World } from "../core/World";
import { Assets } from "./Assets";
import { GameObject, UI_FROM_VIEWS, _componentAllowedIn, _viewOnlyComponentId, type InstantiateOptions } from "./GameObject";
import { assetRefs } from "./resolvedScene";
import { nodeRefId } from "./nodeReferences";
import { foldNodes, type FoldAdapter, type FoldPath, type FoldScope, type NodeStep } from "./overrideFold";
import { normalizeAssetPath } from "./assetPath";
import { sceneNodeName } from "./scenePath";

export const SCENE_FORMAT = "myco.scene";
/**
 * 2: model part references are node-pivoted by default; version 1 ones are pinned to model space (ADR 0118, `pivotMigration.ts`).
 * 3: Transform rotations are quaternions `[x, y, z, w]`; version 2 Euler angles are converted (ADR 0163, `rotationMigration.ts`).
 * 4: Unity's coordinates (left-handed, +Z forward); version 3 scenes are mirrored in z (ADR 0164, `handednessMigration.ts`).
 * 5: a BallJoint's `swingLimit: s` is `swing: { y: s, z: s }` (ADR 0375, `ballJointMigration.ts`).
 */
export const CURRENT_FORMAT_VERSION = 5;

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
  /**
   * Child nodes the instance adds (ADR 0086): a flat subtree in the file's own node shape. Nodes
   * with no `parent` become children of the node `target` names (the instance root when empty);
   * the others name a parent in this list. Their ids are scoped like the prefab's own, so later
   * overrides can target them, and they mustn't repeat an id of the prefab.
   */
  addNodes?: NodeEntry[];
  /** True: remove the node (and its subtree) that `target` names; `target` mustn't be empty (ADR 0086). */
  removeNode?: boolean;
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
  /** `preload` (ADR 0080): prefab and material files to warm up with the scene, for paths scripts compute at runtime. */
  settings?: { physics?: "2d" | "3d" | "none"; preload?: string[] };
  nodes: NodeEntry[];
}

type Migration = (file: SceneFile) => SceneFile;
const migrations = new Map<number, Migration>([
  [1, migratePartPivots],
  [2, migrateRotationsToQuaternions],
  [3, migrateToUnityCoordinates],
  [4, migrateBallJointSwing],
]);

/** Register an upgrade from format version `from` to `from + 1`. */
export function registerSceneMigration(from: number, migrate: Migration): void {
  migrations.set(from, migrate);
  migrated = new WeakMap(); // files read before were upgraded without it
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
  return { ...resolveComponentAliases(out), format: `${SCENE_FORMAT}@${CURRENT_FORMAT_VERSION}` };
}

/**
 * The file with every component id that is an alias (ADR 0439, `registerComponentAlias`) replaced by the id it names,
 * wherever the file names one (entries, overrides, added components and nodes). Applied whenever a file is read
 * (`migrateSceneFile`), so loading, prefab overrides and the editor's documents all see current ids, and a document
 * saves them.
 */
function resolveComponentAliases(file: SceneFile): SceneFile {
  return _componentAliasVersion() === 0 ? file : mapSceneFile(file, { type: resolveComponentId });
}

/**
 * Migrated files by their raw asset value (as `resolvedScene` caches by it): a file is upgraded once, not on every
 * load, prefab instance and `GameObject.instantiate`. A changed file is a new value (`Assets` sources replace it).
 */
let migrated = new WeakMap<object, { file: SceneFile; aliases: number }>();

/** The scene or prefab file at `path`, migrated to the current format. The result is shared: don't mutate it. */
export function loadSceneFile(path: string): SceneFile {
  const raw = Assets.json<SceneFile>(path);
  if (typeof raw !== "object" || raw === null) return migrateSceneFile(raw, path); // throws its format error
  const aliases = _componentAliasVersion();
  let entry = migrated.get(raw);
  // A component alias registered since (a plugin activated later) reads the file again.
  if (!entry || entry.aliases !== aliases) migrated.set(raw, (entry = { file: migrateSceneFile(raw, path), aliases }));
  return entry.file;
}

/**
 * Marks a scene node: a node created from a scene file, holding that file's top-level nodes.
 * Loaded scenes sit under the World root; sub-scenes sit inside other scenes (ADR 0016).
 */
@component("engine.SceneInstance")
export class SceneInstance extends Component {
  @field(String) source = "";
}

interface Fixup {
  apply(resolve: (scope: FoldScope<GameObject>, id: string) => GameObject | null): void;
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

/** The handle instantiation keeps on a Transform entry (the node's Transform, not a Component). */
const TRANSFORM_ENTRY = Symbol("transform");
/** Instantiation's handle on one component entry: a behaviour, a data component's definition, or the Transform. */
type Made = Component | DataComponentDef<Schema> | typeof TRANSFORM_ENTRY;

/**
 * Instantiation (ADR 0013, 0016): the prefab-override fold's adapter that makes GameObjects and
 * components in a World. The fold (`overrideFold.ts`, ADR 0280) decides what the file and its
 * overrides come to; this only builds it, converts field values, and resolves `{"$node"}`
 * references once every node exists.
 */
class Instantiation implements FoldAdapter<GameObject, Made> {
  readonly fixups: Fixup[] = [];
  /** Every node this instantiation created, in creation order (parents before their children). */
  private readonly made: GameObject[] = [];
  private top: FoldScope<GameObject> | null = null;
  constructor(readonly world: World, private readonly hooks: InstantiateHooks = {}) {}

  /** Create every node of `file` under `parent`; returns its top-level nodes. */
  file(file: SceneFile, parent: GameObject, path: string): GameObject[] {
    const { roots, scope } = foldNodes(this, file.nodes, parent, path);
    this.top = scope;
    return roots;
  }

  /** Take back what a failed instantiation made, so no half-built nodes stay in the World (or awake later). */
  discard(): void {
    for (const node of this.made) if (node.isValid) this.world._destroyNodeNow(node.entity);
  }

  /** Stop on a problem, or (editor) report it so the caller can skip the thing and carry on. */
  problem(message: string, at: FoldPath, component?: ComponentEntry): void {
    if (!this.hooks.onProblem) throw new Error(message);
    this.hooks.onProblem(message, at, component);
  }

  invalid(message: string): void {
    throw new Error(message);
  }

  load(path: string): SceneFile | undefined {
    // Editor: a prefab file that's gone shows as an empty node (`missing`), so the rest of the scene loads.
    if (this.hooks.onProblem && !Assets.has(path)) return undefined;
    return loadSceneFile(path);
  }

  missing(step: NodeStep<GameObject>, file: string): GameObject {
    const { entry } = step;
    this.problem(`${step.source}: prefab "${file}" not found (deleted?); "${entry.name ?? entry.id}" shows as an empty node.`, step.at);
    const node = this.world._createNode(entry.name ?? entry.id, step.parent!.entity, { transform: true, id: entry.id });
    this.made.push(node);
    if (entry.active === false) node.setActive(false);
    return node;
  }

  node({ entry, parent }: NodeStep<GameObject>): GameObject {
    const node = this.world._createNode(entry.name ?? entry.id, parent!.entity, { transform: entry.transform !== false, id: entry.id });
    this.made.push(node);
    if (entry.componentNode) this.world.setComponentNode(node.entity, true);
    if (entry.tags) node.tags = entry.tags;
    if (entry.active === false) node.setActive(false);
    return node;
  }

  /**
   * A scene is not a node of its own file: like SceneManager.load, its instance is a scene node
   * holding the file's top-level nodes (ADR 0016), here with a Transform so a sub-scene can be
   * placed in its parent scene. Overrides with an empty target apply to that scene node.
   */
  sceneNode({ entry, parent }: NodeStep<GameObject>, scene: string): GameObject {
    const container = this.world._createNode(entry.name ?? sceneNodeName(scene), parent!.entity, { transform: true, id: entry.id });
    this.made.push(container);
    this.world.setSceneNode(container.entity);
    container.addBehavior(SceneInstance, { source: scene });
    return container;
  }

  placed(node: GameObject, at: FoldPath, step: NodeStep<GameObject>): void {
    // A prefab instance is its prefab's root node, under the instance entry's id.
    if (step.entry.prefab) this.world.ids[node.entity] = step.entry.id;
    this.hooks.onNode?.(node, at);
  }

  component(node: GameObject, entry: ComponentEntry, worlds: readonly string[] | undefined, scope: FoldScope<GameObject>, source: string, at: FoldPath): Made | undefined {
    const data = entry.data ?? {};
    if (entry.type === "engine.Transform") {
      applyTransform(node, data);
      return TRANSFORM_ENTRY;
    }
    // Per-World components (ADR 0033 §3): not created in other Worlds; overrides aimed at them are skipped too.
    const def = getDataComponentDef(entry.type);
    if (def) {
      if (!_componentAllowedIn(this.world, undefined, worlds, entry.type)) return undefined;
      node.addData(def, data as Record<string, number>);
      return def;
    }
    // UI is made only by UI views (ADR 0421, 0423): saved UI components, the removed screen `Text` and `LocalizedText`
    // (matched by name, their classes are gone), and the retired `UIDocument` stop the load. No automatic migration.
    if (REMOVED_UI.has(entry.type)) {
      this.problem(`${source}: node "${nodePath(node)}" saves "${entry.type}", which was removed. ${UI_FROM_VIEWS}`, at, entry);
      return undefined;
    }
    if (RETIRED_DOCUMENTS.has(entry.type)) {
      this.problem(`${source}: node "${nodePath(node)}" saves "${entry.type}": UI documents (*.ui.xml, *.ui.css) were retired by ADR 0423. Write the UI as a Svelte component and mount it with a UIView.`, at, entry);
      return undefined;
    }
    const type = getComponentClass(entry.type) as (new () => Component) | undefined;
    if (type && _viewOnlyComponentId(type) !== null) {
      this.problem(`${source}: node "${nodePath(node)}" saves a UI component ("${entry.type}"). ${UI_FROM_VIEWS}`, at, entry);
      return undefined;
    }
    if (!type) {
      this.problem(`${source}: unknown component type "${entry.type}". Is the class imported and decorated with @behavior("${entry.type}")?`, at, entry);
      return undefined;
    }
    if (!_componentAllowedIn(this.world, type, worlds, entry.type)) return undefined;
    const c = node.addBehavior(type);
    if (entry.enabled === false) c._enabled = false; // lifecycle is deferred until the batch ends
    this.fields(c, data, scope, source);
    return c;
  }

  name(node: GameObject, name: string): void {
    node.name = name;
  }
  tags(node: GameObject, tags: string[]): void {
    node.tags = tags;
  }
  active(node: GameObject, active: boolean): void {
    node.setActive(active);
  }
  removeNode(node: GameObject): void {
    // This node only: flushing the World's whole destroy queue here would, during a frame (a prefab spawned
    // from a script), remove other behaviours from the hook list the update pass is walking.
    this.world._destroyNodeNow(node.entity);
  }
  removeComponent(node: GameObject, c: Made): void {
    if (c instanceof Component) this.world._removeComponentImmediate(c);
    else if (c !== TRANSFORM_ENTRY) node.removeData(c);
  }
  order(node: GameObject, ordered: readonly Made[]): void {
    // The World orders behaviours only (Transform and data components are kept apart); ones the fold doesn't know follow.
    const behaviours = ordered.filter((c): c is Component => c instanceof Component);
    const rest = this.world._componentsOf(node.entity).filter((c) => !behaviours.includes(c));
    this.world._reorderComponents(node.entity, [...behaviours, ...rest]);
  }
  enabled(_node: GameObject, c: Made, enabled: boolean): void {
    if (c instanceof Component) c._enabled = enabled; // lifecycle is deferred until the batch ends
  }
  field(node: GameObject, c: Made | undefined, type: string, _index: number, field: string, value: unknown, scope: FoldScope<GameObject>, source: string): void {
    if (c === undefined || c === TRANSFORM_ENTRY) {
      if (type === "engine.Transform") applyTransform(node, { [field]: value });
      return;
    }
    if (c instanceof Component) return this.fields(c, { [field]: value }, scope, source);
    const view = node.getData(c) as Record<string, number> | null;
    if (view) view[field] = Number(value);
  }

  fields(c: Component, data: Record<string, unknown>, scope: FoldScope<GameObject>, path: string): void {
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

  resolveFixups(): void {
    const resolve = (scope: FoldScope<GameObject>, id: string) => {
      // `/Name/Child`: a node outside the file (a persistent node, ADR 0016) by names from the World root (ADR 0013).
      const found = id.startsWith("/") ? this.world.root.find(id) : (scope.get(id)?.node ?? (scope === this.top ? this.hooks.resolveExternal?.(id) : undefined));
      if (!found) console.warn(`[myco] node reference "${id}" not found.`);
      else this.world._assertOwns(found, `node reference "${id}"`); // never across Worlds (ADR 0032)
      return found ?? null;
    };
    for (const f of this.fixups) f.apply(resolve);
  }
}

/** Component types ADR 0421 removed: the screen `Text` and `LocalizedText`, by id and by bare name. */
const REMOVED_UI = new Set(["engine.Text", "engine.LocalizedText", "Text", "LocalizedText"]);
/** The UI document component ADR 0423 retired, by id and by bare name. */
const RETIRED_DOCUMENTS = new Set(["engine.UIDocument", "UIDocument"]);

/** A node's path of names from the World root (`/menu/Canvas/Title`), as `GameObject.find` on the World root reads it. */
function nodePath(node: GameObject): string {
  const names: string[] = [];
  for (let n: GameObject | null = node; n?.parent; n = n.parent) names.unshift(n.name);
  return `/${names.join("/")}`;
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
    if (raw === null || raw === undefined) return null;
    const id = nodeRefId(raw); // where a reference can sit: nodeReferences.ts
    if (id !== null) ref(id);
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
    // A quaternion `[x, y, z, w]` (as the editor writes it, ADR 0163), or Euler degrees `[x, y, z]` (order ZXY).
    if (raw === null) return null;
    const q = rotationFromFile(raw);
    if (current instanceof Quaternion) return (current.copy(q), SKIP);
    return q;
  }
  if (t === Color) {
    if (raw === null) return null;
    if (Array.isArray(raw) || (typeof raw === "string" && parseHex(raw))) return Color.from(raw as string | number[]);
    console.warn(`[myco] ${path}: field "${name}" expects a colour such as "#ff8800"; keeping its default.`);
    return SKIP;
  }
  if (t === AssetRef) return typeof raw === "string" ? normalizeAssetPath(raw) : raw;
  // A plain JSON value replaces the field's whole value (a deep copy, ADR 0039); merging into the old one would keep
  // keys the new value dropped, so a reverted override or a removed key would linger.
  if (t === PlainObject) return structuredClone(raw);
  return raw;
}

/**
 * @internal A rotation as a scene file writes it: a quaternion `[x, y, z, w]` (ADR 0163). Hand-written files
 * may also give Euler **degrees** `[x, y, z]` (order ZXY) or one number (a 2D angle in degrees); people write
 * files, so they keep degrees where the code API is radians (ADR 0164).
 */
export function rotationFromFile(raw: unknown): Quaternion {
  if (typeof raw === "number") return Quaternion.rotateZ(raw * DEG2RAD);
  const a = raw as number[];
  if (a.length >= 4) return new Quaternion(a[0], a[1], a[2], a[3]).normalize();
  return Quaternion.euler((a[0] ?? 0) * DEG2RAD, (a[1] ?? 0) * DEG2RAD, (a[2] ?? 0) * DEG2RAD);
}

/** @internal Apply Transform data from a scene file (`position`, `rotation`, `scale`). */
export function applyTransform(node: GameObject, data: Record<string, unknown>): void {
  const t = node.transform ?? node.world._addTransform(node.entity);
  if (data.position !== undefined) t.position = data.position as number[];
  if (data.rotation !== undefined) {
    t.rotation = rotationFromFile(data.rotation);
  }
  if (data.scale !== undefined) t.scale = data.scale as number[];
}

/** @internal Instantiate every node of `file` under `parent`, then run awake/onEnable in tree order. */
export function instantiateFile(world: World, file: SceneFile, parent: GameObject, path: string, hooks?: InstantiateHooks): GameObject[] {
  world._assertOwns(parent, `${path}: parent`);
  return world._batch(() => {
    const job = new Instantiation(world, hooks);
    try {
      const roots = job.file(file, parent, path);
      job.resolveFixups();
      return roots;
    } catch (err) {
      job.discard();
      throw err;
    }
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
    try {
      const roots = job.file(file, parent, path);
      if (roots.length !== 1) throw new Error(`${path}: a prefab must have exactly one root node (has ${roots.length}).`);
      const root = roots[0];
      instantiatedPrefabs.set(root, path);
      if (options.name) root.name = options.name;
      const t = root.transform;
      if (t && options.position) t.position = Vector3.from(options.position);
      if (t && options.rotation2D !== undefined) t.rotation2D = options.rotation2D;
      job.resolveFixups();
      return root;
    } catch (err) {
      job.discard();
      throw err;
    }
  });
}

/** Collect every `asset:` path referenced by a scene file and the prefabs it uses, overrides' added nodes included (the resolved scene view). */
export function collectAssetRefs(path: string): Set<string> {
  return assetRefs(path);
}

/**
 * Scene and prefab files (ADR 0013, 0016). Scenes and prefabs share one JSON format; a prefab
 * is a scene file with a single root node, instanced inside another scene or at runtime.
 */
import { Component } from "../core/Component";
import { getDataComponentDef } from "../core/data";
import { Color, Vector2, Vector3 } from "../core/math";
import { AssetRef, PlainObject, component, field, getComponentClass, getComponentId, getFields, type ComponentClass } from "../core/registry";
import type { World } from "../core/World";
import { Assets } from "./Assets";
import { GameObject, type InstantiateOptions } from "./GameObject";

export const SCENE_FORMAT = "tranquility.scene";
export const CURRENT_FORMAT_VERSION = 1;

export interface ComponentEntry {
  type: string;
  /** Start disabled (GameBehaviors and built-ins). */
  enabled?: boolean;
  data?: Record<string, unknown>;
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
  const match = /^tranquility\.scene@(\d+)$/.exec(file.format ?? "");
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

/** Marks a node created from a scene file; scene nodes sit under the World root (ADR 0016). */
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

class Instantiation {
  readonly fixups: Fixup[] = [];
  constructor(readonly world: World) {}

  /** Create all nodes of `file` under `parent`; returns top-level nodes and the id map. */
  file(file: SceneFile, parent: GameObject, path: string): { roots: GameObject[]; ids: Map<string, Instance> } {
    const ids = new Map<string, Instance>();
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
        if (!entry.parent) roots.push(inst.node);
      }
    }
    if (pending.length) throw new Error(`${path}: node(s) ${pending.map((n) => `"${n.id}"`).join(", ")} reference a missing parent.`);
    return { roots, ids };
  }

  private node(entry: NodeEntry, parent: GameObject, scope: Map<string, Instance>, path: string): Instance {
    if (entry.prefab) {
      const prefab = loadSceneFile(entry.prefab);
      const { roots, ids } = this.file(prefab, parent, entry.prefab);
      if (roots.length !== 1) throw new Error(`${entry.prefab}: a prefab must have exactly one root node (has ${roots.length}).`);
      const node = roots[0];
      this.world.ids[node.entity] = entry.id;
      if (entry.name) node.name = entry.name;
      if (entry.tags) node.tags = entry.tags;
      if (entry.active === false) node.setActive(false);
      const inst: Instance = { node, nested: ids };
      for (const o of entry.overrides ?? []) this.override(inst, o, scope, path);
      return inst;
    }
    const node = this.world._createNode(entry.name ?? entry.id, parent.entity, { transform: entry.transform !== false, id: entry.id });
    if (entry.componentNode) this.world.setComponentNode(node.entity, true);
    if (entry.tags) node.tags = entry.tags;
    if (entry.active === false) node.setActive(false);
    for (const c of entry.components ?? []) this.component(node, c, scope, path);
    return { node };
  }

  component(node: GameObject, entry: ComponentEntry, scope: Map<string, Instance>, path: string): void {
    const data = entry.data ?? {};
    if (entry.type === "engine.Transform") {
      applyTransform(node, data);
      return;
    }
    const def = getDataComponentDef(entry.type);
    if (def) {
      node.addData(def, data as Record<string, number>);
      return;
    }
    const type = getComponentClass(entry.type) as (new () => Component) | undefined;
    if (!type) throw new Error(`${path}: unknown component type "${entry.type}". Is the class imported and decorated with @behavior("${entry.type}")?`);
    const c = node.addBehavior(type);
    if (entry.enabled === false) c._enabled = false; // lifecycle is deferred until the batch ends
    this.fields(c, data, scope, path);
  }

  fields(c: Component, data: Record<string, unknown>, scope: Map<string, Instance>, path: string): void {
    const type = c.constructor as ComponentClass;
    const declared = getFields(type);
    for (const [key, raw] of Object.entries(data)) {
      const info = declared.find((f) => f.name === key);
      if (!info) {
        console.warn(`[tranquility] ${path}: "${key}" is not a declared field of ${getComponentId(type) ?? type.name}; ignored.`);
        continue;
      }
      const target = c as unknown as Record<string, unknown>;
      const t = info.type;
      if (t === GameObject) {
        const ref = raw as { $node?: string } | null;
        if (ref === null) target[key] = null;
        else if (ref && typeof ref.$node === "string") {
          const id = ref.$node;
          this.fixups.push({ apply: (resolve) => { target[key] = resolve(scope, id); } });
        } else console.warn(`[tranquility] ${path}: field "${key}" expects {"$node": "<id>"}.`);
      } else if (t === Vector2) {
        const cur = target[key];
        if (cur instanceof Vector2) cur.copy(raw as number[]);
        else target[key] = Vector2.from(raw as number[]);
      } else if (t === Vector3) {
        const cur = target[key];
        if (cur instanceof Vector3) cur.copy(raw as number[]);
        else target[key] = Vector3.from(raw as number[]);
      } else if (t === Color) {
        target[key] = Color.from(raw as string);
      } else if (t === AssetRef) {
        target[key] = typeof raw === "string" ? raw.replace(/^asset:/, "") : raw;
      } else if (t === PlainObject) {
        target[key] = mergeDeep(target[key], raw);
      } else {
        target[key] = raw;
      }
    }
  }

  private override(inst: Instance, o: OverrideEntry, scope: Map<string, Instance>, path: string): void {
    let current = inst;
    for (const id of o.target ?? []) {
      const next = current.nested?.get(id);
      if (!next) throw new Error(`${path}: override target "${(o.target ?? []).join("/")}" not found in prefab instance.`);
      current = next;
    }
    const node = current.node;
    if (o.name !== undefined) node.name = o.name;
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
      if (!c) throw new Error(`${path}: override targets missing component "${o.component}".`);
      this.fields(c, { [o.field]: o.value }, scope, path);
    }
  }

  resolveFixups(): void {
    const resolve = (scope: Map<string, Instance>, id: string) => {
      const found = scope.get(id);
      if (!found) console.warn(`[tranquility] node reference "${id}" not found.`);
      return found?.node ?? null;
    };
    for (const f of this.fixups) f.apply(resolve);
  }
}

function applyTransform(node: GameObject, data: Record<string, unknown>): void {
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
export function instantiateFile(world: World, file: SceneFile, parent: GameObject, path: string): GameObject[] {
  return world._batch(() => {
    const job = new Instantiation(world);
    const { roots } = job.file(file, parent, path);
    job.resolveFixups();
    return roots;
  });
}

/** @internal Backs `GameObject.instantiate`. */
export function instantiatePrefab(world: World, path: string, options: InstantiateOptions): GameObject {
  const file = loadSceneFile(path);
  const parent = options.parent ?? world.activeScene ?? world.root;
  return world._batch(() => {
    const job = new Instantiation(world);
    const { roots } = job.file(file, parent, path);
    if (roots.length !== 1) throw new Error(`${path}: a prefab must have exactly one root node (has ${roots.length}).`);
    const root = roots[0];
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

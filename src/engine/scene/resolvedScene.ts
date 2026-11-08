/**
 * The resolved scene view: every effective node and component entry of a scene or prefab file, with
 * prefab instances expanded and every override kind applied the way `Instantiation` (SceneLoader.ts)
 * applies them (ADR 0042, 0086, 0123): `addComponent`, `addNodes` (nested prefabs in added nodes too),
 * `removeComponent`, `removeNode`, `active`, `name`, `order`, `enabled`/`worlds` and field overrides.
 *
 * Every function that has to know "what does this scene contain" (asset preloading, physics and
 * navigation detection, warm-up, thumbnails, the hierarchy filter) reads this view instead of walking
 * files and guessing at overrides. It never instantiates anything and never throws: a missing or
 * unparseable file, a prefab cycle, or an override aimed at a node that isn't there is skipped.
 *
 * Pure engine-core: no renderer, no editor. Component data is shared with the source files and never
 * mutated; a field override copies the data it changes.
 */
import { Assets } from "./Assets";
import { isScenePath, loadSceneFile, sceneName } from "./SceneLoader";

export interface ResolvedComponent {
  type: string;
  data?: unknown;
  enabled?: boolean;
  worlds?: string[];
}

export interface ResolvedNode {
  /**
   * Unique within the view: the node's id prefixed by the ids of the instances it sits in
   * (`bg-a/root/child`), which is how an override's `target` path addresses it.
   */
  id: string;
  name?: string;
  /** The id of the parent node in this view; absent for a top-level node. */
  parent?: string;
  /** The node's own flag (instance `active: false` and overrides applied). */
  active: boolean;
  /** `active`, and every ancestor's too. */
  activeInHierarchy: boolean;
  /** The file this node is written in (for instances, the file instanced). */
  source: string;
  /** Set on the node a prefab or scene instance entry stands for: the file it instances. */
  prefab?: string;
  /** True for the node standing for an instanced scene file (it holds that scene's top-level nodes). */
  sceneInstance?: boolean;
  components: ResolvedComponent[];
}

export interface ResolvedScene {
  path: string;
  /** Parents before their children. Nodes removed by `removeNode` are not here. */
  nodes: ResolvedNode[];
  /** Every effective component entry, in node order. */
  components: ResolvedComponent[];
  /** Every file that was read and parsed (the root and the prefabs/scenes reached). */
  files: string[];
  /** The raw parsed file for each of `files`, for callers that need file-level data (e.g. `settings`). */
  raw: ReadonlyMap<string, RawFile>;
}

/** A parsed scene or prefab file as `read` returns it; only `nodes` is required. */
export interface RawFile {
  nodes?: unknown;
  settings?: unknown;
  [key: string]: unknown;
}

export interface ResolveOptions {
  /** A file's parsed JSON, or undefined/throws when it is missing. Default: `loadSceneFile` (migrations applied). */
  read?: (path: string) => unknown;
}

interface RNode extends ResolvedNode {
  parentNode?: RNode;
  removed?: boolean;
}
interface Inst {
  node: RNode;
  nested?: Map<string, Inst>;
}

const MAX_DEPTH = 32;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

class Resolver {
  readonly all: RNode[] = [];
  readonly files = new Set<string>();
  readonly raw = new Map<string, RawFile>();
  /** Every path asked of `read`, found or not (a cache entry depends on all of them). */
  readonly visited = new Set<string>();

  constructor(private readonly read: (path: string) => unknown) {}

  load(path: string): RawFile | undefined {
    this.visited.add(path);
    let file: unknown;
    try {
      file = this.read(path);
    } catch {
      return undefined;
    }
    if (!isObject(file) || !Array.isArray(file.nodes)) return undefined;
    this.files.add(path);
    this.raw.set(path, file);
    return file as RawFile;
  }

  /** Create the nodes of `list` under `parent`; ids are scoped by `prefix`. */
  file(list: unknown[], parent: RNode | undefined, path: string, prefix: readonly string[], stack: readonly string[]): { roots: RNode[]; ids: Map<string, Inst> } {
    const ids = new Map<string, Inst>();
    const roots: RNode[] = [];
    const pending = list.filter((n): n is Record<string, unknown> => isObject(n) && typeof n.id === "string");
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      for (let i = 0; i < pending.length; i++) {
        const entry = pending[i];
        const parentId = typeof entry.parent === "string" && entry.parent ? entry.parent : undefined;
        if (parentId !== undefined && !ids.has(parentId)) continue;
        pending.splice(i--, 1);
        progress = true;
        const id = entry.id as string;
        if (ids.has(id)) continue; // duplicate id: the first wins
        const parentNode = parentId !== undefined ? ids.get(parentId)!.node : parent;
        const inst = this.node(entry, parentNode, path, prefix, stack);
        if (!inst) continue;
        ids.set(id, inst);
        if (parentId === undefined) roots.push(inst.node);
      }
    }
    return { roots, ids };
  }

  private make(id: string, parent: RNode | undefined, source: string, entry: Record<string, unknown>): RNode {
    const node: RNode = {
      id,
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
      ...(parent ? { parent: parent.id, parentNode: parent } : {}),
      active: entry.active !== false,
      activeInHierarchy: true,
      source,
      components: [],
    };
    this.all.push(node);
    return node;
  }

  private node(entry: Record<string, unknown>, parent: RNode | undefined, path: string, prefix: readonly string[], stack: readonly string[]): Inst | undefined {
    const id = entry.id as string;
    const at = [...prefix, id];
    if (typeof entry.prefab === "string") {
      const prefabPath = entry.prefab;
      if (stack.includes(prefabPath) || stack.length >= MAX_DEPTH) return undefined;
      const prefab = this.load(prefabPath);
      if (!prefab) return undefined;
      let container: RNode | undefined;
      if (isScenePath(prefabPath)) {
        container = this.make(at.join("/"), parent, prefabPath, entry);
        container.prefab = prefabPath;
        container.sceneInstance = true;
        container.name ??= sceneName(prefabPath);
      }
      const { roots, ids } = this.file(prefab.nodes as unknown[], container ?? parent, prefabPath, at, [...stack, prefabPath]);
      const node = container ?? roots[0];
      if (!node) return undefined;
      if (!container) node.prefab = prefabPath;
      if (typeof entry.name === "string") node.name = entry.name;
      if (entry.active === false) node.active = false;
      const inst: Inst = { node, nested: ids };
      for (const o of Array.isArray(entry.overrides) ? entry.overrides : []) if (isObject(o)) this.override(inst, o, at, path, stack);
      return inst;
    }
    const node = this.make(at.join("/"), parent, path, entry);
    for (const c of Array.isArray(entry.components) ? entry.components : []) this.addComponent(node, c);
    return { node };
  }

  private addComponent(node: RNode, c: unknown): void {
    if (!isObject(c) || typeof c.type !== "string") return;
    node.components.push({
      type: c.type,
      ...(c.data !== undefined ? { data: c.data } : {}),
      ...(typeof c.enabled === "boolean" ? { enabled: c.enabled } : {}),
      ...(strings(c.worlds) ? { worlds: strings(c.worlds) } : {}),
    });
  }

  private override(inst: Inst, o: Record<string, unknown>, instAt: readonly string[], path: string, stack: readonly string[]): void {
    let current = inst;
    let container = inst;
    let containerAt = instAt;
    const target = strings(o.target) ?? [];
    for (let i = 0; i < target.length; i++) {
      const next = current.nested?.get(target[i]);
      if (!next) return;
      current = next;
      if (current.nested) {
        container = current;
        containerAt = [...instAt, ...target.slice(0, i + 1)];
      }
    }
    const node = current.node;
    if (o.removeNode === true) {
      if (target.length === 0) return;
      node.removed = true;
      container.nested?.delete(target[target.length - 1]);
      return;
    }
    if (Array.isArray(o.addNodes)) {
      container.nested ??= new Map();
      const added = o.addNodes.filter((n): n is Record<string, unknown> => isObject(n) && typeof n.id === "string");
      if (!added.some((n) => container.nested!.has(n.id as string))) {
        const { ids } = this.file(added, node, path, containerAt, stack);
        for (const [id, i] of ids) container.nested.set(id, i);
      }
    }
    this.apply(node, o);
  }

  private apply(node: RNode, o: Record<string, unknown>): void {
    if (typeof o.name === "string") node.name = o.name;
    if (typeof o.active === "boolean") node.active = o.active;
    if (typeof o.removeComponent === "string") {
      const at = node.components.findIndex((c) => c.type === o.removeComponent);
      if (at >= 0) node.components.splice(at, 1);
    }
    if (o.addComponent !== undefined) this.addComponent(node, o.addComponent);
    const order = strings(o.order);
    if (order) {
      const pool = [...node.components];
      const ordered: ResolvedComponent[] = [];
      for (const type of order) {
        const at = pool.findIndex((c) => c.type === type);
        if (at >= 0) ordered.push(...pool.splice(at, 1));
      }
      node.components = [...ordered, ...pool];
    }
    if (typeof o.component !== "string") return;
    const index = typeof o.index === "number" ? o.index : 0;
    const c = node.components.filter((x) => x.type === o.component)[index];
    if (!c) return;
    if (o.field === undefined) {
      if (typeof o.enabled === "boolean") c.enabled = o.enabled;
      const worlds = strings(o.worlds);
      if (worlds) c.worlds = worlds;
    } else if (typeof o.field === "string") {
      c.data = { ...(isObject(c.data) ? c.data : {}), [o.field]: o.value };
    }
  }

  finish(path: string): ResolvedScene {
    const removed = (n: RNode): boolean => {
      for (let p: RNode | undefined = n, depth = 0; p && depth < 256; p = p.parentNode, depth++) if (p.removed) return true;
      return false;
    };
    const nodes = this.all.filter((n) => !removed(n));
    for (const n of nodes) {
      let on = n.active;
      for (let p = n.parentNode, depth = 0; on && p && depth < 256; p = p.parentNode, depth++) on = p.active;
      n.activeInHierarchy = on;
    }
    const out: ResolvedNode[] = nodes.map(({ parentNode: _p, removed: _r, ...rest }) => rest);
    return { path, nodes: out, components: out.flatMap((n) => n.components), files: [...this.files], raw: this.raw };
  }
}

function defaultRead(path: string): unknown {
  return loadSceneFile(path);
}

/** The raw asset behind `path`, `undefined` when missing: what a cache entry is checked against. */
function rawAsset(path: string): unknown {
  try {
    return Assets.has(path) ? Assets.get(path) : undefined;
  } catch {
    return undefined;
  }
}

interface Cached {
  scene: ResolvedScene;
  /** Every path the resolution asked for, with the raw asset it saw (undefined: it was missing). */
  deps: [string, unknown][];
}
const cache = new Map<string, Cached>();

/** Forget every cached view (tests, and anything that changes assets without replacing them). */
export function invalidateResolvedScenes(): void {
  cache.clear();
}

/**
 * The resolved view of the scene or prefab at `path`. With the default `read` the result is cached per
 * path and reused while the raw assets of every file it read are the same objects (`Assets` sources
 * replace a file's value when it changes, and a file that appears or vanishes changes it too); an
 * injected `read` is never cached. The result is shared: don't mutate it.
 */
export function resolveScene(path: string, options: ResolveOptions = {}): ResolvedScene {
  const injected = options.read !== undefined;
  if (!injected) {
    const hit = cache.get(path);
    if (hit && hit.deps.every(([p, raw]) => rawAsset(p) === raw)) return hit.scene;
  }
  const r = new Resolver(options.read ?? defaultRead);
  const file = r.load(path);
  if (file) {
    r.file(file.nodes as unknown[], undefined, path, [], [path]);
  }
  const scene = r.finish(path);
  if (!injected) cache.set(path, { scene, deps: [...r.visited].map((p) => [p, rawAsset(p)] as [string, unknown]) });
  return scene;
}

/** Every effective component entry of the scene at `path`. */
export function resolvedComponents(path: string, options?: ResolveOptions): readonly ResolvedComponent[] {
  return resolveScene(path, options).components;
}

/** True if any effective component of the scene at `path` has one of `typeIds`. */
export function anyComponentOf(path: string, typeIds: ReadonlySet<string> | readonly string[], options?: ResolveOptions): boolean {
  const set = typeIds instanceof Set ? typeIds : new Set(typeIds);
  return resolveScene(path, options).components.some((c) => set.has(c.type));
}

/**
 * Every `asset:` path (without the prefix) the scene and the files it instances reference, in
 * component data and in override values, including those of overrides' added nodes. Values an
 * override replaced still count: the file still names them.
 */
export function assetRefs(path: string, options?: ResolveOptions): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.startsWith("asset:")) out.add(v.slice(6));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (isObject(v)) Object.values(v).forEach(walk);
  };
  const scene = resolveScene(path, options);
  for (const file of scene.raw.values()) {
    for (const n of file.nodes as unknown[]) {
      if (!isObject(n)) continue;
      walk(n.components);
      walk(n.overrides);
    }
  }
  return out;
}

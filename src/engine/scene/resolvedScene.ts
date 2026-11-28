/**
 * The resolved scene view: every effective node and component entry of a scene or prefab file, with
 * prefab instances expanded and every override kind applied. It is one adapter of the
 * prefab-override fold (`overrideFold.ts`, ADR 0280), the fold `Instantiation` (SceneLoader.ts)
 * and the editor's prefab Apply run too, so the three agree by construction.
 *
 * Every function that has to know "what does this scene contain" (asset preloading, physics and
 * navigation detection, warm-up, thumbnails, the editor's hierarchy filter and component origins)
 * reads this view instead of walking files and guessing at overrides. It never instantiates
 * anything and never throws: a missing or unparseable file, a prefab cycle, or an override aimed
 * at a node that isn't there is skipped.
 *
 * Pure engine-core: no renderer, no editor. Component data is shared with the source files and never
 * mutated; a field override copies the data it changes.
 */
import { Assets } from "./Assets";
import { foldNodes, type FoldAdapter, type FoldPath, type NodeStep, type OverrideHome } from "./overrideFold";
import { loadSceneFile, type ComponentEntry } from "./SceneLoader";
import { sceneNodeName } from "./scenePath";

export interface ResolvedComponent {
  type: string;
  data?: unknown;
  enabled?: boolean;
  worlds?: string[];
  /** Set on a component an `addComponent` override added: where that override is written. */
  added?: OverrideHome;
}

export interface ResolvedNode {
  /**
   * Unique within the view: the node's id prefixed by the ids of the instances it sits in
   * (`bg-a/root/child`). A prefab's root keeps its own id here (`bg-a/root`); see `path`.
   */
  id: string;
  /**
   * The node's path as an override `target` (prefixed with the instance's id) addresses it, which
   * is the editor's node path: a prefab instance's root is the instance (`["bg-a"]`).
   */
  path: readonly string[];
  name?: string;
  /** The id of the parent node in this view; absent for a top-level node. */
  parent?: string;
  /** The node's own flag (instance `active: false` and overrides applied). */
  active: boolean;
  /** `active`, and every ancestor's too. */
  activeInHierarchy: boolean;
  /** The node's tags (its entry's, an instance entry's or an override's), when it has any. */
  tags?: string[];
  /** The file this node is written in (for instances, the file instanced). */
  source: string;
  /** Set on the node a prefab or scene instance entry stands for: the file it instances. */
  prefab?: string;
  /** True for the node standing for an instanced scene file (it holds that scene's top-level nodes). */
  sceneInstance?: boolean;
  /** True for a node an `addNodes` override added (for an added instance entry, the node it stands for). */
  added?: boolean;
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

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

/** The view's fold adapter: plain node and component entries. */
class Resolver implements FoldAdapter<RNode, ResolvedComponent> {
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

  private make(step: NodeStep<RNode>, source: string, name: unknown): RNode {
    const { entry, parent, at } = step;
    const tags = strings(entry.tags);
    const node: RNode = {
      id: at.join("/"),
      path: at,
      ...(typeof name === "string" ? { name } : {}),
      ...(parent ? { parent: parent.id, parentNode: parent } : {}),
      active: entry.active !== false,
      activeInHierarchy: true,
      ...(tags ? { tags } : {}),
      source,
      ...(step.added ? { added: true } : {}),
      components: [],
    };
    this.all.push(node);
    return node;
  }

  node(step: NodeStep<RNode>): RNode {
    return this.make(step, step.source, step.entry.name);
  }

  sceneNode(step: NodeStep<RNode>, scene: string): RNode {
    const node = this.make(step, scene, step.entry.name ?? sceneNodeName(scene));
    node.sceneInstance = true;
    return node;
  }

  placed(node: RNode, at: FoldPath, step: NodeStep<RNode>): void {
    node.path = at;
    if (typeof step.entry.prefab !== "string") return;
    node.prefab = step.entry.prefab;
    if (step.added) node.added = true;
  }

  component(node: RNode, c: ComponentEntry, worlds: readonly string[] | undefined, _scope: unknown, _source: string, _at: FoldPath, home?: OverrideHome): ResolvedComponent {
    const w = strings(worlds);
    const out: ResolvedComponent = {
      type: c.type,
      ...(c.data !== undefined ? { data: c.data } : {}),
      ...(typeof c.enabled === "boolean" ? { enabled: c.enabled } : {}),
      ...(w ? { worlds: w } : {}),
      ...(home ? { added: home } : {}),
    };
    node.components.push(out);
    return out;
  }

  name(node: RNode, name: string): void {
    node.name = name;
  }
  tags(node: RNode, tags: string[]): void {
    node.tags = strings(tags);
  }
  active(node: RNode, active: boolean): void {
    node.active = active;
  }
  removeNode(node: RNode): void {
    node.removed = true;
  }
  removeComponent(node: RNode, c: ResolvedComponent): void {
    node.components = node.components.filter((x) => x !== c);
  }
  order(node: RNode, ordered: readonly ResolvedComponent[]): void {
    node.components = [...ordered];
  }
  enabled(_node: RNode, c: ResolvedComponent, enabled: boolean): void {
    c.enabled = enabled;
  }
  worlds(_node: RNode, c: ResolvedComponent, worlds: string[]): void {
    c.worlds = strings(worlds);
  }
  field(_node: RNode, c: ResolvedComponent | undefined, _type: string, _index: number, field: string, value: unknown): void {
    if (c) c.data = { ...(isObject(c.data) ? c.data : {}), [field]: value };
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
  if (file) foldNodes(r, file.nodes as unknown[], undefined, path);
  const scene = r.finish(path);
  if (!injected) cache.set(path, { scene, deps: [...r.visited].map((p) => [p, rawAsset(p)] as [string, unknown]) });
  return scene;
}

/** Every effective component entry of the scene at `path`. */
export function resolvedComponents(path: string, options?: ResolveOptions): readonly ResolvedComponent[] {
  return resolveScene(path, options).components;
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

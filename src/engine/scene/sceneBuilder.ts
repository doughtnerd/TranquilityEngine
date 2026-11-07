/**
 * Code-authored scenes and prefabs (ADR 0013): a small typed builder that produces the same
 * `myco.scene@N` JSON the loader reads (`SceneFile`), so tests and quick demos don't need
 * hand-written JSON. Nothing here touches a renderer or World.
 *
 * ```ts
 * const file = scene("Main")
 *   .settings({ physics: "2d" })
 *   .node("Player", (n) => n
 *     .component("engine.Transform", { position: [0, 1, 0] })
 *     .component("engine.SpriteRenderer", { sprite: asset("images/bird.png") })
 *     .child("Hitbox", (c) => c.component("engine.BoxCollider2D", { size: [1, 1] })))
 *   .node("Pipes", (n) => n.instanceOf("prefabs/pipe-pair.prefab.json", {
 *     overrides: [setField("engine.Transform", "position", [4, 0, 0], ["top"])],
 *   }))
 *   .toJSON();
 * ```
 *
 * Node ids default to a slug of the node's name (`"Player"` → `"player"`, repeats get `-2`, `-3`);
 * call `.id("x")` for a stable one. Children are emitted right after their parent.
 */
import { CURRENT_FORMAT_VERSION, SCENE_FORMAT, type ComponentEntry, type NodeEntry, type OverrideEntry, type SceneFile } from "./SceneLoader";

export type { ComponentEntry, NodeEntry, OverrideEntry, SceneFile };

/** A reference to another node in the same scene, as stored in component data. */
export function ref(nodeId: string): { $node: string } {
  return { $node: nodeId };
}

/** An asset reference, relative to the assets root: `asset("images/a.png")` → `"asset:images/a.png"`. */
export function asset(path: string): string {
  return `asset:${path.replace(/^\/+/, "")}`;
}

/** A field override for a prefab instance; `target` is the node-id path inside the instance. */
export function setField(component: string, field: string, value: unknown, target?: string[], index?: number): OverrideEntry {
  return { ...(target?.length ? { target } : {}), component, ...(index !== undefined ? { index } : {}), field, value };
}

export interface InstanceOptions {
  overrides?: OverrideEntry[];
}

export interface NodeComponentOptions {
  enabled?: boolean;
  worlds?: string[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node";

/** Hands out unique node ids for one scene or prefab. */
class Ids {
  private used = new Set<string>();
  claim(id: string): string {
    if (this.used.has(id)) throw new Error(`Duplicate node id "${id}".`);
    this.used.add(id);
    return id;
  }
  fresh(name: string): string {
    const base = slug(name);
    let id = base;
    for (let n = 2; this.used.has(id); n++) id = `${base}-${n}`;
    this.used.add(id);
    return id;
  }
}

export class NodeBuilder {
  private _id?: string;
  private _active?: boolean;
  private _tags?: string[];
  private _componentNode?: boolean;
  private _transform?: boolean;
  private _prefab?: string;
  private _overrides?: OverrideEntry[];
  private readonly components: ComponentEntry[] = [];
  private readonly children: NodeBuilder[] = [];

  constructor(readonly name: string) {}

  /** Set a stable id instead of the generated slug. */
  id(id: string): this {
    this._id = id;
    return this;
  }
  active(active: boolean): this {
    this._active = active;
    return this;
  }
  tags(...tags: string[]): this {
    this._tags = tags;
    return this;
  }
  /** Mark a component-only child node (`componentNode`). */
  componentNode(): this {
    this._componentNode = true;
    return this;
  }
  /** A pure logic or grouping node with no Transform. */
  noTransform(): this {
    this._transform = false;
    return this;
  }
  component(type: string, data?: Record<string, unknown>, options: NodeComponentOptions = {}): this {
    this.components.push({
      type,
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      ...(data ? { data } : {}),
      ...(options.worlds ? { worlds: options.worlds } : {}),
    });
    return this;
  }
  child(name: string, build?: (node: NodeBuilder) => unknown): this {
    const c = new NodeBuilder(name);
    build?.(c);
    this.children.push(c);
    return this;
  }
  /** Make this node an instance of a prefab (or scene) file, with optional overrides. */
  instanceOf(path: string, options: InstanceOptions = {}): this {
    this._prefab = path;
    this._overrides = options.overrides;
    return this;
  }

  /** @internal Flatten this node and its descendants, parents first. */
  emit(ids: Ids, parent: string | undefined, out: NodeEntry[]): void {
    const id = this._id !== undefined ? ids.claim(this._id) : ids.fresh(this.name);
    out.push({
      id,
      name: this.name,
      ...(parent !== undefined ? { parent } : {}),
      ...(this._active !== undefined ? { active: this._active } : {}),
      ...(this._tags ? { tags: this._tags } : {}),
      ...(this._componentNode ? { componentNode: true } : {}),
      ...(this._transform === false ? { transform: false } : {}),
      ...(this._prefab === undefined ? { components: this.components } : { prefab: this._prefab }),
      ...(this._overrides?.length ? { overrides: this._overrides } : {}),
    });
    for (const c of this.children) c.emit(ids, id, out);
  }
}

function build(roots: NodeBuilder[], settings: SceneFile["settings"]): SceneFile {
  const ids = new Ids();
  const nodes: NodeEntry[] = [];
  for (const r of roots) r.emit(ids, undefined, nodes);
  return structuredClone({ format: `${SCENE_FORMAT}@${CURRENT_FORMAT_VERSION}`, ...(settings ? { settings } : {}), nodes });
}

export class SceneBuilder {
  private _settings?: SceneFile["settings"];
  private readonly roots: NodeBuilder[] = [];

  /** @param name A label for your own use; scene files don't store a name (it comes from the file path). */
  constructor(readonly name: string) {}

  settings(settings: NonNullable<SceneFile["settings"]>): this {
    this._settings = settings;
    return this;
  }
  /** Add a top-level node. */
  node(name: string, build?: (node: NodeBuilder) => unknown): this {
    const n = new NodeBuilder(name);
    build?.(n);
    this.roots.push(n);
    return this;
  }
  /** The scene file, ready for `JSON.stringify` or the loader. A fresh copy on every call. */
  toJSON(): SceneFile {
    return build(this.roots, this._settings);
  }
}

export class PrefabBuilder {
  private readonly root: NodeBuilder;
  constructor(name: string, configure?: (root: NodeBuilder) => unknown) {
    this.root = new NodeBuilder(name);
    configure?.(this.root);
  }
  /** The prefab file: a scene file with one root node. */
  toJSON(): SceneFile {
    return build([this.root], undefined);
  }
}

/** Start a scene file. */
export function scene(name: string): SceneBuilder {
  return new SceneBuilder(name);
}

/** Start a prefab file: one root node (with any children) configured by `configure`. */
export function prefab(name: string, configure?: (root: NodeBuilder) => unknown): PrefabBuilder {
  return new PrefabBuilder(name, configure);
}

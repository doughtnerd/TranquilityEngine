import { loadSceneFile, migrateSceneFile, type ComponentEntry, type NodeEntry, type OverrideEntry, type SceneFile } from "../../engine/scene/SceneLoader";
import { resolveScene, type ResolvedScene } from "../../engine/scene/resolvedScene";
import { entryFieldValues, fieldNodeRefs } from "../../engine/scene/nodeReferences";

export type { ComponentEntry, NodeEntry, OverrideEntry, SceneFile } from "../../engine/scene/SceneLoader";

/** Path to a node from the document: `[nodeId]`, or `[instanceId, innerId…]` inside a prefab instance. */
export type NodePath = readonly string[];

/** Stable string key for a node path. */
export function pathKey(path: NodePath): string {
  return path.join("/");
}

/** True if two override targets are the same (an omitted target equals `[]`). */
export function sameTarget(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [], y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * The scene file being edited (ADR 0026): the source of truth for the editor. Holds the parsed
 * `myco.scene@1` JSON exactly as authored (no defaults are added), indexes nodes by id and
 * answers read queries. Change it only through commands (`commands.ts`) so edits can be undone.
 *
 * Sibling order is the order of entries in the file's `nodes` array.
 */
export class SceneDocument {
  private file: SceneFile;
  private byId = new Map<string, NodeEntry>();

  /**
   * `json` is copied; the caller's object is never modified. Older format versions are migrated
   * (and save in the current format); everything else is kept as authored.
   */
  constructor(json: SceneFile, readonly path = "untitled.scene.json") {
    this.file = migrateSceneFile(structuredClone(json), path);
    this.reindex();
  }

  /** The document as scene-file JSON (a copy), ready to save. */
  toJSON(): SceneFile {
    return structuredClone(this.file);
  }

  get format(): string {
    return this.file.format;
  }

  /** The scene's `settings` (physics, the warm-up `preload` list), as authored. Treat as read-only. */
  get settings(): Readonly<NonNullable<SceneFile["settings"]>> {
    return this.file.settings ?? {};
  }

  /** The scene's `settings.preload` list (ADR 0080): prefab and material files warmed up with it. */
  get preload(): readonly string[] {
    const list = this.file.settings?.preload;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  }

  /** All node entries in file order. Treat as read-only. */
  get nodes(): readonly NodeEntry[] {
    return this.file.nodes;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** The node entry for `id`. Throws if there isn't one. Treat as read-only. */
  node(id: string): NodeEntry {
    const n = this.byId.get(id);
    if (!n) throw new Error(`${this.path}: no node "${id}".`);
    return n;
  }

  /** Parent id, or null for a top-level node. */
  parentOf(id: string): string | null {
    return this.node(id).parent ?? null;
  }

  /** Ids of the children of `parent` (null: top-level nodes), in sibling order. */
  children(parent: string | null): string[] {
    return this.file.nodes.filter((n) => (n.parent ?? null) === parent).map((n) => n.id);
  }

  /** Top-level node ids in order. */
  roots(): string[] {
    return this.children(null);
  }

  /** `id` and all its descendants, in file order. */
  subtree(id: string): string[] {
    const ids = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of this.file.nodes) {
        if (n.parent && ids.has(n.parent) && !ids.has(n.id)) {
          ids.add(n.id);
          grew = true;
        }
      }
    }
    return this.file.nodes.filter((n) => ids.has(n.id)).map((n) => n.id);
  }

  /** True if `id` is a prefab instance (its contents come from another file plus overrides). */
  isPrefabInstance(id: string): boolean {
    return !!this.node(id).prefab;
  }

  /** Components of a plain node. Prefab instances have none of their own; see `overrides`. */
  components(id: string): readonly ComponentEntry[] {
    return this.node(id).components ?? [];
  }

  /** Position in the node's `components` array of the `index`-th component of `type`, or -1. */
  componentPosition(id: string, type: string, index = 0): number {
    let seen = 0;
    const list = this.components(id);
    for (let i = 0; i < list.length; i++) {
      if (list[i].type !== type) continue;
      if (seen++ === index) return i;
    }
    return -1;
  }

  /** The authored value of a component field on a plain node, or undefined if not set. */
  fieldValue(id: string, type: string, field: string, index = 0): unknown {
    const pos = this.componentPosition(id, type, index);
    return pos < 0 ? undefined : this.components(id)[pos].data?.[field];
  }

  /** Overrides of a prefab instance node. Treat as read-only. */
  overrides(id: string): readonly OverrideEntry[] {
    return this.node(id).overrides ?? [];
  }

  /** The field override for a node inside a prefab instance (`target` empty: the instance root), or undefined. */
  overrideValue(id: string, target: readonly string[], type: string, field: string, index = 0): unknown {
    const o = this.overrides(id).find((x) => isFieldOverride(x, target, type, field, index));
    return o?.value;
  }

  /**
   * The resolved scene view of the document as it stands (ADR 0280): prefab instances expanded
   * from their files and every override applied, the way the game instantiates it. With
   * `instance`, only that instance entry (as a top-level node), with `overrides` in place of its
   * own when given. Node `path`s are the editor's node paths.
   */
  resolve(instance?: string, overrides?: readonly OverrideEntry[]): ResolvedScene {
    let file: SceneFile = this.file;
    if (instance !== undefined) {
      const { parent: _, ...entry } = this.node(instance);
      file = { format: this.file.format, nodes: [overrides ? { ...entry, overrides: [...overrides] } : entry] };
    }
    return resolveScene(this.path, { read: (p) => (p === this.path ? file : loadSceneFile(p)) });
  }

  /**
   * Every `{"$node": id}` reference among the document's nodes: where it is and which node it
   * points to. References sit where `nodeReferences.ts` says (ADR 0280): component data, field
   * overrides, and an instance's added components (as the component the game makes, so `index`
   * counts it among the node's components of its type; one a later field override replaces isn't
   * listed). Added nodes' references point among those added nodes, not at the document's.
   */
  references(): NodeReference[] {
    const out: NodeReference[] = [];
    for (const n of this.file.nodes) {
      const values = entryFieldValues(n);
      let resolved: ResolvedScene | null = null;
      for (const v of values) {
        const refs = fieldNodeRefs(v.value);
        let index: number;
        if (v.slot.kind === "component") {
          index = n.components!.slice(0, v.slot.component).filter((c) => c.type === v.type).length;
        } else if (v.slot.kind === "override") {
          index = n.overrides![v.slot.override].index ?? 0;
        } else {
          if (refs.length === 0) continue;
          const at = v.slot.override;
          const path = [n.id, ...v.target];
          resolved ??= this.resolve(n.id);
          const list = resolved.nodes.find((r) => sameTarget(r.path, path))?.components.filter((c) => c.type === v.type) ?? [];
          index = list.findIndex((c) => c.added?.override === at && sameTarget(c.added.instance, [n.id]));
          if (index < 0 || values.some((w) => w.slot.kind === "override" && w.type === v.type && w.field === v.field && sameTarget(w.target, v.target) && (n.overrides![w.slot.override].index ?? 0) === index)) continue;
        }
        const path = [n.id, ...v.target];
        for (const r of refs) out.push({ path, type: v.type, index, field: v.field, to: r.to, value: v.value, ...(r.element !== undefined ? { element: r.element } : {}) });
      }
    }
    return out;
  }

  // --- mutation (commands only) ----------------------------------------------------------------

  /** @internal The raw entries array, for commands. */
  get _entries(): NodeEntry[] {
    return this.file.nodes;
  }

  /** @internal The file's root object, for commands that edit `settings`. */
  get _file(): SceneFile {
    return this.file;
  }

  /** @internal Rebuild the id index after a structural change. */
  _reindex(): void {
    this.reindex();
  }

  /** @internal Replace the whole document (history navigation, ADR 0027). `file` is used as is. */
  _replace(file: SceneFile): void {
    this.file = file;
    this.reindex();
  }

  private reindex(): void {
    this.byId.clear();
    for (const n of this.file.nodes) {
      if (this.byId.has(n.id)) throw new Error(`${this.path}: duplicate node id "${n.id}".`);
      this.byId.set(n.id, n);
    }
  }
}

/** A `{"$node": id}` reference found in a document. */
export interface NodeReference {
  /** Node holding the reference (`[id]`, or `[instanceId, …target]` for an override). */
  readonly path: NodePath;
  readonly type: string;
  readonly index: number;
  readonly field: string;
  /** Id of the referenced node. */
  readonly to: string;
  /** For a list field (ADR 0042): which item holds the reference. */
  readonly element?: number;
  /** The field's whole value as written (for a list field, the list). */
  readonly value: unknown;
}

/** True if `o` is a field override for exactly this target, component, index and field. */
export function isFieldOverride(o: OverrideEntry, target: readonly string[], type: string, field: string, index = 0): boolean {
  return o.component === type && o.field === field && (o.index ?? 0) === index && sameTarget(o.target, target);
}

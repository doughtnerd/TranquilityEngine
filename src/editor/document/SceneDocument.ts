import { migrateSceneFile, type ComponentEntry, type NodeEntry, type OverrideEntry, type SceneFile } from "../../engine/scene/SceneLoader";

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

  /** Every `{"$node": id}` reference in the document: where it is and which node it points to. */
  references(): NodeReference[] {
    const out: NodeReference[] = [];
    for (const n of this.file.nodes) {
      const counts = new Map<string, number>();
      for (const c of n.components ?? []) {
        const index = counts.get(c.type) ?? 0;
        counts.set(c.type, index + 1);
        for (const [field, value] of Object.entries(c.data ?? {})) {
          const to = refId(value);
          if (to) out.push({ path: [n.id], type: c.type, index, field, to });
          listRefs(value, (element, id) => out.push({ path: [n.id], type: c.type, index, field, to: id, element }));
        }
      }
      for (const o of n.overrides ?? []) {
        if (!o.component || o.field === undefined) continue;
        const path = [n.id, ...(o.target ?? [])];
        const to = refId(o.value);
        if (to) out.push({ path, type: o.component, index: o.index ?? 0, field: o.field, to });
        listRefs(o.value, (element, id) => out.push({ path, type: o.component!, index: o.index ?? 0, field: o.field!, to: id, element }));
      }
    }
    return out;
  }

  // --- mutation (commands only) ----------------------------------------------------------------

  /** @internal The raw entries array, for commands. */
  get _entries(): NodeEntry[] {
    return this.file.nodes;
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
}

/** Report each `{"$node": id}` item of a list value. */
function listRefs(value: unknown, found: (element: number, id: string) => void): void {
  if (!Array.isArray(value)) return;
  value.forEach((item, i) => {
    const id = refId(item);
    if (id) found(i, id);
  });
}

function refId(value: unknown): string | null {
  return value && typeof value === "object" && typeof (value as { $node?: unknown }).$node === "string" ? (value as { $node: string }).$node : null;
}

/** True if `o` is a field override for exactly this target, component, index and field. */
export function isFieldOverride(o: OverrideEntry, target: readonly string[], type: string, field: string, index = 0): boolean {
  return o.component === type && o.field === field && (o.index ?? 0) === index && sameTarget(o.target, target);
}

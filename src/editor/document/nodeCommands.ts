import { setKey, type Change, type Command } from "./commands";
import { mapEntryNodeRefs } from "../../engine/scene/nodeReferences";
import type { NodeEntry, SceneDocument } from "./SceneDocument";

/**
 * Set the Worlds a component entry of a plain node is created in (ADR 0033 §3, 0038): its
 * `worlds` key, removed with `undefined` (back to the component's own setting). On prefab
 * instances this is a `worlds` override instead (`SetOverrides`).
 */
export class SetComponentWorlds implements Command {
  readonly label: string;

  constructor(readonly node: string, readonly position: number, readonly worlds: readonly string[] | undefined) {
    this.label = worlds === undefined ? "Reset Worlds" : "Set Worlds";
  }

  apply(doc: SceneDocument): Change[] {
    const entry = doc.node(this.node).components?.[this.position];
    if (!entry) throw new Error(`"${this.node}" has no component at position ${this.position}.`);
    if (this.worlds === undefined) delete entry.worlds;
    // After `enabled` (or `type`), before `data`: where a person would write it.
    else setKey(entry, "worlds", [...this.worlds], ["type", "enabled"]);
    return [{ kind: "rebuild", node: this.node }];
  }
}

/**
 * Set a node's tags (ADR 0042): a plain node's, or a prefab instance's own (replacing the prefab
 * root's). An empty list removes the key; on an instance, `undefined` goes back to the prefab's
 * tags. Nodes inside an instance take a `tags` override instead (`SetOverrides`).
 */
export class SetTags implements Command {
  readonly label = "Set tags";

  constructor(readonly node: string, readonly tags: readonly string[] | undefined) {}

  apply(doc: SceneDocument): Change[] {
    const entry = doc.node(this.node);
    if (this.tags === undefined || (this.tags.length === 0 && !entry.prefab)) delete entry.tags;
    // After id, name, parent and active, as a person would write it.
    else setKey(entry, "tags", [...this.tags], ["id", "name", "parent", "active"]);
    return [{ kind: "rebuild", node: this.node }];
  }
}

/**
 * Change a top-level node's id: its entry, its children's `parent`, and every `{"$node": id}` reference in
 * the document (component data, overrides) that points at it. The caller checks `to` is free. Every top-level
 * node, before and after, is rebuilt, since a reference anywhere may have changed.
 */
export class RenameNodeId implements Command {
  readonly label = "Change Id";

  constructor(readonly from: string, readonly to: string) {}

  apply(doc: SceneDocument): Change[] {
    const roots = new Set(doc.roots());
    const entries = doc._entries;
    const at = entries.findIndex((e) => e.id === this.from);
    if (at < 0) throw new Error(`No node "${this.from}".`);
    if (this.to !== this.from && doc.has(this.to)) throw new Error(`Node id "${this.to}" is already in use.`);
    const remap = (id: string) => (id === this.from ? this.to : id);
    entries.forEach((e, i) => {
      let next: NodeEntry = i === at ? { ...e, id: this.to } : e;
      if (next.parent === this.from) next = { ...next, parent: this.to };
      entries[i] = mapEntryNodeRefs(next, remap);
    });
    doc._reindex();
    for (const id of doc.roots()) roots.add(id);
    return [...roots].map((node) => ({ kind: "rebuild", node }) as const);
  }
}

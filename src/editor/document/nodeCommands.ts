import { setKey, type Change, type Command } from "./commands";
import type { SceneDocument } from "./SceneDocument";

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

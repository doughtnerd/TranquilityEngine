import type { Change, Command } from "./commands";
import type { SceneDocument } from "./SceneDocument";

/**
 * Set the Worlds a component entry of a plain node is created in (ADR 0033 §3, 0038): its
 * `worlds` key, removed with `undefined` (back to the component's own setting). Undo puts the
 * entry back exactly. On prefab instances this is a `worlds` override instead (`SetOverrides`).
 */
export class SetComponentWorlds implements Command {
  readonly label: string;
  private before: Record<string, unknown> | null = null;

  constructor(readonly node: string, readonly position: number, readonly worlds: readonly string[] | undefined) {
    this.label = worlds === undefined ? "Reset Worlds" : "Set Worlds";
  }

  apply(doc: SceneDocument): Change[] {
    const entry = doc.node(this.node).components?.[this.position];
    if (!entry) throw new Error(`"${this.node}" has no component at position ${this.position}.`);
    this.before = { ...entry };
    if (this.worlds === undefined) delete entry.worlds;
    else if ("worlds" in entry) entry.worlds = [...this.worlds];
    else {
      // After `enabled` (or `type`), before `data`: where a person would write it.
      const { type, enabled, ...rest } = entry;
      for (const k of Object.keys(entry)) delete (entry as unknown as Record<string, unknown>)[k];
      Object.assign(entry, { type, ...(enabled !== undefined ? { enabled } : {}), worlds: [...this.worlds] }, rest);
    }
    return [{ kind: "rebuild", node: this.node }];
  }

  undo(doc: SceneDocument): Change[] {
    const entry = doc.node(this.node).components![this.position] as unknown as Record<string, unknown>;
    for (const k of Object.keys(entry)) delete entry[k];
    Object.assign(entry, this.before);
    return [{ kind: "rebuild", node: this.node }];
  }
}

/**
 * Set a node's tags (ADR 0038): a plain node's, or a prefab instance's own (replacing the prefab
 * root's). An empty list removes the key; on an instance, `undefined` goes back to the prefab's
 * tags. Nodes inside an instance take a `tags` override instead (`SetOverrides`).
 */
export class SetTags implements Command {
  readonly label = "Set tags";
  private before: Record<string, unknown> | null = null;

  constructor(readonly node: string, readonly tags: readonly string[] | undefined) {}

  apply(doc: SceneDocument): Change[] {
    const entry = doc.node(this.node) as unknown as Record<string, unknown>;
    this.before = { ...entry };
    const remove = this.tags === undefined || (this.tags.length === 0 && !entry.prefab);
    if (remove) delete entry.tags;
    else if ("tags" in entry) entry.tags = [...this.tags!];
    else {
      // After id, name, parent and active, as a person would write it.
      const keys = Object.keys(entry);
      const anchor = Math.max(-1, ...["id", "name", "parent", "active"].map((k) => keys.indexOf(k)));
      const entries = Object.entries(entry);
      entries.splice(anchor + 1, 0, ["tags", [...this.tags!]]);
      for (const k of keys) delete entry[k];
      for (const [k, v] of entries) entry[k] = v;
    }
    return [{ kind: "rebuild", node: this.node }];
  }

  undo(doc: SceneDocument): Change[] {
    const entry = doc.node(this.node) as unknown as Record<string, unknown>;
    for (const k of Object.keys(entry)) delete entry[k];
    Object.assign(entry, this.before);
    return [{ kind: "rebuild", node: this.node }];
  }
}

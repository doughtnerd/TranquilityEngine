import type { Change, Command } from "./commands";
import { sameTarget, type OverrideEntry, type SceneDocument } from "./SceneDocument";

/**
 * Remove overrides from a prefab instance, putting the prefab's own values back (ADR 0013, 0026).
 * `which` picks the overrides to remove (all of them by default). Undo restores them in place.
 * The instance is rebuilt, since only a fresh instance knows the prefab's values; so are the
 * instances in `alsoRebuild` (used when the prefab file itself changed).
 */
export class RevertOverrides implements Command {
  private removed: { at: number; entry: OverrideEntry }[] = [];
  private hadList = false;

  constructor(
    readonly instance: string,
    readonly label = "Revert overrides",
    private readonly which: (o: OverrideEntry) => boolean = () => true,
    private readonly alsoRebuild: readonly string[] = [],
  ) {}

  apply(doc: SceneDocument): Change[] {
    const entry = doc.node(this.instance);
    if (!entry.prefab) throw new Error(`"${this.instance}" is not a prefab instance.`);
    this.hadList = entry.overrides !== undefined;
    const list = entry.overrides ?? [];
    this.removed = [];
    list.forEach((o, at) => { if (this.which(o)) this.removed.push({ at, entry: o }); });
    for (let i = this.removed.length - 1; i >= 0; i--) list.splice(this.removed[i].at, 1);
    if (list.length === 0) delete entry.overrides;
    return this.rebuilds();
  }

  undo(doc: SceneDocument): Change[] {
    const entry = doc.node(this.instance);
    const list = (entry.overrides ??= []);
    for (const { at, entry: o } of this.removed) list.splice(at, 0, o);
    if (list.length === 0 && !this.hadList) delete entry.overrides;
    return this.rebuilds();
  }

  /** How many overrides the last `apply` removed. */
  get count(): number {
    return this.removed.length;
  }

  private rebuilds(): Change[] {
    return [...new Set([this.instance, ...this.alsoRebuild])].map((node) => ({ kind: "rebuild", node }) as const);
  }
}

/**
 * Rebuild instances in the Editor World without changing the document: after their prefab file
 * changed on disk (Apply, or saving a prefab), so they show its new contents. Undo rebuilds too.
 */
export class RebuildInstances implements Command {
  readonly label = "Update prefab instances";
  constructor(readonly instances: readonly string[]) {}

  apply(): Change[] {
    return this.instances.map((node) => ({ kind: "rebuild", node }) as const);
  }

  undo(): Change[] {
    return this.apply();
  }
}

/**
 * Replace a prefab instance's overrides with `next` (used to add or remove components on an
 * instance, which also renumbers or drops the field overrides that pointed at them). Undo puts
 * the previous list back exactly. The instance is rebuilt.
 */
export class SetOverrides implements Command {
  private previous: OverrideEntry[] | undefined;

  constructor(readonly instance: string, readonly label: string, private readonly next: readonly OverrideEntry[]) {}

  apply(doc: SceneDocument): Change[] {
    const entry = doc.node(this.instance);
    if (!entry.prefab) throw new Error(`"${this.instance}" is not a prefab instance.`);
    this.previous = entry.overrides;
    if (this.next.length > 0) entry.overrides = structuredClone([...this.next]);
    else delete entry.overrides;
    return [{ kind: "rebuild", node: this.instance }];
  }

  undo(doc: SceneDocument): Change[] {
    const entry = doc.node(this.instance);
    if (this.previous) entry.overrides = this.previous;
    else delete entry.overrides;
    return [{ kind: "rebuild", node: this.instance }];
  }
}

/** True if `o` is the editor's name (or active) override for `target`: just a target and that key. */
export function isInnerPropertyOverride(o: OverrideEntry, target: readonly string[], key: "name" | "active"): boolean {
  return o[key] !== undefined && sameTarget(o.target, target) && Object.keys(o).every((k) => k === "target" || k === key);
}

/**
 * Rename or (de)activate a node inside a prefab instance (ADR 0122): writes the instance's
 * `{ target, name }` or `{ target, active }` override, replacing an earlier one, or with `value`
 * undefined removes it (the node goes back to the prefab's value). `target` mustn't be empty: the
 * instance root's name and active flag are on its own entry (`RenameNode`, `SetActive`).
 */
export class SetInnerNodeProperty implements Command {
  readonly label: string;
  private previous: OverrideEntry[] | undefined;

  constructor(
    readonly instance: string,
    readonly target: readonly string[],
    readonly key: "name" | "active",
    readonly value: string | boolean | undefined,
  ) {
    if (target.length === 0) throw new Error("SetInnerNodeProperty needs a target inside the instance.");
    this.label = key === "name" ? "Rename" : value === false ? "Deactivate" : "Activate";
  }

  apply(doc: SceneDocument): Change[] {
    const entry = doc.node(this.instance);
    if (!entry.prefab) throw new Error(`"${this.instance}" is not a prefab instance.`);
    this.previous = entry.overrides;
    const list = structuredClone(entry.overrides ?? []);
    const at = list.findIndex((o) => isInnerPropertyOverride(o, this.target, this.key));
    if (this.value === undefined) {
      if (at >= 0) list.splice(at, 1);
    } else {
      const o: OverrideEntry = { target: [...this.target], [this.key]: this.value };
      if (at >= 0) list[at] = o;
      else list.push(o);
    }
    if (list.length > 0) entry.overrides = list;
    else delete entry.overrides;
    return [this.change()];
  }

  undo(doc: SceneDocument): Change[] {
    const entry = doc.node(this.instance);
    if (this.previous) entry.overrides = this.previous;
    else delete entry.overrides;
    return [this.change()];
  }

  private change(): Change {
    return { kind: this.key, node: this.instance, path: [this.instance, ...this.target] };
  }
}

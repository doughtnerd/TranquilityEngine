import type { Change, Command } from "./commands";
import type { OverrideEntry, SceneDocument } from "./SceneDocument";

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

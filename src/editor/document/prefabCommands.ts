import type { Change, Command } from "./commands";
import type { OverrideEntry, SceneDocument } from "./SceneDocument";

/**
 * Remove overrides from a prefab instance, putting the prefab's own values back (ADR 0013, 0026).
 * `which` picks the overrides to remove (all of them by default). The instance is rebuilt, since
 * only a fresh instance knows the prefab's values; so are the instances in `alsoRebuild` (used
 * when the prefab file itself changed).
 */
export class RevertOverrides implements Command {
  constructor(
    readonly instance: string,
    readonly label = "Revert overrides",
    private readonly which: (o: OverrideEntry) => boolean = () => true,
    private readonly alsoRebuild: readonly string[] = [],
  ) {}

  apply(doc: SceneDocument): Change[] {
    const entry = doc.node(this.instance);
    if (!entry.prefab) throw new Error(`"${this.instance}" is not a prefab instance.`);
    const kept = (entry.overrides ?? []).filter((o) => !this.which(o));
    if (kept.length) entry.overrides = kept;
    else delete entry.overrides;
    return [...new Set([this.instance, ...this.alsoRebuild])].map((node) => ({ kind: "rebuild", node }) as const);
  }
}

/**
 * Replace a prefab instance's overrides with `next`: the command the override writer
 * (`overrideWriter.ts`, ADR 0287) issues for every override edit. `changes` says what the Editor
 * World must redo: by default the instance is rebuilt; a name or active override reports just
 * that node's name or flag.
 */
export class SetOverrides implements Command {
  private readonly changes: readonly Change[];

  constructor(readonly instance: string, readonly label: string, private readonly next: readonly OverrideEntry[], changes?: readonly Change[]) {
    this.changes = changes ?? [{ kind: "rebuild", node: instance }];
  }

  apply(doc: SceneDocument): Change[] {
    const entry = doc.node(this.instance);
    if (!entry.prefab) throw new Error(`"${this.instance}" is not a prefab instance.`);
    if (this.next.length > 0) entry.overrides = structuredClone([...this.next]);
    else delete entry.overrides;
    return [...this.changes];
  }
}

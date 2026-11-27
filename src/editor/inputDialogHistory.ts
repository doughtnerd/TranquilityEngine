// The Input dialog's one edit history (ADR 0417) across every file it edits: action sets, contexts, and both in one
// step (changing an action's type converts its controls in every context). It is 0027's tree (`HistoryTree`): undoing
// then editing starts a branch and keeps the old one. Each state holds a text patch per file the step changed (the
// `FilePatch` an asset document's history keeps for its one file), applied to the files as they are when moving, so a
// file changed elsewhere since refuses the move instead of being overwritten. Writes go through the store in order;
// `saving` counts the ones in flight for the dialog's footer. Not persisted: the history lives as long as the dialog's
// project is open.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { HISTORY_LIMIT, HistoryTree, type HistoryMove, type HistoryState, type StepAdapter } from "./document/HistoryTree";
import { applyFilePatch, diffText, type FilePatch } from "./document/textPatch";

/** Where the history reads and writes files (the project; a map in tests). */
export interface HistoryFileStore {
  read(path: string): string | undefined;
  write(path: string, text: string): Promise<void>;
}

/** One file's change in a step: its text before and after. */
export interface FileEdit {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

/** Texts by path, as a move carries them along the path between two states. */
type Texts = ReadonlyMap<string, string>;

/** Each state's patches, forward in order, backward in reverse; a patch that doesn't fit the file refuses the move. */
const steps: StepAdapter<Texts> = {
  step(texts, state, direction) {
    const files = state.files ?? [];
    const out = new Map(texts);
    for (const patch of direction === "redo" ? files : [...files].reverse()) {
      const text = out.get(patch.path);
      if (text === undefined) return null;
      const next = applyFilePatch(text, patch, direction);
      if (next === null) return null;
      out.set(patch.path, next);
    }
    return out;
  },
};

/** The paths a move touches: every file a state on the way changed. */
function pathsOn(tree: HistoryTree, target: number): string[] {
  const { up, down } = tree.path(tree.current, target);
  const out = new Set<string>();
  for (const seq of [...up, ...down]) for (const p of tree.state(seq).files ?? []) out.add(p.path);
  return [...out];
}

export class InputDialogHistory {
  private readonly tree = new HistoryTree("", HISTORY_LIMIT);
  private readonly changed = signal(0);
  private readonly inFlight = signal(0);
  private tail: Promise<void> = Promise.resolve();
  /** Texts written but not yet on disk, newest per path: what the files hold once the queue is done. */
  private readonly pending = new Map<string, { text: string; writes: number }>();
  /** Bumped on every change to the tree (a step, a move). */
  readonly version: ReadonlySignal<number> = this.changed;
  /** True while writes are in flight. */
  readonly saving: ReadonlySignal<boolean> = computed(() => this.inFlight.value > 0);
  /** The last write's error, or null. */
  readonly failed = signal<string | null>(null);

  constructor(private readonly store: HistoryFileStore) {}

  /** A file's text as the dialog's edits leave it: a queued write's text, else the store's. Bumps with `version`. */
  text(path: string): string | undefined {
    return this.pending.get(path)?.text ?? this.store.read(path);
  }

  /** Record a step changing files (each `before` is its text now) and write them. False when nothing changed. */
  record(label: string, edits: readonly FileEdit[]): boolean {
    const files: FilePatch[] = edits.filter((e) => e.before !== e.after).map((e) => ({ path: e.path, ...diffText(e.before, e.after) }));
    if (files.length === 0) return false;
    this.tree.add({ label, hash: "", files });
    this.tree.markSaved();
    this.changed.value++;
    for (const e of edits) if (e.before !== e.after) this.write(e.path, e.after);
    return true;
  }

  get canUndo(): boolean {
    return (this.changed.value, this.tree.targetOf("undo") !== null);
  }

  get canRedo(): boolean {
    return (this.changed.value, this.tree.targetOf("redo") !== null);
  }

  get undoLabel(): string | null {
    return (this.changed.value, this.tree.labelOf("undo"));
  }

  get redoLabel(): string | null {
    return (this.changed.value, this.tree.labelOf("redo"));
  }

  get states(): readonly HistoryState[] {
    return (this.changed.value, this.tree.allStates);
  }

  get current(): number {
    return (this.changed.value, this.tree.current);
  }

  /** Every state is written as it's reached, so the current one is the saved one. */
  get saved(): number {
    return this.current;
  }

  /**
   * Move through the tree and write the files that changed. Returns the step's label, or null when there was no
   * such move, or a file changed elsewhere so the step no longer fits it (nothing changes then).
   */
  go(move: HistoryMove): { label: string; paths: string[] } | null {
    const target = this.tree.targetOf(move);
    if (target === null) return null;
    const paths = pathsOn(this.tree, target);
    const texts = new Map<string, string>();
    for (const p of paths) {
      const t = this.text(p);
      if (t !== undefined) texts.set(p, t);
    }
    const moved = this.tree.go(move, texts as Texts, steps);
    if (!moved) return null;
    this.tree.markSaved();
    this.changed.value++;
    for (const p of paths) {
      const t = moved.value.get(p);
      if (t !== undefined && t !== texts.get(p)) this.write(p, t);
    }
    return { label: moved.label, paths };
  }

  undo(): ReturnType<InputDialogHistory["go"]> {
    return this.go("undo");
  }

  redo(): ReturnType<InputDialogHistory["go"]> {
    return this.go("redo");
  }

  /** Resolves when every write so far is done. */
  flush(): Promise<void> {
    return this.tail;
  }

  private write(path: string, text: string): void {
    this.inFlight.value++;
    const entry = { text, writes: (this.pending.get(path)?.writes ?? 0) + 1 };
    this.pending.set(path, entry);
    const settled = () => {
      const now = this.pending.get(path);
      if (now && --now.writes === 0) this.pending.delete(path);
    };
    this.tail = this.tail
      .then(() => this.store.write(path, text))
      .finally(settled)
      .then(
        () => void (this.failed.value = null),
        (err) => void (this.failed.value = `Couldn't save ${path}: ${(err as Error)?.message ?? err}`),
      )
      .finally(() => void this.inFlight.value--);
  }
}

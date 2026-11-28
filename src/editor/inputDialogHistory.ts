// The Input dialog's one edit history (ADR 0433) across every file it edits: action sets, contexts, and both in one
// step (changing an action's type converts its controls in every context). It is 0027's tree (`HistoryTree`): undoing
// then editing starts a branch and keeps the old one. Each state holds a text patch per file the step changed (the
// `FilePatch` an asset document's history keeps for its one file), applied to the files as they are when moving, so a
// file changed elsewhere since refuses the move instead of being overwritten. Writes go through the store in order;
// `saving` counts the ones in flight for the dialog's footer. Making and deleting a file are steps too (a patch marked
// `created` or `removed`, as the scene's history keeps them): undoing a made file deletes it, undoing a deletion writes
// the file back. Not persisted: the history lives as long as the dialog's project is open.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { HISTORY_LIMIT, HistoryTree, type HistoryMove, type HistoryState, type StepAdapter } from "./document/HistoryTree";
import { applyFilePatch, diffText, type FilePatch } from "./document/textPatch";

/** Where the history reads, writes and deletes files (the project; a map in tests). `read` gives undefined for no file. */
export interface HistoryFileStore {
  read(path: string): string | undefined;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** One file's change in a step: its text before and after; null is no file (`before` null: made; `after` null: deleted). */
export interface FileEdit {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

/** Texts by path (null: no file), as a move carries them along the path between two states. */
type Texts = ReadonlyMap<string, string | null>;

/** One patch applied to a file's text (null: no file), or undefined when it doesn't fit (the file changed elsewhere). */
function applyPatch(text: string | null, patch: FilePatch, direction: "undo" | "redo"): string | null | undefined {
  const [from, to] = direction === "undo" ? [patch.after, patch.before] : [patch.before, patch.after];
  const deletes = direction === "undo" ? patch.created : patch.removed;
  const creates = direction === "undo" ? patch.removed : patch.created;
  if (creates) return text === null ? to : undefined;
  if (deletes) return text === from ? null : undefined;
  if (text === null) return undefined;
  return applyFilePatch(text, patch, direction) ?? undefined;
}

/** Each state's patches, forward in order, backward in reverse; a patch that doesn't fit the file refuses the move. */
const steps: StepAdapter<Texts> = {
  step(texts, state, direction) {
    const files = state.files ?? [];
    const out = new Map(texts);
    for (const patch of direction === "redo" ? files : [...files].reverse()) {
      const next = applyPatch(out.get(patch.path) ?? null, patch, direction);
      if (next === undefined) return null;
      out.set(patch.path, next);
    }
    return out;
  },
};

/** A step's patch for one file edit. */
function patchOf(e: FileEdit): FilePatch {
  if (e.before === null) return { path: e.path, start: 0, before: "", after: e.after ?? "", created: true };
  if (e.after === null) return { path: e.path, start: 0, before: e.before, after: "", removed: true };
  return { path: e.path, ...diffText(e.before, e.after) };
}

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
  /** Texts written but not yet on disk (null: a deletion), newest per path: what the files hold once the queue is done. */
  private readonly pending = new Map<string, { text: string | null; writes: number }>();
  /** Bumped on every change to the tree (a step, a move). */
  readonly version: ReadonlySignal<number> = this.changed;
  /** True while writes are in flight. */
  readonly saving: ReadonlySignal<boolean> = computed(() => this.inFlight.value > 0);
  /** The last write's error, or null. */
  readonly failed = signal<string | null>(null);

  constructor(private readonly store: HistoryFileStore) {}

  /** A file's text as the dialog's edits leave it: a queued write's text, else the store's; undefined for no file. Bumps with `version`. */
  text(path: string): string | undefined {
    const pending = this.pending.get(path);
    if (pending) return pending.text ?? undefined;
    return this.store.read(path);
  }

  /** `files` (the store's list) as the dialog's edits leave it: with the files being made, without those being deleted. */
  files(files: readonly string[]): string[] {
    const out = files.filter((f) => this.pending.get(f)?.text !== null);
    for (const [path, p] of this.pending) if (p.text !== null && !files.includes(path)) out.push(path);
    return out;
  }

  /** Record a step changing, making or deleting files (each `before` is its text now, null when there's none) and write them. False when nothing changed. */
  record(label: string, edits: readonly FileEdit[]): boolean {
    const changed = edits.filter((e) => e.before !== e.after);
    if (changed.length === 0) return false;
    this.tree.add({ label, hash: "", files: changed.map(patchOf) });
    this.tree.markSaved();
    this.changed.value++;
    for (const e of changed) this.write(e.path, e.after);
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
    const texts = new Map<string, string | null>();
    for (const p of paths) texts.set(p, this.text(p) ?? null);
    const moved = this.tree.go(move, texts as Texts, steps);
    if (!moved) return null;
    this.tree.markSaved();
    this.changed.value++;
    for (const p of paths) {
      const t = moved.value.get(p) ?? null;
      if (t !== texts.get(p)) this.write(p, t);
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

  /** Write a file, or delete it (`text` null), after the writes before it. */
  private write(path: string, text: string | null): void {
    this.inFlight.value++;
    const entry = { text, writes: (this.pending.get(path)?.writes ?? 0) + 1 };
    this.pending.set(path, entry);
    const settled = () => {
      const now = this.pending.get(path);
      if (now && --now.writes === 0) this.pending.delete(path);
    };
    this.tail = this.tail
      .then(() => (text === null ? this.store.remove(path) : this.store.write(path, text)))
      .finally(settled)
      .then(
        () => void (this.failed.value = null),
        (err) => void (this.failed.value = `Couldn't ${text === null ? "delete" : "save"} ${path}: ${(err as Error)?.message ?? err}`),
      )
      .finally(() => void this.inFlight.value--);
  }
}

import type { Change, Command, FileWrite } from "./commands";
import { HISTORY_LIMIT, HistoryTree, type AgeOptions, type HistoryFile, type HistoryMove, type HistoryState, type StepAdapter } from "./HistoryTree";
import { applyPatch, changesBetween, diffFiles, hashFile, type DocPatch } from "./patch";
import type { SceneDocument, SceneFile } from "./SceneDocument";
import { applyFilePatch, diffText, type FilePatch } from "./textPatch";

/** What happened, passed to `CommandStack` listeners. */
export interface StackEvent {
  readonly reason: "execute" | "group" | "cancel" | "undo" | "redo" | "jump" | "save" | "load";
  readonly label: string;
  readonly changes: readonly Change[];
}

export type StackListener = (event: StackEvent) => void;

/**
 * Where a CommandStack reads and writes the text files commands change (`Command.files`). Reads
 * must see writes at once (the host queues the actual file writes).
 */
export interface TextFileHost {
  /** The file's current text, or null when there's none. */
  read(path: string): string | null;
  write(path: string, text: string): void;
  remove(path: string): void;
  /** Undo or redo found a file changed elsewhere since the step: it's left as it is. */
  conflict?(path: string, label: string): void;
}

const emptyPatch = (p: DocPatch | undefined) => !p || (!p.nodes && !p.order && !p.top);

/**
 * Edit history over a SceneDocument as a tree of states (ADR 0027). Every edit goes through
 * `execute`; wrap a gesture (e.g. a gizmo drag) in `beginGroup`/`endGroup` to make it one step.
 * Undoing and then editing starts a new branch; the old one stays reachable (`jumpTo`, redo after
 * navigating, or `back`/`forward` in creation order). Listeners hear every change, including each
 * command inside an open group, so the World and UI stay live during a drag.
 *
 * Commands may also write text files (`Command.files`: UI edits to Svelte sources, ADR 0423): the stack writes
 * them through `files` and keeps each file's change in the step, so undo and redo write them back
 * in order with scene edits. A step that only changed files doesn't make the scene dirty.
 *
 * The tree itself (navigation, pruning, the history file) is the `HistoryTree` (ADR 0267); this
 * stack adds groups, listeners and dirtiness, and is the scene's step adapter: each state's
 * document patch, plus the text files it wrote. Those patches are the only undo: commands only
 * apply (ADR 0321).
 */
export class CommandStack {
  private readonly tree: HistoryTree;
  private stepBefore: SceneFile | null = null;
  private groupDepth = 0;
  private groupLabel = "";
  private listeners = new Set<StackListener>();
  /** Each file's text before the step being recorded, for the files its commands write. */
  private filesBefore: Map<string, string | null> | null = null;
  /** Where commands' text files are read and written; null refuses commands that write files. */
  files: TextFileHost | null = null;

  constructor(readonly doc: SceneDocument, readonly limit = HISTORY_LIMIT) {
    this.tree = new HistoryTree(hashFile(doc.toJSON()), limit);
  }

  /** Listen for changes. Returns an unsubscribe function. */
  subscribe(listener: StackListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- editing --------------------------------------------------------------------------------

  /** Apply a command and record it as a step (or part of the open group). */
  execute(command: Command): void {
    const writes = command.files;
    if (writes?.length && !this.files) throw new Error("This document can't write files.");
    this.stepBefore ??= this.doc.toJSON();
    const changes = command.apply(this.doc);
    if (writes?.length) this.writeFiles(writes);
    this.emit({ reason: "execute", label: command.label, changes });
    if (this.groupDepth === 0) this.commit(command.label);
  }

  /** Start a group: commands executed until the matching `endGroup` are one step. Groups nest. */
  beginGroup(label: string): void {
    if (this.groupDepth++ === 0) {
      this.groupLabel = label;
      this.stepBefore = this.doc.toJSON();
    }
  }

  /** Close the group opened by `beginGroup`. A group that changed nothing records nothing. */
  endGroup(): void {
    if (this.groupDepth === 0) throw new Error("endGroup() without beginGroup().");
    if (--this.groupDepth > 0) return;
    // Undo/redo availability and dirtiness change only now; the group's edits were already emitted.
    if (this.commit(this.groupLabel)) this.emit({ reason: "group", label: this.groupLabel, changes: [] });
  }

  /**
   * Close the open group without recording it (ADR 0231: a cancelled gesture). The outermost group puts the
   * document, and the text files its commands wrote, back as they were when it began, and tells listeners what
   * changed; a nested group can't be taken out of the one around it, so it just closes. Returns whether the
   * edits were reverted.
   */
  cancelGroup(): boolean {
    if (this.groupDepth === 0) throw new Error("cancelGroup() without beginGroup().");
    if (--this.groupDepth > 0) return false;
    const before = this.stepBefore, filesBefore = this.filesBefore;
    this.stepBefore = null;
    this.filesBefore = null;
    if (filesBefore && this.files) for (const [path, was] of filesBefore) was === null ? this.files.remove(path) : this.files.write(path, was);
    const now = this.doc.toJSON();
    const changes = before ? changesBetween(now, before) : [];
    if (changes.length) this.doc._replace(before!);
    this.emit({ reason: "cancel", label: this.groupLabel, changes });
    return true;
  }

  private writeFiles(writes: readonly FileWrite[]): void {
    const files = this.files!;
    this.filesBefore ??= new Map();
    for (const w of writes) {
      if (!this.filesBefore.has(w.path)) this.filesBefore.set(w.path, files.read(w.path));
      if (w.text === null) files.remove(w.path);
      else files.write(w.path, w.text);
    }
  }

  /** What the step did to each file it wrote (none for files it left as they were). */
  private filePatches(before: ReadonlyMap<string, string | null>): FilePatch[] {
    const out: FilePatch[] = [];
    for (const [path, was] of before) {
      const now = this.files!.read(path);
      if (was === now) continue;
      if (was === null) out.push({ path, start: 0, before: "", after: now!, created: true });
      else if (now === null) out.push({ path, start: 0, before: was, after: "", removed: true });
      else out.push({ path, ...diffText(was, now) });
    }
    return out;
  }

  /** Write a state's file changes forward (redo) or back (undo); files changed elsewhere since are left. */
  private replayFiles(state: HistoryState, direction: "undo" | "redo"): void {
    const host = this.files;
    if (!state.files || !host) return;
    const list = direction === "undo" ? [...state.files].reverse() : state.files;
    for (const f of list) {
      const current = host.read(f.path);
      const [from, to] = direction === "undo" ? [f.after, f.before] : [f.before, f.after];
      const deletes = direction === "undo" ? f.created : f.removed;
      const creates = direction === "undo" ? f.removed : f.created;
      if (creates) {
        if (current === null) host.write(f.path, to);
        else if (current !== to) host.conflict?.(f.path, state.label);
      } else if (deletes) {
        if (current === from) host.remove(f.path);
        else if (current !== null) host.conflict?.(f.path, state.label);
      } else {
        const text = current === null ? null : applyFilePatch(current, f, direction);
        if (text === null) host.conflict?.(f.path, state.label);
        else host.write(f.path, text);
      }
    }
  }

  /** Record the step since `stepBefore` as a new child of the current state. */
  private commit(label: string): boolean {
    const before = this.stepBefore;
    const filesBefore = this.filesBefore;
    this.stepBefore = null;
    this.filesBefore = null;
    if (!before) return false;
    const after = this.doc.toJSON();
    const d = diffFiles(before, after);
    const files = filesBefore ? this.filePatches(filesBefore) : [];
    if (!d && files.length === 0) return false;
    this.tree.add({ label, hash: hashFile(after), redo: d?.redo ?? {}, undo: d?.undo ?? {}, files });
    return true;
  }

  // --- navigation -----------------------------------------------------------------------------

  private get inGroup(): boolean {
    return this.groupDepth > 0;
  }

  get canUndo(): boolean {
    return !this.inGroup && this.tree.targetOf("undo") !== null;
  }

  get canRedo(): boolean {
    return !this.inGroup && this.tree.targetOf("redo") !== null;
  }

  /** Label of the step `undo()` would revert, or null. */
  get undoLabel(): string | null {
    return this.inGroup ? null : this.tree.labelOf("undo");
  }

  get redoLabel(): string | null {
    return this.tree.labelOf("redo");
  }

  /** Go back to the parent state. Returns false if there's nothing to undo (or a group is open). */
  undo(): boolean {
    return this.navigate("undo", "undo");
  }

  /** Go to the child last visited (the newest branch unless you navigated elsewhere). */
  redo(): boolean {
    return this.navigate("redo", "redo");
  }

  /** Go to any state, undoing to the common ancestor and redoing down from there. */
  jumpTo(seq: number): boolean {
    return this.navigate(seq, "jump");
  }

  /** The previous state in creation order (like Vim's g-), across branches. */
  back(): boolean {
    return this.navigate("back", "jump");
  }

  /** The next state in creation order (like Vim's g+). */
  forward(): boolean {
    return this.navigate("forward", "jump");
  }

  /**
   * Move the document along the tree and tell listeners what changed. The scene's step adapter
   * applies each state's document patch and refuses one that is missing or doesn't fit (a damaged
   * history: nothing changes); the text files the steps wrote are replayed once the move succeeded.
   */
  private navigate(move: HistoryMove, reason: StackEvent["reason"]): boolean {
    if (this.inGroup) return false;
    const before = this.doc.toJSON();
    const replays: [HistoryState, "undo" | "redo"][] = [];
    const scene: StepAdapter<SceneFile> = {
      step(file, state, direction) {
        const patch = direction === "undo" ? state.undo : state.redo;
        if (!patch) return null;
        let next: SceneFile;
        try {
          next = applyPatch(file, patch);
        } catch {
          return null; // a patch naming a node that isn't there
        }
        replays.push([state, direction]);
        return next;
      },
    };
    const moved = this.tree.go(move, before, scene);
    if (!moved) return false;
    for (const [state, direction] of replays) this.replayFiles(state, direction);
    this.doc._replace(moved.value);
    this.emit({ reason, label: moved.label, changes: changesBetween(before, moved.value) });
    return true;
  }

  // --- saving and state -------------------------------------------------------------------------

  /**
   * True if the document differs from the last save point: a step between them changed the scene
   * (steps that only wrote text files, which are saved as they're made, don't count).
   */
  get dirty(): boolean {
    const { current, saved } = this.tree;
    if (current === saved) return false;
    if (!this.tree.has(saved)) return true;
    const { up, down } = this.tree.path(current, saved);
    return [...up, ...down].some((s) => !emptyPatch(this.tree.state(s).redo));
  }

  /** Record the current state as saved (call after writing the file). */
  markSaved(): void {
    this.tree.markSaved();
    this.emit({ reason: "save", label: "Save", changes: [] });
  }

  /** Forget all history: the current document becomes the root, counted as saved. */
  clear(): void {
    this.tree.reset(hashFile(this.doc.toJSON()));
    this.stepBefore = null;
    this.filesBefore = null;
    this.groupDepth = 0;
  }

  /** Every state, oldest first (for the History panel). */
  get allStates(): readonly HistoryState[] {
    return this.tree.allStates;
  }

  get current(): number {
    return this.tree.current;
  }

  get saved(): number {
    return this.tree.saved;
  }

  get root(): number {
    return this.tree.root;
  }

  /** Ids of a state's children, oldest first. */
  childrenOf(seq: number): number[] {
    return this.tree.childrenOf(seq);
  }

  // --- persistence ------------------------------------------------------------------------------

  /** The tree as a history file for `scene`, without the states `options.pruneDays` drops (ADR 0116). */
  toFile(scene: string, options?: AgeOptions): HistoryFile {
    return this.tree.toFile(scene, options);
  }

  /**
   * Adopt a saved history whose states include the document as it is now (the file on disk), pruned
   * by age first (`options`). Returns the state the history was at when written (to offer restoring
   * it), or null, changing nothing, if the file is damaged or no state matches the document.
   */
  load(file: HistoryFile, options?: AgeOptions): { matched: number; lastCurrent: number } | null {
    const result = this.tree.load(file, hashFile(this.doc.toJSON()), options);
    if (!result) return null;
    this.stepBefore = null;
    this.filesBefore = null;
    this.groupDepth = 0;
    this.emit({ reason: "load", label: "Load history", changes: [] });
    return result;
  }

  private emit(event: StackEvent): void {
    for (const l of [...this.listeners]) l(event);
  }
}

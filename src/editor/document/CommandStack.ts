import type { Change, Command } from "./commands";
import { applyPatch, changesBetween, diffFiles, hashFile, type DocPatch } from "./patch";
import type { SceneDocument, SceneFile } from "./SceneDocument";

/** What happened, passed to `CommandStack` listeners. */
export interface StackEvent {
  readonly reason: "execute" | "group" | "undo" | "redo" | "jump" | "save" | "load";
  readonly label: string;
  readonly changes: readonly Change[];
}

export type StackListener = (event: StackEvent) => void;

/** One state of the history tree (ADR 0027). */
export interface HistoryState {
  /** Creation order; state 0 is the document as history began. */
  readonly seq: number;
  /** The state this one was made from; -1 for the root. */
  parent: number;
  readonly label: string;
  /** When it was made (ms since the epoch). */
  readonly time: number;
  /** `hashFile` of the document in this state. */
  readonly hash: string;
  /** From the parent to this state, and back. Absent on the root. */
  redo?: DocPatch;
  undo?: DocPatch;
  /** The child redo goes to: the one last visited. */
  redoChild?: number;
}

/** The history tree as written to a history file (ADR 0027). */
export interface HistoryFile {
  format: "myco.history@1";
  /** Project-relative path of the scene this history belongs to. */
  scene: string;
  root: number;
  current: number;
  /** The state matching the file as last saved (-1 if that state was pruned). */
  saved: number;
  nextSeq: number;
  states: HistoryState[];
}

/** Most states kept (like Vim's 'undolevels'). */
export const HISTORY_LIMIT = 1000;

/**
 * Edit history over a SceneDocument as a tree of states (ADR 0027). Every edit goes through
 * `execute`; wrap a gesture (e.g. a gizmo drag) in `beginGroup`/`endGroup` to make it one step.
 * Undoing and then editing starts a new branch; the old one stays reachable (`jumpTo`, redo after
 * navigating, or `back`/`forward` in creation order). Listeners hear every change, including each
 * command inside an open group, so the World and UI stay live during a drag.
 */
export class CommandStack {
  private states = new Map<number, HistoryState>();
  private rootSeq = 0;
  private currentSeq = 0;
  private savedSeq = 0;
  private nextSeq = 1;
  private stepBefore: SceneFile | null = null;
  private groupDepth = 0;
  private groupLabel = "";
  private listeners = new Set<StackListener>();

  constructor(readonly doc: SceneDocument, readonly limit = HISTORY_LIMIT) {
    this.reset();
  }

  /** Listen for changes. Returns an unsubscribe function. */
  subscribe(listener: StackListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- editing --------------------------------------------------------------------------------

  /** Apply a command and record it as a step (or part of the open group). */
  execute(command: Command): void {
    this.stepBefore ??= this.doc.toJSON();
    const changes = command.apply(this.doc);
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

  /** Record the step since `stepBefore` as a new child of the current state. */
  private commit(label: string): boolean {
    const before = this.stepBefore;
    this.stepBefore = null;
    if (!before) return false;
    const after = this.doc.toJSON();
    const d = diffFiles(before, after);
    if (!d) return false;
    const state: HistoryState = { seq: this.nextSeq++, parent: this.currentSeq, label, time: Date.now(), hash: hashFile(after), redo: d.redo, undo: d.undo };
    this.states.set(state.seq, state);
    this.state(this.currentSeq).redoChild = state.seq;
    this.currentSeq = state.seq;
    this.prune();
    return true;
  }

  // --- navigation -----------------------------------------------------------------------------

  private get inGroup(): boolean {
    return this.groupDepth > 0;
  }

  get canUndo(): boolean {
    return this.currentSeq !== this.rootSeq && !this.inGroup;
  }

  get canRedo(): boolean {
    return this.redoTarget() !== null && !this.inGroup;
  }

  /** Label of the step `undo()` would revert, or null. */
  get undoLabel(): string | null {
    return this.canUndo ? this.state(this.currentSeq).label : null;
  }

  get redoLabel(): string | null {
    const t = this.redoTarget();
    return t === null ? null : this.state(t).label;
  }

  /** Go back to the parent state. Returns false if there's nothing to undo (or a group is open). */
  undo(): boolean {
    if (!this.canUndo) return false;
    const label = this.state(this.currentSeq).label;
    return this.navigate(this.state(this.currentSeq).parent, "undo", label);
  }

  /** Go to the child last visited (the newest branch unless you navigated elsewhere). */
  redo(): boolean {
    const t = this.redoTarget();
    if (t === null || this.inGroup) return false;
    return this.navigate(t, "redo", this.state(t).label);
  }

  /** Go to any state, undoing to the common ancestor and redoing down from there. */
  jumpTo(seq: number): boolean {
    if (!this.states.has(seq) || seq === this.currentSeq || this.inGroup) return false;
    return this.navigate(seq, "jump", this.state(seq).label);
  }

  /** The previous state in creation order (like Vim's g-), across branches. */
  back(): boolean {
    const seqs = this.sortedSeqs().filter((s) => s < this.currentSeq);
    return seqs.length > 0 && this.jumpTo(seqs[seqs.length - 1]);
  }

  /** The next state in creation order (like Vim's g+). */
  forward(): boolean {
    const next = this.sortedSeqs().find((s) => s > this.currentSeq);
    return next !== undefined && this.jumpTo(next);
  }

  private redoTarget(): number | null {
    const cur = this.state(this.currentSeq);
    if (cur.redoChild !== undefined && this.states.get(cur.redoChild)?.parent === cur.seq) return cur.redoChild;
    const children = this.childrenOf(cur.seq);
    return children.length ? children[children.length - 1] : null;
  }

  /** Move the document to state `target` and tell listeners what changed. */
  private navigate(target: number, reason: StackEvent["reason"], label: string): boolean {
    const before = this.doc.toJSON();
    let file = before;
    const up = this.pathToRoot(this.currentSeq);
    const down = this.pathToRoot(target);
    const common = up.find((s) => down.includes(s))!;
    for (const s of up) {
      if (s === common) break;
      file = applyPatch(file, this.state(s).undo!);
      this.state(this.state(s).parent).redoChild = s; // redo comes back this way
    }
    for (const s of down.slice(0, down.indexOf(common)).reverse()) {
      file = applyPatch(file, this.state(s).redo!);
      this.state(this.state(s).parent).redoChild = s;
    }
    this.doc._replace(file);
    this.currentSeq = target;
    this.emit({ reason, label, changes: changesBetween(before, file) });
    return true;
  }

  // --- saving and state -------------------------------------------------------------------------

  /** True if the document differs from the last save point. */
  get dirty(): boolean {
    return this.currentSeq !== this.savedSeq;
  }

  /** Record the current state as saved (call after writing the file). */
  markSaved(): void {
    this.savedSeq = this.currentSeq;
    this.emit({ reason: "save", label: "Save", changes: [] });
  }

  /** Forget all history: the current document becomes the root, counted as saved. */
  clear(): void {
    this.reset();
  }

  /** Every state, oldest first (for the History panel). */
  get allStates(): readonly HistoryState[] {
    return this.sortedSeqs().map((s) => this.state(s));
  }

  get current(): number {
    return this.currentSeq;
  }

  get saved(): number {
    return this.savedSeq;
  }

  get root(): number {
    return this.rootSeq;
  }

  /** Ids of a state's children, oldest first. */
  childrenOf(seq: number): number[] {
    return this.sortedSeqs().filter((s) => this.states.get(s)!.parent === seq);
  }

  // --- persistence ------------------------------------------------------------------------------

  /** The tree as a history file for `scene`. */
  toFile(scene: string): HistoryFile {
    return {
      format: "myco.history@1",
      scene,
      root: this.rootSeq,
      current: this.currentSeq,
      saved: this.savedSeq,
      nextSeq: this.nextSeq,
      states: structuredClone(this.allStates as HistoryState[]),
    };
  }

  /**
   * Adopt a saved history whose states include the document as it is now (the file on disk).
   * Returns the state the history was at when written (to offer restoring it), or null if no
   * state matches the document, in which case nothing changes.
   */
  load(file: HistoryFile): { matched: number; lastCurrent: number } | null {
    if ((file.format as string) !== "myco.history@1" && (file.format as string) !== "tranquility.history@1") return null; // the former name's (ADR 0037) too
    if (!Array.isArray(file.states)) return null;
    const hash = hashFile(this.doc.toJSON());
    const byHash = file.states.filter((s) => s.hash === hash);
    if (byHash.length === 0) return null;
    // The saved state if it matches the file, else the newest state with the same content.
    const matched = byHash.find((s) => s.seq === file.saved)?.seq ?? byHash[byHash.length - 1].seq;
    this.states = new Map(file.states.map((s) => [s.seq, structuredClone(s)]));
    this.rootSeq = file.root;
    this.nextSeq = file.nextSeq;
    this.currentSeq = matched;
    this.savedSeq = matched; // the document came from the file on disk
    this.stepBefore = null;
    this.groupDepth = 0;
    this.emit({ reason: "load", label: "Load history", changes: [] });
    return { matched, lastCurrent: this.states.has(file.current) ? file.current : matched };
  }

  // --- internals ---------------------------------------------------------------------------------

  private reset(): void {
    this.states = new Map([[0, { seq: 0, parent: -1, label: "Opened", time: Date.now(), hash: hashFile(this.doc.toJSON()) }]]);
    this.rootSeq = 0;
    this.currentSeq = 0;
    this.savedSeq = 0;
    this.nextSeq = 1;
    this.stepBefore = null;
    this.groupDepth = 0;
  }

  private state(seq: number): HistoryState {
    const s = this.states.get(seq);
    if (!s) throw new Error(`No history state ${seq}.`);
    return s;
  }

  private sortedSeqs(): number[] {
    return [...this.states.keys()].sort((a, b) => a - b);
  }

  /** `seq` and its ancestors up to the root, `seq` first. */
  private pathToRoot(seq: number): number[] {
    const out: number[] = [];
    for (let s = seq; s !== -1; s = this.state(s).parent) out.push(s);
    return out;
  }

  /**
   * Keep at most `limit` states: drop the oldest leaves off the path to the current state; if
   * that's not enough, advance the root along that path.
   */
  private prune(): void {
    while (this.states.size > this.limit) {
      const keep = new Set(this.pathToRoot(this.currentSeq));
      const leaf = this.sortedSeqs().find((s) => !keep.has(s) && this.childrenOf(s).length === 0);
      if (leaf !== undefined) {
        this.states.delete(leaf);
      } else {
        const next = this.pathToRoot(this.currentSeq).at(-2)!; // the root's child on the path
        this.states.delete(this.rootSeq);
        const s = this.state(next);
        s.parent = -1;
        delete s.redo;
        delete s.undo;
        this.rootSeq = next;
      }
      if (!this.states.has(this.savedSeq)) this.savedSeq = -1;
    }
  }

  private emit(event: StackEvent): void {
    for (const l of [...this.listeners]) l(event);
  }
}

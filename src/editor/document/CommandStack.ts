import type { Change, Command, FileWrite } from "./commands";
import { applyPatch, changesBetween, diffFiles, hashFile, type DocPatch } from "./patch";
import type { SceneDocument, SceneFile } from "./SceneDocument";

/** What happened, passed to `CommandStack` listeners. */
export interface StackEvent {
  readonly reason: "execute" | "group" | "undo" | "redo" | "jump" | "save" | "load";
  readonly label: string;
  readonly changes: readonly Change[];
}

export type StackListener = (event: StackEvent) => void;

/**
 * A text file's change in one step (ADR 0077: UI documents' markup and stylesheets): the text at
 * `start` that was `before` became `after` (the differing middle, so history files stay small).
 * `created`: the file didn't exist before (undo deletes it); `removed`: the step deleted it.
 */
export interface FilePatch {
  path: string;
  start: number;
  before: string;
  after: string;
  created?: true;
  removed?: true;
}

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

/** The change from `a` to `b` as one replaced stretch: common prefix and suffix left out. */
export function diffText(a: string, b: string): { start: number; before: string; after: string } {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let q = 0;
  while (q < max - p && a.charCodeAt(a.length - 1 - q) === b.charCodeAt(b.length - 1 - q)) q++;
  return { start: p, before: a.slice(p, a.length - q), after: b.slice(p, b.length - q) };
}

const emptyPatch = (p: DocPatch | undefined) => !p || (!p.nodes && !p.order && !p.top);

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
  /** Text files the step changed besides the scene (ADR 0077), in the order to redo them. */
  files?: FilePatch[];
}

/** The history tree as written to a history file (ADR 0027). */
export interface HistoryFile {
  format: "myco.history@1";
  /** Project-relative path of the scene this history belongs to (an asset document's file for a `TextHistory`, ADR 0133). */
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
 *
 * Commands may also write text files (`Command.files`, ADR 0077's UI documents): the stack writes
 * them through `files` and keeps each file's change in the step, so undo and redo write them back
 * in order with scene edits. A step that only changed files doesn't make the scene dirty.
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
  /** Each file's text before the step being recorded, for the files its commands write. */
  private filesBefore: Map<string, string | null> | null = null;
  /** Where commands' text files are read and written; null refuses commands that write files. */
  files: TextFileHost | null = null;

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

  /** Run `body` as one step labelled `label` (between `beginGroup` and `endGroup`, closed even if it throws). */
  group<T>(label: string, body: () => T): T {
    this.beginGroup(label);
    try {
      return body();
    } finally {
      this.endGroup();
    }
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
      } else if (current === null || current.slice(f.start, f.start + from.length) !== from) {
        host.conflict?.(f.path, state.label);
      } else {
        host.write(f.path, current.slice(0, f.start) + to + current.slice(f.start + from.length));
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
    const state: HistoryState = { seq: this.nextSeq++, parent: this.currentSeq, label, time: Date.now(), hash: hashFile(after), redo: d?.redo ?? {}, undo: d?.undo ?? {} };
    if (files.length) state.files = files;
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
      this.replayFiles(this.state(s), "undo");
      this.state(this.state(s).parent).redoChild = s; // redo comes back this way
    }
    for (const s of down.slice(0, down.indexOf(common)).reverse()) {
      file = applyPatch(file, this.state(s).redo!);
      this.replayFiles(this.state(s), "redo");
      this.state(this.state(s).parent).redoChild = s;
    }
    this.doc._replace(file);
    this.currentSeq = target;
    this.emit({ reason, label, changes: changesBetween(before, file) });
    return true;
  }

  // --- saving and state -------------------------------------------------------------------------

  /**
   * True if the document differs from the last save point: a step between them changed the scene
   * (steps that only wrote text files, which are saved as they're made, don't count).
   */
  get dirty(): boolean {
    if (this.currentSeq === this.savedSeq) return false;
    if (!this.states.has(this.savedSeq)) return true;
    const up = this.pathToRoot(this.currentSeq), down = this.pathToRoot(this.savedSeq);
    const common = up.find((s) => down.includes(s))!;
    const changesScene = (path: number[]) => path.slice(0, path.indexOf(common)).some((s) => !emptyPatch(this.state(s).redo));
    return changesScene(up) || changesScene(down);
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
    this.filesBefore = null;
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
    this.filesBefore = null;
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
        delete s.files;
        this.rootSeq = next;
      }
      if (!this.states.has(this.savedSeq)) this.savedSeq = -1;
    }
  }

  private emit(event: StackEvent): void {
    for (const l of [...this.listeners]) l(event);
  }
}

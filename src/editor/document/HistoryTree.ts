// The persistent, tree-shaped edit history (ADR 0027), apart from what is being edited (ADR 0267).
// This module owns the states, the root, the current and saved state and the numbering; which
// child redo goes to; the path between two states through their common ancestor; stepping in
// creation order; pruning by count (0027) and by age (0116); the `myco.history@1` file, including
// the former name's; and adopting a loaded file by the hash of the value being edited, with the
// guards a damaged file needs. It never touches the edited value itself: moving along a path hands
// each state to a `StepAdapter`, which applies that state's change forward or back and may refuse.
// The scene's `CommandStack` (document diff plus text-file replay) and an asset document's
// `TextHistory` (one text patch per state, ADR 0141) are the two adapters.
import type { DocPatch } from "./patch";
import type { FilePatch } from "./textPatch";

/** One state of the history tree (ADR 0027). */
export interface HistoryState {
  /** Creation order; state 0 is the document as history began. */
  readonly seq: number;
  /** The state this one was made from; -1 for the root. */
  parent: number;
  readonly label: string;
  /** When it was made (ms since the epoch). */
  readonly time: number;
  /** The hash of the edited value in this state (`hashFile` of a scene, `hashText` of a text). */
  readonly hash: string;
  /** A scene's step: from the parent to this state, and back. Absent on the root. */
  redo?: DocPatch;
  undo?: DocPatch;
  /** The child redo goes to: the one last visited. */
  redoChild?: number;
  /**
   * Text files the step changed (ADR 0077), in the order to redo them: besides the scene in a scene's
   * history; the one patch of the file in a text history. Absent on the root.
   */
  files?: FilePatch[];
}

/** The history tree as written to a history file (ADR 0027). */
export interface HistoryFile {
  format: "myco.history@1";
  /** Project-relative path of the scene this history belongs to (an asset document's file for a `TextHistory`, ADR 0141). */
  scene: string;
  root: number;
  current: number;
  /** The state matching the file as last saved (-1 if that state was pruned). */
  saved: number;
  nextSeq: number;
  states: HistoryState[];
}

const FORMAT = "myco.history@1";
/** The format's name before the rename (ADR 0037), still read. */
const LEGACY_FORMAT = "tranquility.history@1";

/** Most states kept (like Vim's 'undolevels'). */
export const HISTORY_LIMIT = 1000;

const DAY_MS = 86_400_000;

/** "Prune history older than N days" as a setting: a whole number of days at least 0 (anything else: 0, which keeps everything). */
export function cleanPruneDays(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(36500, Math.floor(n)) : 0;
}

/**
 * Moves the edited value across one state's change: forward (`redo`, from the parent's value to the
 * state's) or back (`undo`). Returns the new value, or null to refuse (the change doesn't fit the
 * value: a damaged history), in which case the whole move is abandoned and nothing changes. A step
 * shouldn't have side effects until the move it is part of has succeeded.
 */
export interface StepAdapter<V> {
  step(value: V, state: HistoryState, direction: "undo" | "redo"): V | null;
}

/** Where a move goes: undo to the parent, redo to the child last visited, back or forward in creation order, or a state's seq. */
export type HistoryMove = "undo" | "redo" | "back" | "forward" | number;

/** Pruning by age (ADR 0116) when writing or reading a history file. */
export interface AgeOptions {
  /** Drop states older than this many days that nothing kept needs (0 or absent: keep everything). */
  pruneDays?: number;
  /** The time to measure age from (ms since the epoch); now by default. */
  now?: number;
}

export interface LoadOptions extends AgeOptions {
  /** Refuse the file unless every state passes (a text history refuses a scene's, whose steps aren't one text patch). */
  accepts?: (state: HistoryState) => boolean;
}

/**
 * Drop the states of `states` older than the cutoff, except what is still needed: a state is kept if
 * it is recent, on the path to one of `keepFrom` (the current, saved and root states), or an
 * ancestor of anything kept (a step is stored against its parent, so the tree must stay
 * connected). What goes is old branches nobody has touched. `states` must be a connected tree.
 */
function pruneByAge(states: Map<number, HistoryState>, keepFrom: readonly number[], { pruneDays, now = Date.now() }: AgeOptions): void {
  const days = cleanPruneDays(pruneDays);
  if (days === 0) return;
  const cutoff = now - days * DAY_MS;
  const keep = new Set<number>();
  const keepPath = (seq: number) => {
    for (let s = states.get(seq); s && !keep.has(s.seq); s = states.get(s.parent)) keep.add(s.seq);
  };
  for (const seq of keepFrom) keepPath(seq);
  for (const s of states.values()) if (!(s.time < cutoff)) keepPath(s.seq);
  if (keep.size === states.size) return;
  for (const seq of [...states.keys()]) if (!keep.has(seq)) states.delete(seq);
  for (const s of states.values()) if (s.redoChild !== undefined && !states.has(s.redoChild)) delete s.redoChild;
}

/**
 * A history file's states, copied, or null when the file isn't a history or is damaged: an unknown
 * format, a malformed state, a repeated seq, a missing root, or a state that doesn't lead to the
 * root (a missing parent, a second root, a cycle).
 */
function readStates(file: HistoryFile, accepts?: (s: HistoryState) => boolean): Map<number, HistoryState> | null {
  const format = (file as { format?: unknown } | null)?.format;
  if ((format !== FORMAT && format !== LEGACY_FORMAT) || !Array.isArray(file.states)) return null;
  const states = new Map<number, HistoryState>();
  for (const s of file.states as unknown[]) {
    const st = s as HistoryState | null;
    if (!st || typeof st !== "object" || !Number.isInteger(st.seq) || typeof st.parent !== "number" || typeof st.hash !== "string") return null;
    if (states.has(st.seq) || (accepts && !accepts(st))) return null;
    states.set(st.seq, structuredClone(st));
  }
  if (states.get(file.root)?.parent !== -1) return null;
  const connected = new Set([file.root]);
  for (const s of states.values()) {
    const chain: number[] = [];
    let at: HistoryState | undefined = s;
    while (at && !connected.has(at.seq) && chain.length <= states.size) {
      chain.push(at.seq);
      at = states.get(at.parent);
    }
    if (!at || !connected.has(at.seq)) return null;
    for (const seq of chain) connected.add(seq);
  }
  return states;
}

/** The history tree of one edited value (ADR 0027, 0267). */
export class HistoryTree {
  private states = new Map<number, HistoryState>();
  private rootSeq = 0;
  private currentSeq = 0;
  private savedSeq = 0;
  private nextSeq = 1;

  /** `hash`: the hash of the value as history begins. */
  constructor(hash: string, readonly limit = HISTORY_LIMIT) {
    this.reset(hash);
  }

  /** Forget every state: a new root with `hash` becomes the current state, counted as saved. */
  reset(hash: string): void {
    this.states = new Map([[0, { seq: 0, parent: -1, label: "Opened", time: Date.now(), hash }]]);
    this.rootSeq = 0;
    this.currentSeq = 0;
    this.savedSeq = 0;
    this.nextSeq = 1;
  }

  get root(): number {
    return this.rootSeq;
  }

  get current(): number {
    return this.currentSeq;
  }

  /** The state matching the file as last saved (-1 if it was pruned). */
  get saved(): number {
    return this.savedSeq;
  }

  /** How many states there are (1: only the root, nothing recorded yet). */
  get size(): number {
    return this.states.size;
  }

  has(seq: number): boolean {
    return this.states.has(seq);
  }

  /** A state (throws if there's none). Its step payload may be rewritten in place by the adapter that owns it. */
  state(seq: number): HistoryState {
    const s = this.states.get(seq);
    if (!s) throw new Error(`No history state ${seq}.`);
    return s;
  }

  /** Every state, oldest first (for the History panel). */
  get allStates(): readonly HistoryState[] {
    return this.sortedSeqs().map((s) => this.state(s));
  }

  /** Ids of a state's children, oldest first. */
  childrenOf(seq: number): number[] {
    return this.sortedSeqs().filter((s) => this.states.get(s)!.parent === seq);
  }

  /** The state `move` would go to from the current one, or null when there's none. */
  targetOf(move: HistoryMove): number | null {
    const cur = this.state(this.currentSeq);
    switch (move) {
      case "undo":
        return cur.seq === this.rootSeq ? null : cur.parent;
      case "redo": {
        if (cur.redoChild !== undefined && this.states.get(cur.redoChild)?.parent === cur.seq) return cur.redoChild;
        const children = this.childrenOf(cur.seq);
        return children.length ? children[children.length - 1] : null;
      }
      case "back":
        return this.sortedSeqs().filter((s) => s < cur.seq).at(-1) ?? null;
      case "forward":
        return this.sortedSeqs().find((s) => s > cur.seq) ?? null;
      default:
        return this.states.has(move) && move !== cur.seq ? move : null;
    }
  }

  /** The label of the step `move` would make: the current state's for undo (the step it reverts), else the target's; null when there's no move. */
  labelOf(move: HistoryMove): string | null {
    const target = this.targetOf(move);
    if (target === null) return null;
    return this.state(move === "undo" ? this.currentSeq : target).label;
  }

  /**
   * Record a step as a new child of the current state, which it becomes (and redo from the parent
   * goes to it). Then prune to `limit` states. Returns the new state.
   */
  add(step: { label: string; hash: string; redo?: DocPatch; undo?: DocPatch; files?: FilePatch[] }): HistoryState {
    const state: HistoryState = { seq: this.nextSeq++, parent: this.currentSeq, label: step.label, time: Date.now(), hash: step.hash };
    if (step.redo) state.redo = step.redo;
    if (step.undo) state.undo = step.undo;
    if (step.files?.length) state.files = step.files;
    this.states.set(state.seq, state);
    this.state(this.currentSeq).redoChild = state.seq;
    this.currentSeq = state.seq;
    this.prune();
    return state;
  }

  /** Record `seq` (the current state by default) as matching the file as saved; -1 if there's no such state. */
  markSaved(seq = this.currentSeq): void {
    this.savedSeq = this.states.has(seq) ? seq : -1;
  }

  /**
   * The way from `from` to `to` through their common ancestor: `up`, the states undone (from `from`
   * upwards, the ancestor not included), and `down`, the states redone (from below the ancestor to `to`).
   */
  path(from: number, to: number): { up: number[]; down: number[] } {
    const up = this.pathToRoot(from);
    const down = this.pathToRoot(to);
    const common = up.find((s) => down.includes(s))!;
    return { up: up.slice(0, up.indexOf(common)), down: down.slice(0, down.indexOf(common)).reverse() };
  }

  /**
   * Make `move` with `value` (the edited value in the current state): each state on the path is
   * handed to `adapter`, undone up to the common ancestor and redone down to the target. Returns the
   * value in the target state, the target and the step's label (as `labelOf`); or null, changing
   * nothing, when there's no such move or the adapter refused a step.
   */
  go<V>(move: HistoryMove, value: V, adapter: StepAdapter<V>): { value: V; seq: number; label: string } | null {
    const target = this.targetOf(move);
    if (target === null) return null;
    const label = this.labelOf(move)!;
    const { up, down } = this.path(this.currentSeq, target);
    let v = value;
    for (const [list, direction] of [[up, "undo"], [down, "redo"]] as const) {
      for (const s of list) {
        const next = adapter.step(v, this.state(s), direction);
        if (next === null) return null;
        v = next;
      }
    }
    for (const s of [...up, ...down]) this.state(this.state(s).parent).redoChild = s; // redo comes back this way
    this.currentSeq = target;
    return { value: v, seq: target, label };
  }

  // --- the history file ---------------------------------------------------------------------------

  /** The tree as a history file for `scene` (a copy), without the states `pruneDays` drops (ADR 0116; the tree keeps them). */
  toFile(scene: string, options: AgeOptions = {}): HistoryFile {
    const states = new Map(this.allStates.map((s) => [s.seq, structuredClone(s)]));
    pruneByAge(states, [this.currentSeq, this.savedSeq, this.rootSeq], options);
    return {
      format: FORMAT,
      scene,
      root: this.rootSeq,
      current: this.currentSeq,
      saved: this.savedSeq,
      nextSeq: this.nextSeq,
      states: [...states.values()],
    };
  }

  /**
   * Adopt a saved history that has a state whose hash is `hash` (the value as it is now: the file on
   * disk): the file's saved state if it matches, else the newest matching state. That state becomes
   * current and saved. Returns it and the state the history was at when written (to offer restoring
   * it), or null, changing nothing, if no state matches or the file is damaged (see `readStates`).
   * Numbering continues after the highest seq, whatever the file's `nextSeq` says.
   */
  load(file: HistoryFile, hash: string, options: LoadOptions = {}): { matched: number; lastCurrent: number } | null {
    const states = readStates(file, options.accepts);
    if (!states) return null;
    pruneByAge(states, [file.current, file.saved, file.root], options);
    const byHash = [...states.values()].filter((s) => s.hash === hash).sort((a, b) => a.seq - b.seq);
    if (byHash.length === 0) return null;
    const matched = byHash.find((s) => s.seq === file.saved)?.seq ?? byHash[byHash.length - 1].seq;
    this.states = states;
    this.rootSeq = file.root;
    this.nextSeq = Math.max(Number.isInteger(file.nextSeq) ? file.nextSeq : 0, ...[...states.keys()].map((s) => s + 1));
    this.currentSeq = matched;
    this.savedSeq = matched; // the value came from the file on disk
    return { matched, lastCurrent: states.has(file.current) ? file.current : matched };
  }

  // --- internals ---------------------------------------------------------------------------------

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
   * Keep at most `limit` states: drop the oldest leaves off the path to the current state; if that's
   * not enough, advance the root along that path (the new root's step goes: it has no parent).
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
}

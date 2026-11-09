// A persistent, tree-shaped edit history over one text value (ADR 0027 for asset documents, ADR
// 0133): the scene's history tree, with each step stored as a text patch of the file (the
// `FilePatch` the scene's history keeps for UI documents, ADR 0077) instead of a node diff. The
// asset document (assetDocuments.ts) turns values into text with its format and back.
import { HISTORY_LIMIT, diffText, type FilePatch, type HistoryFile, type HistoryState } from "./CommandStack";
import { hashText } from "./patch";

/** `text` with `patch` applied forward (redo) or back (undo); null if it doesn't fit. */
function applyText(text: string, patch: FilePatch, direction: "undo" | "redo"): string | null {
  const [from, to] = direction === "undo" ? [patch.after, patch.before] : [patch.before, patch.after];
  if (text.slice(patch.start, patch.start + from.length) !== from) return null;
  return text.slice(0, patch.start) + to + text.slice(patch.start + from.length);
}

/**
 * The history tree of one text value. State 0 is the text as history began; every other state
 * holds, in `files[0]`, the patch from its parent's text to its own. Navigation is the scene's
 * (`CommandStack`): undo to the parent, redo to the child last visited, jump anywhere, step by
 * creation order; editing after undoing starts a new branch. At most `limit` states, pruned the
 * same way.
 */
export class TextHistory {
  private states = new Map<number, HistoryState>();
  private rootSeq = 0;
  private currentSeq = 0;
  private savedSeq = 0;
  private nextSeq = 1;
  private currentText: string;

  /** `path`: the file's path, written into patches and history files (follows renames). */
  constructor(
    text: string,
    public path: string,
    readonly limit = HISTORY_LIMIT,
  ) {
    this.currentText = text;
    this.states.set(0, { seq: 0, parent: -1, label: "Opened", time: Date.now(), hash: hashText(text) });
  }

  /** The text of the current state. */
  get text(): string {
    return this.currentText;
  }

  get current(): number {
    return this.currentSeq;
  }

  /** The state matching the file as last written (-1 if pruned). */
  get saved(): number {
    return this.savedSeq;
  }

  get root(): number {
    return this.rootSeq;
  }

  get canUndo(): boolean {
    return this.currentSeq !== this.rootSeq;
  }

  get canRedo(): boolean {
    return this.redoTarget() !== null;
  }

  /** Label of the step `undo()` would revert, or null. */
  get undoLabel(): string | null {
    return this.canUndo ? this.state(this.currentSeq).label : null;
  }

  /** Label of the step `redo()` would make, or null. */
  get redoLabel(): string | null {
    const t = this.redoTarget();
    return t === null ? null : this.state(t).label;
  }

  /** Every state, oldest first (for the History panel). */
  get allStates(): readonly HistoryState[] {
    return this.sortedSeqs().map((s) => this.state(s));
  }

  /** Ids of a state's children, oldest first. */
  childrenOf(seq: number): number[] {
    return this.sortedSeqs().filter((s) => this.states.get(s)!.parent === seq);
  }

  /** Whether only the root state exists (nothing recorded yet). */
  get empty(): boolean {
    return this.states.size === 1;
  }

  // --- editing --------------------------------------------------------------------------------

  /** Record `text` as a new child of the current state. False (nothing recorded) when it's the current text. */
  record(label: string, text: string): boolean {
    if (text === this.currentText) return false;
    const state: HistoryState = { seq: this.nextSeq++, parent: this.currentSeq, label, time: Date.now(), hash: hashText(text), files: [{ path: this.path, ...diffText(this.currentText, text) }] };
    this.states.set(state.seq, state);
    this.state(this.currentSeq).redoChild = state.seq;
    this.currentSeq = state.seq;
    this.currentText = text;
    this.prune();
    return true;
  }

  /**
   * Make `text` the current state's text without a new step (a view change, or the file changed
   * elsewhere): the patches into and out of the current state are rewritten, so the tree still
   * matches the file and its other states keep their text.
   */
  amend(text: string): void {
    const old = this.currentText;
    if (text === old) return;
    const cur = this.state(this.currentSeq);
    if (cur.parent !== -1 && cur.files?.[0]) {
      const parentText = applyText(old, cur.files[0], "undo");
      if (parentText !== null) cur.files = [{ path: this.path, ...diffText(parentText, text) }];
    }
    for (const c of this.childrenOf(cur.seq)) {
      const child = this.state(c);
      const childText = child.files?.[0] ? applyText(old, child.files[0], "redo") : null;
      if (childText !== null) child.files = [{ path: this.path, ...diffText(text, childText) }];
    }
    (cur as { hash: string }).hash = hashText(text);
    this.currentText = text;
  }

  /** Record the current state as matching the file (after writing it), or `seq`'s if given. */
  markSaved(seq = this.currentSeq): void {
    this.savedSeq = this.states.has(seq) ? seq : -1;
  }

  // --- navigation -----------------------------------------------------------------------------

  /** Go to the parent state. */
  undo(): boolean {
    return this.canUndo && this.navigate(this.state(this.currentSeq).parent);
  }

  /** Go to the child last visited (the newest branch unless you navigated elsewhere). */
  redo(): boolean {
    const t = this.redoTarget();
    return t !== null && this.navigate(t);
  }

  /** Go to any state, undoing to the common ancestor and redoing down from there. */
  jumpTo(seq: number): boolean {
    return this.states.has(seq) && seq !== this.currentSeq && this.navigate(seq);
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

  /** Move to `target`. False, changing nothing, if a patch doesn't fit (a damaged history). */
  private navigate(target: number): boolean {
    const up = this.pathToRoot(this.currentSeq);
    const down = this.pathToRoot(target);
    const common = up.find((s) => down.includes(s))!;
    let text: string | null = this.currentText;
    const visited: number[] = [];
    for (const s of up) {
      if (s === common) break;
      const patch = this.state(s).files?.[0];
      text = patch ? applyText(text, patch, "undo") : null;
      if (text === null) return false;
      visited.push(s);
    }
    const downward = down.slice(0, down.indexOf(common)).reverse();
    for (const s of downward) {
      const patch = this.state(s).files?.[0];
      text = patch ? applyText(text, patch, "redo") : null;
      if (text === null) return false;
      visited.push(s);
    }
    for (const s of visited) this.state(this.state(s).parent).redoChild = s; // redo comes back this way
    this.currentSeq = target;
    this.currentText = text;
    return true;
  }

  // --- persistence ------------------------------------------------------------------------------

  /** The tree as a history file (the `scene` field holds the asset's path). */
  toFile(): HistoryFile {
    const states = structuredClone(this.allStates as HistoryState[]);
    for (const s of states) if (s.files) for (const f of s.files) f.path = this.path;
    return { format: "myco.history@1", scene: this.path, root: this.rootSeq, current: this.currentSeq, saved: this.savedSeq, nextSeq: this.nextSeq, states };
  }

  /**
   * Adopt a saved history that has a state whose text is the current text (the file on disk):
   * the saved state if it matches, else the newest matching state. Returns that state and the one
   * the history was at when written, or null (nothing changes) if no state matches or the file
   * isn't a text history.
   */
  load(file: HistoryFile): { matched: number; lastCurrent: number } | null {
    if ((file?.format as string) !== "myco.history@1" || !Array.isArray(file.states)) return null;
    if (!file.states.every((s) => s.parent === -1 || s.files?.length === 1)) return null; // a scene's history
    const hash = hashText(this.currentText);
    const byHash = file.states.filter((s) => s.hash === hash);
    if (byHash.length === 0 || !file.states.some((s) => s.seq === file.root)) return null;
    const matched = byHash.find((s) => s.seq === file.saved)?.seq ?? byHash[byHash.length - 1].seq;
    this.states = new Map(file.states.map((s) => [s.seq, structuredClone(s)]));
    this.rootSeq = file.root;
    this.nextSeq = Math.max(file.nextSeq, ...file.states.map((s) => s.seq + 1));
    this.currentSeq = matched;
    this.savedSeq = matched; // the text came from the file on disk
    return { matched, lastCurrent: this.states.has(file.current) ? file.current : matched };
  }

  // --- internals ---------------------------------------------------------------------------------

  private state(seq: number): HistoryState {
    const s = this.states.get(seq);
    if (!s) throw new Error(`No history state ${seq}.`);
    return s;
  }

  private sortedSeqs(): number[] {
    return [...this.states.keys()].sort((a, b) => a - b);
  }

  private pathToRoot(seq: number): number[] {
    const out: number[] = [];
    for (let s = seq; s !== -1; s = this.state(s).parent) out.push(s);
    return out;
  }

  /** As `CommandStack`: drop the oldest leaves off the current path, then advance the root along it. */
  private prune(): void {
    while (this.states.size > this.limit) {
      const keep = new Set(this.pathToRoot(this.currentSeq));
      const leaf = this.sortedSeqs().find((s) => !keep.has(s) && this.childrenOf(s).length === 0);
      if (leaf !== undefined) {
        this.states.delete(leaf);
      } else {
        const next = this.pathToRoot(this.currentSeq).at(-2)!;
        this.states.delete(this.rootSeq);
        const s = this.state(next);
        s.parent = -1;
        delete s.files;
        this.rootSeq = next;
      }
      if (!this.states.has(this.savedSeq)) this.savedSeq = -1;
    }
  }
}

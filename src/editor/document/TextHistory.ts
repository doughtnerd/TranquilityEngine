// A persistent, tree-shaped edit history over one text value (ADR 0027 for asset documents, ADR
// 0141): the `HistoryTree` (ADR 0267) with each step stored as a text patch of the file (the
// `FilePatch` the scene's history keeps for UI edits, ADR 0077, 0419) instead of a node diff. The
// asset document (assetDocuments.ts) turns values into text with its format and back.
import { HISTORY_LIMIT, HistoryTree, type AgeOptions, type HistoryFile, type HistoryMove, type HistoryState, type StepAdapter } from "./HistoryTree";
import { hashText } from "./patch";
import { applyFilePatch, diffText } from "./textPatch";

/** The text-patch step adapter: a state's one patch, `files[0]`, forward or back; refused when it doesn't fit. */
const textSteps: StepAdapter<string> = {
  step: (text, state, direction) => (state.files?.[0] ? applyFilePatch(text, state.files[0], direction) : null),
};

/** A text history's states each hold exactly one patch (a scene's history holds node diffs). */
const isTextState = (s: HistoryState) => s.parent === -1 || s.files?.length === 1;

/**
 * The history tree of one text value. State 0 is the text as history began; every other state
 * holds, in `files[0]`, the patch from its parent's text to its own. Navigation, pruning and the
 * history file are the tree's: undo to the parent, redo to the child last visited, jump anywhere,
 * step by creation order; editing after undoing starts a new branch. At most `limit` states.
 */
export class TextHistory {
  private readonly tree: HistoryTree;
  private currentText: string;

  /** `path`: the file's path, written into patches and history files (follows renames). */
  constructor(
    text: string,
    public path: string,
    readonly limit = HISTORY_LIMIT,
  ) {
    this.currentText = text;
    this.tree = new HistoryTree(hashText(text), limit);
  }

  /** The text of the current state. */
  get text(): string {
    return this.currentText;
  }

  get current(): number {
    return this.tree.current;
  }

  /** The state matching the file as last written (-1 if pruned). */
  get saved(): number {
    return this.tree.saved;
  }

  get root(): number {
    return this.tree.root;
  }

  get canUndo(): boolean {
    return this.tree.targetOf("undo") !== null;
  }

  get canRedo(): boolean {
    return this.tree.targetOf("redo") !== null;
  }

  /** Label of the step `undo()` would revert, or null. */
  get undoLabel(): string | null {
    return this.tree.labelOf("undo");
  }

  /** Label of the step `redo()` would make, or null. */
  get redoLabel(): string | null {
    return this.tree.labelOf("redo");
  }

  /** Every state, oldest first (for the History panel). */
  get allStates(): readonly HistoryState[] {
    return this.tree.allStates;
  }

  /** Ids of a state's children, oldest first. */
  childrenOf(seq: number): number[] {
    return this.tree.childrenOf(seq);
  }

  /** Whether only the root state exists (nothing recorded yet). */
  get empty(): boolean {
    return this.tree.size === 1;
  }

  // --- editing --------------------------------------------------------------------------------

  /** Record `text` as a new child of the current state. False (nothing recorded) when it's the current text. */
  record(label: string, text: string): boolean {
    if (text === this.currentText) return false;
    this.tree.add({ label, hash: hashText(text), files: [{ path: this.path, ...diffText(this.currentText, text) }] });
    this.currentText = text;
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
    const cur = this.tree.state(this.tree.current);
    if (cur.parent !== -1) {
      const parentText = textSteps.step(old, cur, "undo");
      if (parentText !== null) cur.files = [{ path: this.path, ...diffText(parentText, text) }];
    }
    for (const c of this.tree.childrenOf(cur.seq)) {
      const child = this.tree.state(c);
      const childText = textSteps.step(old, child, "redo");
      if (childText !== null) child.files = [{ path: this.path, ...diffText(text, childText) }];
    }
    (cur as { hash: string }).hash = hashText(text);
    this.currentText = text;
  }

  /**
   * Change every state's text with `map` (a project-wide change to the file, such as a moved reference, ADR 0302),
   * keeping the tree's shape, labels and current state: each patch is rewritten between the mapped texts, so moving
   * through the history never brings back what `map` replaced. States whose text can't be rebuilt (a damaged
   * history) keep their patches. Returns whether the current text changed.
   */
  rewrite(map: (text: string) => string): boolean {
    const texts = new Map<number, string>([[this.tree.current, this.currentText]]);
    const queue = [this.tree.current];
    for (let seq = queue.pop(); seq !== undefined; seq = queue.pop()) {
      const state = this.tree.state(seq);
      const text = texts.get(seq)!;
      const near: [number, string | null][] = this.tree.childrenOf(seq).map((c) => [c, textSteps.step(text, this.tree.state(c), "redo")]);
      if (state.parent !== -1) near.push([state.parent, textSteps.step(text, state, "undo")]);
      for (const [next, nextText] of near) {
        if (nextText === null || texts.has(next)) continue;
        texts.set(next, nextText);
        queue.push(next);
      }
    }
    const mapped = new Map([...texts].map(([seq, text]) => [seq, map(text)]));
    for (const [seq, text] of mapped) {
      const state = this.tree.state(seq);
      (state as { hash: string }).hash = hashText(text);
      const parentText = state.parent === -1 ? undefined : mapped.get(state.parent);
      if (parentText !== undefined) state.files = [{ path: this.path, ...diffText(parentText, text) }];
    }
    const before = this.currentText;
    this.currentText = mapped.get(this.tree.current)!;
    return this.currentText !== before;
  }

  /** Record the current state as matching the file (after writing it), or `seq`'s if given. */
  markSaved(seq = this.tree.current): void {
    this.tree.markSaved(seq);
  }

  // --- navigation -----------------------------------------------------------------------------

  /** Go to the parent state. False, changing nothing, if a patch doesn't fit (a damaged history), as for every move. */
  undo(): boolean {
    return this.go("undo");
  }

  /** Go to the child last visited (the newest branch unless you navigated elsewhere). */
  redo(): boolean {
    return this.go("redo");
  }

  /** Go to any state, undoing to the common ancestor and redoing down from there. */
  jumpTo(seq: number): boolean {
    return this.go(seq);
  }

  /** The previous state in creation order (like Vim's g-), across branches. */
  back(): boolean {
    return this.go("back");
  }

  /** The next state in creation order (like Vim's g+). */
  forward(): boolean {
    return this.go("forward");
  }

  private go(move: HistoryMove): boolean {
    const moved = this.tree.go(move, this.currentText, textSteps);
    if (moved) this.currentText = moved.value;
    return moved !== null;
  }

  // --- persistence ------------------------------------------------------------------------------

  /** The tree as a history file (the `scene` field holds the asset's path), without the states `options.pruneDays` drops. */
  toFile(options?: AgeOptions): HistoryFile {
    const file = this.tree.toFile(this.path, options);
    for (const s of file.states) if (s.files) for (const f of s.files) f.path = this.path;
    return file;
  }

  /**
   * Adopt a saved history (pruned by age first) that has a state whose text is the current text
   * (the file on disk): the saved state if it matches, else the newest matching state. Returns that
   * state and the one the history was at when written, or null (nothing changes) if no state
   * matches, the file is damaged, or it isn't a text history.
   */
  load(file: HistoryFile, options?: AgeOptions): { matched: number; lastCurrent: number } | null {
    return this.tree.load(file, hashText(this.currentText), { ...options, accepts: isTextState });
  }
}

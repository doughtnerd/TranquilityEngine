// Asset documents (ADR 0133 "asset document"): one place that owns editing an asset file. A
// document holds the file's value made by its registered format, writes edits in order, keeps
// undo and redo, notices changes made elsewhere, and follows renames and deletes (assetOps.ts and
// assetDelete.ts call `assetDocumentsMoved` / `assetDocumentsDeleted`). Signals only, no components,
// so panels just read `value` and call `edit`.
//
// The undo history is 0027's persistent tree (`TextHistory`, each step a text patch of the file),
// saved with the scene's store and rules by assetHistory.ts: undoing then editing keeps the undone
// branch, and reopening the project brings the history back. It follows renames and is deleted
// with its file.
import { computed, effect, signal, untracked, type ReadonlySignal } from "@preact/signals";
import { AssetHistoryPersistence, _resetAssetHistory, deleteAssetHistories, moveAssetHistories } from "./assetHistory";
import { TextHistory, type HistoryState } from "./document";
import { errorStatus } from "./messages";
import { isWithin, type EditorProject } from "./projects";
import { assetFormats, type AssetFormatContribution, type AssetProblem } from "./sdk/contributions";
import { currentProject, docVersion, status } from "./state";

export interface EditOptions {
  /** Merge with the previous coalesced edit into one undo step, and write after the format's writeDelay (default 150 ms) of quiet. For sliders and drags. */
  coalesce?: boolean;
  /** False: a view change (a collapsed frame) that's written but makes no undo step and leaves the history as it is. */
  history?: false;
  /** The step's name in the History panel (default "Edit"). */
  label?: string;
}

/** An asset document's history tree, for the History panel (ADR 0027). */
export interface AssetHistoryView {
  /** Bumped on every change to the tree; read it to follow them. */
  readonly version: ReadonlySignal<number>;
  /** Every state, oldest first. */
  readonly states: readonly HistoryState[];
  readonly current: number;
  /** The state matching the file as last written (-1 if none does). */
  readonly saved: number;
  /** Go to a state (undoing to the common ancestor, then redoing down); written like an undo. */
  jumpTo(seq: number): void;
  /** The previous / next state in creation order (Vim's g- / g+, Ctrl/Cmd+Alt(+Shift)+Z); written like an undo. */
  back(): void;
  forward(): void;
}

export interface AssetDocument<T> {
  /** The file's current path; follows renames. */
  readonly path: string;
  /** The current value, including edits not yet written. */
  readonly value: ReadonlySignal<T>;
  readonly problems: ReadonlySignal<readonly AssetProblem[]>;
  /** The project can't be saved to. */
  readonly readOnly: boolean;
  readonly canUndo: ReadonlySignal<boolean>;
  readonly canRedo: ReadonlySignal<boolean>;
  /** The name of the step undo / redo would revert or make (null when there's none), for the Edit menu. */
  readonly undoLabel: ReadonlySignal<string | null>;
  readonly redoLabel: ReadonlySignal<string | null>;
  /**
   * Replace the value: one undo step (or merged, see coalesce); queued write. On a read-only
   * project: says so in the status bar and changes nothing.
   */
  edit(next: T, options?: EditOptions): void;
  undo(): void;
  redo(): void;
  /** Write any pending coalesced edit now; resolves when every queued write has settled. */
  flush(): Promise<void>;
  /** The history tree, for the History panel. */
  readonly history: AssetHistoryView;
}

const DEFAULT_WRITE_DELAY = 150;
const DEFAULT_LABEL = "Edit";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

class Document<T> implements AssetDocument<T> {
  readonly value;
  readonly problems;
  readonly canUndo: ReadonlySignal<boolean>;
  readonly canRedo: ReadonlySignal<boolean>;
  readonly undoLabel: ReadonlySignal<string | null>;
  readonly redoLabel: ReadonlySignal<string | null>;
  readonly history: AssetHistoryView;
  /** The history: one state per step, its text the file's text in that state. */
  private readonly tree: TextHistory;
  /** Values of states seen this session, so undo needn't parse the text back (others are parsed). */
  private values = new Map<number, T>();
  /** Saves the tree; null on a read-only project. */
  private readonly persistence: AssetHistoryPersistence | null;
  /** Bumped when the tree or the pending burst change, for canUndo/canRedo and the History panel. */
  private readonly historyVersion = signal(0);
  /** The value before a coalesced burst that hasn't been written yet, with its write timer and label. */
  private burst: { before: T; timer: ReturnType<typeof setTimeout>; label: string } | null = null;
  /** The text this document last wrote (or queued) or read: what the file should hold. */
  private lastText: string;
  private tail: Promise<void> = Promise.resolve();
  private inFlight = 0;
  /** The last write failed: the value holds edits the file doesn't, so outside changes don't replace it until a later write succeeds. */
  private writeFailed = false;
  /** Dropped: edits do nothing and outside changes aren't followed. */
  private closed = false;
  /** Dropped with its file deleted: queued writes are skipped. */
  private discarded = false;
  private readonly stopWatching: () => void;

  constructor(
    readonly project: EditorProject,
    path: string,
    private readonly format: AssetFormatContribution<T>,
  ) {
    const read = format.parse(project.assets.get(path), path);
    this.value = signal<T>(read.value);
    this.problems = signal<readonly AssetProblem[]>(read.problems);
    this.lastText = format.format(read.value);
    this.tree = new TextHistory(this.lastText, path);
    this.values.set(this.tree.current, read.value);
    this.canUndo = computed(() => (this.historyVersion.value, this.tree.canUndo || this.burst !== null));
    this.canRedo = computed(() => (this.historyVersion.value, this.burst === null && this.tree.canRedo));
    this.undoLabel = computed(() => (this.historyVersion.value, this.burst ? this.burst.label : this.tree.undoLabel));
    this.redoLabel = computed(() => (this.historyVersion.value, this.burst === null ? this.tree.redoLabel : null));
    const doc = this;
    this.history = {
      version: this.historyVersion,
      get states() {
        return doc.tree.allStates;
      },
      get current() {
        return doc.tree.current;
      },
      get saved() {
        return doc.tree.saved;
      },
      jumpTo: (seq) => this.go(() => this.tree.jumpTo(seq)),
      back: () => this.go(() => this.tree.back()),
      forward: () => this.go(() => this.tree.forward()),
    };
    this.persistence = project.canSave
      ? new AssetHistoryPersistence({
          project,
          tree: this.tree,
          loaded: (result) => this.historyLoaded(result),
          saveFailed: (err) => (status.value = errorStatus(`Couldn't save the edit history for ${this.path}`, err)),
        })
      : null;
    this.stopWatching = effect(() => {
      docVersion.value;
      untracked(() => this.reread());
    });
  }

  get path(): string {
    return this.tree.path;
  }

  /** Called when the file moved: the history is written at the new path from now on. */
  set path(next: string) {
    if (next === this.tree.path) return;
    this.tree.path = next;
    this.persistence?.relocate();
  }

  get readOnly(): boolean {
    return !this.project.canSave;
  }

  edit(next: T, options: EditOptions = {}): void {
    if (this.closed) return;
    if (this.readOnly) {
      const text = `${this.project.name} is read-only. Open a project folder (or copy the sample) to change ${fileName(this.path)}.`;
      if (status.peek()?.text !== text) status.value = { kind: "info", text };
      return;
    }
    const label = options.label ?? DEFAULT_LABEL;
    if (options.coalesce) {
      if (this.burst) clearTimeout(this.burst.timer);
      const before = this.burst ? this.burst.before : this.value.peek();
      this.burst = { before, label: this.burst?.label ?? label, timer: setTimeout(() => this.endBurst(), this.format.writeDelay ?? DEFAULT_WRITE_DELAY) };
      this.value.value = next;
      this.problems.value = [];
      this.historyVersion.value++;
      return;
    }
    this.endBurst();
    const text = this.format.format(next);
    if (text === this.format.format(this.value.peek())) return;
    if (options.history === false) this.amend(text, next);
    else this.record(label, text, next);
    this.replace(next);
  }

  undo(): void {
    this.go(() => this.tree.undo());
  }

  redo(): void {
    this.go(() => this.tree.redo());
  }

  /** Move through the tree (`step` returns whether it moved) and write the state reached. */
  private go(step: () => boolean): void {
    if (this.closed || this.readOnly) return;
    this.endBurst();
    if (!step()) return;
    this.historyChanged();
    this.replace(this.valueOf(this.tree.current));
  }

  /** A state's value: remembered from this session, or parsed from its text. */
  private valueOf(seq: number): T {
    const known = this.values.get(seq);
    if (known !== undefined) return known;
    let raw: unknown;
    try {
      raw = JSON.parse(this.tree.text);
    } catch {
      raw = undefined;
    }
    const value = this.format.parse(raw, this.path).value;
    this.values.set(seq, value);
    return value;
  }

  flush(): Promise<void> {
    this.endBurst();
    return this.tail;
  }

  /** Stop following the file and take no more edits. `write` writes a pending burst and queued writes (the project closed); otherwise they're discarded (the file was deleted). */
  drop(write: boolean): void {
    if (this.closed) return;
    if (write) this.endBurst();
    else {
      if (this.burst) clearTimeout(this.burst.timer);
      this.burst = null;
      this.discarded = true;
    }
    this.closed = true;
    this.persistence?.stop();
    this.stopWatching();
  }

  /** End a pending coalesced burst: one undo step, written now. */
  private endBurst(): void {
    const burst = this.burst;
    if (!burst) return;
    clearTimeout(burst.timer);
    this.burst = null;
    this.historyVersion.value++;
    const now = this.value.peek();
    const text = this.format.format(now);
    if (text === this.format.format(burst.before)) return;
    this.record(burst.label, text, now);
    this.write(now);
  }

  /** A new step to `text` (the value `value`), a child of the current state. */
  private record(label: string, text: string, value: T): void {
    if (!this.tree.record(label, text)) return;
    this.values.set(this.tree.current, value);
    const live = new Set(this.tree.allStates.map((s) => s.seq));
    if (this.values.size > live.size) for (const seq of this.values.keys()) if (!live.has(seq)) this.values.delete(seq);
    this.historyChanged();
  }

  /** The current state now holds `text` (a view change, or the file changed elsewhere); no new step. */
  private amend(text: string, value: T): void {
    this.tree.amend(text);
    this.values.set(this.tree.current, value);
    this.historyChanged();
  }

  private historyChanged(): void {
    this.historyVersion.value++;
    this.persistence?.save();
  }

  /** The saved history was looked for when the document opened. */
  private historyLoaded(result: { adopted: true; ahead: boolean } | { adopted: false }): void {
    if (this.closed) return;
    if (!result.adopted) {
      status.value = { kind: "info", text: `${this.path} changed outside the editor, so its saved edit history no longer applies; starting a new one.` };
      return;
    }
    this.values = new Map([[this.tree.current, this.value.peek()]]);
    this.historyVersion.value++;
    if (result.ahead) {
      status.value = { kind: "info", text: `${this.path} had edits that weren't written when the editor closed. They're in its edit history: Redo, or the History panel, brings them back.` };
    }
  }

  private replace(next: T): void {
    this.value.value = next;
    this.problems.value = [];
    this.write(next);
  }

  /** Queue writing `value` after the writes before it. A failed write doesn't stop later ones. */
  private write(value: T): void {
    const text = this.format.format(value);
    const seq = this.tree.current;
    this.lastText = text;
    this.inFlight++;
    const run = async () => {
      let wrote = false;
      try {
        if (!this.discarded) {
          await this.project.writeText(this.path, text);
          wrote = true;
        }
      } catch (err) {
        this.writeFailed = true;
        status.value = errorStatus(`Couldn't save ${this.path}`, err);
      } finally {
        this.inFlight--;
      }
      if (wrote) {
        this.writeFailed = false;
        if (this.tree.saved !== seq) {
          this.tree.markSaved(seq);
          this.historyChanged();
        }
        docVersion.value++;
      }
    };
    this.tail = this.tail.then(run);
  }

  /** The file changed (docVersion moved): take what it holds now if someone else changed it. */
  private reread(): void {
    if (this.closed || this.burst || this.inFlight > 0 || this.writeFailed) return;
    const read = this.format.parse(this.project.assets.get(this.path), this.path);
    const text = this.format.format(read.value);
    if (text === this.lastText) return;
    this.lastText = text;
    this.amend(text, read.value);
    this.tree.markSaved();
    this.value.value = read.value;
    this.problems.value = read.problems;
  }
}

/** The open documents, by path, all of one project. */
let documentsProject: EditorProject | null = null;
let documents = new Map<string, Document<unknown>>();
let lastSeenProject: EditorProject | null = null;
let stopFollowingProject: (() => void) | null = null;

function dropAll(write: boolean): void {
  for (const doc of documents.values()) doc.drop(write);
  documents = new Map();
  documentsProject = null;
  focused.value = null;
}

const focused = signal<Document<unknown> | null>(null);

/**
 * Clicks and focus inside these keep whichever editor's history was focused (ADR 0143): the History
 * panel showing it, and the menu bar whose Edit > Undo acts on it.
 */
export const KEEPS_HISTORY_FOCUS = '.history-panel, [role="menubar"], [role="menu"]';
let stopTrackingFocus: (() => void) | null = null;

/**
 * The asset document whose editor was last focused or clicked (its root carries
 * `data-asset-document` with the document's path), or null once something else was: the History
 * panel shows its tree instead of the scene's, and Undo / Redo act on it (activeHistory.ts, ADR 0143).
 * Clicks in the History panel and the menu bar keep it.
 */
export const focusedAssetDocument: ReadonlySignal<AssetDocument<unknown> | null> = focused;

/** Follow focus and clicks to set `focusedAssetDocument` (installed with the first document). */
function trackFocus(): void {
  if (stopTrackingFocus || typeof document === "undefined") return;
  const onFocus = (e: Event) => {
    const el = e.target as Element | null;
    if (!el?.closest) return;
    const host = el.closest("[data-asset-document]");
    if (host) focused.value = documents.get(host.getAttribute("data-asset-document") ?? "") ?? null;
    else if (!el.closest(KEEPS_HISTORY_FOCUS)) focused.value = null;
  };
  document.addEventListener("focusin", onFocus, true);
  document.addEventListener("pointerdown", onFocus, true);
  stopTrackingFocus = () => {
    document.removeEventListener("focusin", onFocus, true);
    document.removeEventListener("pointerdown", onFocus, true);
  };
}

/** Drop the documents when the editor switches project (installed with the first document). */
function followProject(): void {
  trackFocus();
  if (stopFollowingProject) return;
  lastSeenProject = currentProject.peek();
  stopFollowingProject = effect(() => {
    const project = currentProject.value;
    if (project === lastSeenProject) return;
    lastSeenProject = project;
    untracked(() => dropAll(true));
  });
}

/**
 * The document for `path`, made from the registered format `formatId` (an asset kind id). Same
 * object for the same project and path until the file is deleted or the project changes. Throws
 * if no such format.
 */
export function openAssetDocument<T>(project: EditorProject, path: string, formatId: string): AssetDocument<T> {
  const format = assetFormats.get(formatId) as AssetFormatContribution<T> | undefined;
  if (!format) throw new Error(`No asset format "${formatId}" is registered.`);
  followProject();
  if (documentsProject !== project) {
    dropAll(true);
    documentsProject = project;
  }
  let doc = documents.get(path) as Document<T> | undefined;
  if (!doc) {
    doc = new Document<T>(project, path, format);
    documents.set(path, doc as Document<unknown>);
  }
  return doc;
}

/** Called by moveAssets: documents (and their history, open or not) at `from`, or inside folder `from`, move to `to`. */
export function assetDocumentsMoved(moves: readonly (readonly [string, string])[]): void {
  const project = documentsProject ?? currentProject.peek();
  if (project) void moveAssetHistories(project, moves); // queued before the open documents write at their new paths
  if (documents.size === 0) return;
  const next = new Map<string, Document<unknown>>();
  for (const doc of documents.values()) {
    for (const [from, to] of moves) {
      if (isWithin(doc.path, from)) {
        doc.path = to + doc.path.slice(from.length);
        break;
      }
    }
    next.set(doc.path, doc);
  }
  documents = next;
}

/** Called by deleteAssets: documents at or inside these paths are dropped with their history; later edits on a held reference do nothing. */
export function assetDocumentsDeleted(paths: readonly string[]): void {
  const project = documentsProject ?? currentProject.peek();
  for (const [path, doc] of [...documents]) {
    if (!paths.some((p) => isWithin(path, p.replace(/\/+$/, "")))) continue;
    doc.drop(false);
    documents.delete(path);
    if (focused.peek() === doc) focused.value = null;
  }
  if (project) void deleteAssetHistories(project, paths); // saved histories too, open or not
}

/** Tests: forget every document and stop following the project. */
export function _reset(): void {
  dropAll(false);
  stopFollowingProject?.();
  stopFollowingProject = null;
  lastSeenProject = null;
  stopTrackingFocus?.();
  stopTrackingFocus = null;
  _resetAssetHistory();
}

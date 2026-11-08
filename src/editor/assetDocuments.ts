// Asset documents (ADR 0133 "asset document"): one place that owns editing an asset file. A
// document holds the file's value made by its registered format, writes edits in order, keeps
// undo and redo, notices changes made elsewhere, and follows renames and deletes (assetOps.ts and
// assetDelete.ts call `assetDocumentsMoved` / `assetDocumentsDeleted`). Signals only, no components,
// so panels just read `value` and call `edit`.
import { computed, effect, signal, untracked, type ReadonlySignal } from "@preact/signals";
import { errorStatus } from "./messages";
import { isWithin, type EditorProject } from "./projects";
import { assetFormats, type AssetFormatContribution, type AssetProblem } from "./sdk/contributions";
import { currentProject, docVersion, status } from "./state";

export interface EditOptions {
  /** Merge with the previous coalesced edit into one undo step, and write after the format's writeDelay (default 150 ms) of quiet. For sliders and drags. */
  coalesce?: boolean;
  /** False: a view change (a collapsed frame) that's written but makes no undo step and leaves the history as it is. */
  history?: false;
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
  /**
   * Replace the value: one undo step (or merged, see coalesce); queued write. On a read-only
   * project: says so in the status bar and changes nothing.
   */
  edit(next: T, options?: EditOptions): void;
  undo(): void;
  redo(): void;
  /** Write any pending coalesced edit now; resolves when every queued write has settled. */
  flush(): Promise<void>;
}

const HISTORY_LIMIT = 200;
const DEFAULT_WRITE_DELAY = 150;

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

class Document<T> implements AssetDocument<T> {
  readonly value;
  readonly problems;
  readonly canUndo: ReadonlySignal<boolean>;
  readonly canRedo: ReadonlySignal<boolean>;
  // In memory for the session; persisting it as 0027's UndoTree is a later step of ADR 0133.
  private readonly undoStack: T[] = [];
  private readonly redoStack: T[] = [];
  /** Bumped when the stacks or the pending burst change, for canUndo/canRedo. */
  private readonly historyVersion = signal(0);
  /** The value before a coalesced burst that hasn't been written yet, with its write timer. */
  private burst: { before: T; timer: ReturnType<typeof setTimeout> } | null = null;
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
    public path: string,
    private readonly format: AssetFormatContribution<T>,
  ) {
    const read = format.parse(project.assets.get(path), path);
    this.value = signal<T>(read.value);
    this.problems = signal<readonly AssetProblem[]>(read.problems);
    this.lastText = format.format(read.value);
    this.canUndo = computed(() => (this.historyVersion.value, this.undoStack.length > 0 || this.burst !== null));
    this.canRedo = computed(() => (this.historyVersion.value, this.redoStack.length > 0));
    this.stopWatching = effect(() => {
      docVersion.value;
      untracked(() => this.reread());
    });
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
    if (options.coalesce) {
      if (this.burst) clearTimeout(this.burst.timer);
      const before = this.burst ? this.burst.before : this.value.peek();
      this.burst = { before, timer: setTimeout(() => this.endBurst(), this.format.writeDelay ?? DEFAULT_WRITE_DELAY) };
      this.value.value = next;
      this.problems.value = [];
      this.historyVersion.value++;
      return;
    }
    this.endBurst();
    const before = this.value.peek();
    if (this.format.format(next) === this.format.format(before)) return;
    if (options.history !== false) this.record(before);
    this.replace(next);
  }

  undo(): void {
    if (this.closed || this.readOnly) return;
    this.endBurst();
    const previous = this.undoStack.pop();
    if (previous === undefined) return;
    this.redoStack.push(this.value.peek());
    this.historyVersion.value++;
    this.replace(previous);
  }

  redo(): void {
    if (this.closed || this.readOnly) return;
    this.endBurst();
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.value.peek());
    this.historyVersion.value++;
    this.replace(next);
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
    if (this.format.format(now) === this.format.format(burst.before)) return;
    this.record(burst.before);
    this.write(now);
  }

  private record(before: T): void {
    this.undoStack.push(before);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.historyVersion.value++;
  }

  private replace(next: T): void {
    this.value.value = next;
    this.problems.value = [];
    this.write(next);
  }

  /** Queue writing `value` after the writes before it. A failed write doesn't stop later ones. */
  private write(value: T): void {
    const text = this.format.format(value);
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
}

/** Drop the documents when the editor switches project (installed with the first document). */
function followProject(): void {
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

/** Called by moveAssets: documents (and their history) at `from`, or inside folder `from`, move to `to`. */
export function assetDocumentsMoved(moves: readonly (readonly [string, string])[]): void {
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
  for (const [path, doc] of [...documents]) {
    if (!paths.some((p) => isWithin(path, p))) continue;
    doc.drop(false);
    documents.delete(path);
  }
}

/** Tests: forget every document and stop following the project. */
export function _reset(): void {
  dropAll(false);
  stopFollowingProject?.();
  stopFollowingProject = null;
  lastSeenProject = null;
}

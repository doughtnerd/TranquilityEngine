// Asset documents (ADR 0133 "asset document"): one place that owns editing an asset file. A
// document holds the file's value made by its registered format, writes edits in order, keeps
// undo and redo, notices changes made elsewhere, and follows renames and deletes (assetOps.ts and
// assetDelete.ts call `assetDocumentsMoved` / `assetDocumentsDeleted`). Signals only, no components,
// so panels just read `value` and call `edit`. It is also the owner a project-wide edit asks to change
// an asset file (`assetFileOwner`, ADR 0302): the open document, else the kind's format.
//
// The undo history is 0027's persistent tree (`TextHistory`, each step a text patch of the file),
// saved with the scene's store and rules by assetHistory.ts: undoing then editing keeps the undone
// branch, and reopening the project brings the history back. It follows renames and is deleted
// with its file.
import { fileName } from "./projectPath";
import { computed, effect, signal, untracked, type ReadonlySignal } from "@preact/signals";
import { deepEqual } from "../engine/audio/deepEqual";
import { deleteAssetHistories, moveAssetHistories, persistHistory, type HistoryOutcome, type PersistedHistory } from "./historyPersistence";
import type { HistoryState } from "./document/HistoryTree";
import { TextHistory } from "./document/TextHistory"; // by leaf path: the barrel pulls in the scene loader (ADR 0341)
import { errorStatus } from "./messages";
import { isWithin, type EditorProject } from "./projects";
import { assetKinds, type AssetFormat, type AssetProblem } from "./sdk/contributions";
import { assetKind } from "./assetKindLookup";
import { currentProject, docVersion, status } from "./state";
import { editorFocus } from "./windows/editorFocus";
import { readOnlyMessage } from "./readOnly";

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
  /** Write any pending coalesced edit now; resolves when every queued write has settled, the edit history's included. */
  flush(): Promise<void>;
  /** The history tree, for the History panel. */
  readonly history: AssetHistoryView;
}

const DEFAULT_WRITE_DELAY = 150;
const DEFAULT_LABEL = "Edit";


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
  private readonly persistence: PersistedHistory | null;
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
    private readonly format: AssetFormat<T>,
  ) {
    const read = parseWith(format, project.assets.get(path), path);
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
      ? persistHistory({
          project,
          kind: "asset",
          tree: this.tree,
          path: () => this.tree.path,
          saveFailed: (err) => (status.value = errorStatus(`Couldn't save the edit history for ${this.path}`, err)),
        })
      : null;
    void this.persistence?.loaded.then((outcome) => this.historyLoaded(outcome));
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
      const text = readOnlyMessage(this.project, `change ${fileName(this.path)}`);
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
    const value = parseWith(this.format, raw, this.path).value;
    this.values.set(seq, value);
    return value;
  }

  flush(): Promise<void> {
    this.endBurst();
    return Promise.all([this.tail, this.persistence?.written()]).then(() => undefined);
  }

  /** Resolves when the edit history's queued disk work so far is done. */
  historyWritten(): Promise<void> {
    return this.persistence?.written() ?? Promise.resolve();
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

  /** The file's text as this document holds it: its value through the format, unwritten edits included. */
  get text(): string {
    return this.format.format(this.value.peek());
  }

  /**
   * A project-wide change to the file's JSON (ADR 0302): a pending burst becomes its step first, then every state of
   * the history takes the change, so the current value is changed and written after the writes before it, and undo
   * and redo never bring back what it replaced. Not a step of its own. Returns whether the current value changed.
   */
  change(change: AssetFileChange): boolean {
    if (this.closed || this.readOnly) return false;
    this.endBurst();
    const changed = this.tree.rewrite((text) => {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return text;
      }
      const next = change(raw);
      return next === null ? text : this.format.format(parseWith(this.format, next, this.path).value);
    });
    this.values = new Map();
    if (!changed) {
      this.values.set(this.tree.current, this.value.peek());
      this.historyChanged();
      return false;
    }
    const value = this.valueOf(this.tree.current);
    this.historyChanged();
    this.replace(value);
    return true;
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
  private historyLoaded(outcome: HistoryOutcome): void {
    if (this.closed || outcome.kind === "new") return;
    if (outcome.kind === "set aside") {
      // Edits made while it loaded start their own history (ADR 0316): nothing to tell.
      if (outcome.why === "changed") status.value = { kind: "info", text: `${this.path} changed outside the editor, so its saved edit history no longer applies; starting a new one.` };
      return;
    }
    this.values = new Map([[this.tree.current, this.value.peek()]]);
    this.historyVersion.value++;
    if (outcome.ahead !== null) {
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
    const read = parseWith(this.format, this.project.assets.get(this.path), this.path);
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
  documentsDropped.value++;
}

/** Bumped when documents are dropped or deleted, so `focusedAssetDocument` lets go of them. */
const documentsDropped = signal(0);

/**
 * The asset document whose editor holds the editor focus (focus or the last press, in any editor
 * window: windows/editorFocus.ts, ADR 0174): the nearest root marked `data-asset-document` with the
 * document's path. Null once something else was focused, or once the document is dropped. The History
 * panel shows its tree instead of the scene's, and Undo / Redo act on it (activeHistory.ts, ADR 0145).
 * Clicks in the History panel and the menu bar keep it (KEEPS_HISTORY_FOCUS).
 */
export const focusedAssetDocument: ReadonlySignal<AssetDocument<unknown> | null> = computed(() => {
  documentsDropped.value;
  const host = editorFocus.value?.closest("[data-asset-document]");
  return (host && documents.get(host.getAttribute("data-asset-document") ?? "")) || null;
});

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

/** What reading an asset file gives: its value and what's wrong with it (bad values read as defaults). */
export interface AssetRead<T> {
  readonly value: T;
  readonly problems: readonly AssetProblem[];
}

/** `format.parse`, with a throw read as the format's `empty()` and the error's message as the problem (ADR 0233). */
function parseWith<T>(format: AssetFormat<T>, raw: unknown, path: string): AssetRead<T> {
  try {
    return format.parse(raw, path);
  } catch (err) {
    return { value: format.empty(), problems: [{ message: (err as Error).message }] };
  }
}

/** The format of the registered asset kind `kindId`. Throws when the kind isn't registered or has no format. */
function formatOf<T>(kindId: string): AssetFormat<T> {
  const format = assetKinds.get(kindId)?.format as AssetFormat<T> | undefined;
  if (!format) throw new Error(`No asset kind "${kindId}" with a format is registered.`);
  return format;
}

/**
 * The current value of the asset file at `path` (ADR 0233): its open document's value, edits not yet written
 * included, else what the file holds now, read with its kind's format (`kindId`, default the kind of `path`).
 * Reading an open document's value tracks it. Throws when the kind has no format.
 */
export function readAsset<T>(project: EditorProject, path: string, kindId: string = assetKind(path)): AssetRead<T> {
  const doc = documentsProject === project ? (documents.get(path) as Document<T> | undefined) : undefined;
  if (doc) return { value: doc.value.value, problems: doc.problems.value };
  return parseWith(formatOf<T>(kindId), project.assets.get(path), path);
}

/**
 * The document for `path`, made from the format of the asset kind `kindId` (default: the kind of `path`). Same
 * object for the same project and path until the file is deleted or the project changes. Throws if the kind has no
 * format.
 */
export function openAssetDocument<T>(project: EditorProject, path: string, kindId: string = assetKind(path)): AssetDocument<T> {
  const format = formatOf<T>(kindId);
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

/**
 * Called by moveAssets: documents (and their history, open or not) at `from`, or inside folder `from`,
 * move to `to`. Resolves when the saved histories have moved and the open documents write theirs at
 * the new paths.
 */
export function assetDocumentsMoved(moves: readonly (readonly [string, string])[]): Promise<void> {
  const project = documentsProject ?? currentProject.peek();
  const work: Promise<void>[] = [];
  if (project) work.push(moveAssetHistories(project, moves)); // queued before the open documents write at their new paths
  if (documents.size > 0) {
    const next = new Map<string, Document<unknown>>();
    for (const doc of documents.values()) {
      for (const [from, to] of moves) {
        if (isWithin(doc.path, from)) {
          doc.path = to + doc.path.slice(from.length);
          work.push(doc.historyWritten());
          break;
        }
      }
      next.set(doc.path, doc);
    }
    documents = next;
  }
  return Promise.all(work).then(() => undefined);
}

/**
 * Called by deleteAssets: documents at or inside these paths are dropped with their history; later
 * edits on a held reference do nothing. Resolves when the saved histories are deleted.
 */
export function assetDocumentsDeleted(paths: readonly string[]): Promise<void> {
  const project = documentsProject ?? currentProject.peek();
  for (const [path, doc] of [...documents]) {
    if (!paths.some((p) => isWithin(path, p.replace(/\/+$/, "")))) continue;
    doc.drop(false);
    documents.delete(path);
  }
  documentsDropped.value++;
  return project ? deleteAssetHistories(project, paths) : Promise.resolve(); // saved histories too, open or not
}

/** A project-wide change to an asset file's parsed JSON (a moved reference, a renamed name): the new JSON, or null for no change. */
export type AssetFileChange = (json: unknown) => unknown;

/** Who applies a project-wide change to an asset file of a kind with a format (ADR 0302). */
export interface AssetFileOwner {
  /** The file's text as its owner holds it: the open document's, unwritten edits included, else the file's. */
  readonly text: string | undefined;
  /** Apply `change`; resolves, once it is written, to whether the file changed. */
  apply(change: AssetFileChange): Promise<boolean>;
}

/**
 * The owner of the asset file at `path` (ADR 0302), or null when its kind has no format (the caller writes it):
 * - **open:** its asset document. The change is applied to every state of the document's history, a pending burst
 *   first made its step, and written in order with the document's edits; undo and redo never bring back what it
 *   replaced, and it makes no step of its own.
 * - **closed:** the kind's format writes the changed file in its own layout, unless the format would lose part of it
 *   (it reads with problems, or its text doesn't hold everything the changed JSON does); then the changed JSON is
 *   written as it is, so nothing is dropped.
 */
export function assetFileOwner(project: EditorProject, path: string): AssetFileOwner | null {
  const format = assetKinds.get(assetKind(path))?.format as AssetFormat<unknown> | undefined;
  if (!format) return null;
  const doc = documentsProject === project ? documents.get(path) : undefined;
  if (doc) {
    return {
      get text() {
        return doc.text;
      },
      apply: async (change) => {
        const changed = doc.change(change);
        await doc.flush();
        return changed;
      },
    };
  }
  return {
    get text() {
      return project.textOf(path);
    },
    apply: async (change) => {
      const text = project.textOf(path);
      if (text === undefined) return false;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return false;
      }
      const next = change(raw);
      if (next === null) return false;
      await project.writeText(path, formattedLosslessly(format, next, path) ?? `${JSON.stringify(next, null, 2)}\n`);
      return true;
    },
  };
}

/** `json` written by `format`, or null when that would lose something: it reads with problems, or its text doesn't parse back to `json`. */
function formattedLosslessly<T>(format: AssetFormat<T>, json: unknown, path: string): string | null {
  const read = parseWith(format, json, path);
  if (read.problems.length > 0) return null;
  const text = format.format(read.value);
  try {
    return deepEqual(JSON.parse(text), json) ? text : null;
  } catch {
    return null;
  }
}

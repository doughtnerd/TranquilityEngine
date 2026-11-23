// Keeping edit history on disk (ADR 0027, 0141, 0316): one module for a scene's command stack and an asset
// document's text history. It loads the saved history when the document opens (adopting it when a state's hash
// matches the file, setting it aside otherwise), saves after every change through one ordered disk queue per
// project (changes in a row are written together; one message per failure streak), follows the "where history is
// kept" setting, and moves or removes asset histories with their files. Its hosts (the scene tabs, the asset
// documents) hear only the load's outcome and save failures.
//
// Scene histories live in `.myco/history/` (per-user storage: `history-…` keys) and stay where they are when a
// scene moves; asset histories live in `.myco/asset-history/` (`asset-history-…` keys) and follow their file: a
// rename or move moves them, a delete removes them, so a new file at an old path starts afresh.
import { effect, type ReadonlySignal } from "@preact/signals";
import type { CommandStack } from "./document/CommandStack";
import type { AgeOptions, HistoryFile } from "./document/HistoryTree";
import { hashText } from "./document/patch"; // by leaf path: the barrel pulls in the scene loader (ADR 0341)
import { HistoryStore, projectSlots, type SlotBackend } from "./historyStore";
import { historyLocation, historyPruneDays } from "./preferences";
import { editorPlatform, projectFolder, projectKey, type EditorPlatform } from "./projectPlace";
import { isWithin, joinPath, type EditorProject } from "./projects";

export type HistoryLocation = "project" | "user";

/** Which kind of document's history: where it's kept and whether it follows its file. */
export type HistoryKind = "scene" | "asset";

/**
 * A history tree the module saves, through its own adapter: an asset document's `TextHistory` as it is, a scene's
 * `CommandStack` through `sceneHistory`.
 */
export interface PersistedTree {
  /** Whether nothing has been recorded yet (only the state the file was opened in). */
  readonly empty: boolean;
  /** Adopt a saved history with a state matching the document as it is now; null (nothing changes) when none does. */
  load(file: HistoryFile, options: AgeOptions): { matched: number; lastCurrent: number } | null;
  toFile(options: AgeOptions): HistoryFile;
}

/** A scene's command stack as a persisted tree: its history file names the scene, and one for another scene isn't adopted. */
export function sceneHistory(stack: CommandStack, scene: string): PersistedTree {
  return {
    get empty() {
      return stack.allStates.length === 1;
    },
    load: (file, options) => (file.scene === scene ? stack.load(file, options) : null),
    toFile: (options) => stack.toFile(scene, options),
  };
}

/**
 * What loading found:
 * - `adopted`: the saved history matched the file; `ahead` is the state it was at when written if that's past the
 *   file's (unsaved changes when the editor closed), else null.
 * - `set aside`: a saved history was found but not adopted, because the file `changed` outside the editor, or
 *   because the document was `edited` before the history finished loading (the edits win). Either way a new
 *   history starts and replaces it.
 * - `new`: nothing was saved.
 */
export type HistoryOutcome =
  | { readonly kind: "adopted"; readonly ahead: number | null }
  | { readonly kind: "set aside"; readonly why: "changed" | "edited" }
  | { readonly kind: "new" };

export interface HistoryOptions {
  readonly project: EditorProject;
  readonly kind: HistoryKind;
  readonly tree: PersistedTree;
  /** The document's path now (an asset's changes when its file moves; call `relocate`). */
  path(): string;
  /** A save failed (once per failure streak). */
  saveFailed(err: unknown): void;
  /** Where history is kept; followed while the history is open. Default: the editor preference. */
  readonly location?: ReadonlySignal<HistoryLocation>;
  /** Default: the editor's platform. */
  platform?(): Promise<EditorPlatform>;
  /** "Prune history older than N days" (0: never), read on load and each save (ADR 0116). Default: the preference. */
  pruneDays?(): number;
}

// --- where histories are kept ------------------------------------------------------------------

const FOLDERS: Record<HistoryKind, string> = { scene: ".myco/history", asset: ".myco/asset-history" };

/** One place a kind of history is kept: slots per document, and moving or removing a document's (or a folder's). */
interface SlotSpace {
  slots(path: string): SlotBackend;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

function folderSpace(project: EditorProject, kind: HistoryKind, p: EditorPlatform): SlotSpace | null {
  const folder = projectFolder(project, p);
  const fs = folder?.write;
  if (!folder || !fs) return null;
  const root = folder.root;
  const base = FOLDERS[kind];
  const at = (rel: string) => joinPath(root, `${base}/${rel}`);
  // A document's two slot files, and the folder of the histories inside a folder.
  const entries = (path: string) => [at(`${path}.history.a.json`), at(`${path}.history.b.json`), at(path)];
  const parent = (file: string) => file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")));
  const remove = async (path: string) => {
    for (const f of entries(path)) if (await fs.exists(f)) await fs.remove(f, { recursive: true });
  };
  return {
    slots: (path) => projectSlots(fs, root, path, base),
    async move(from, to) {
      await remove(to); // anything left there belongs to no file
      const targets = entries(to);
      for (const [i, f] of entries(from).entries()) {
        if (!(await fs.exists(f))) continue;
        await fs.mkdir(parent(targets[i]));
        await fs.rename(f, targets[i]);
      }
    },
    remove,
  };
}

function userSpace(project: EditorProject, kind: HistoryKind, p: EditorPlatform): SlotSpace {
  const storage = p.userStorage;
  const projectId = projectKey(project);
  // The keys every earlier version wrote, so histories in per-user storage carry over.
  const prefix = `asset-history-${hashText(projectId)}-`;
  const key =
    kind === "scene"
      ? (path: string, slot: "a" | "b") => `history-${hashText(`${projectId}|${path}`)}-${path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60)}.${slot}`
      : (path: string, slot: "a" | "b") => `${prefix}${encodeURIComponent(path)}.${slot}`;
  const within = async (folder: string) =>
    (await storage.list("cache"))
      .filter((k) => k.startsWith(prefix) && /\.[ab]$/.test(k))
      .map((k) => ({ key: k, path: decodeURIComponent(k.slice(prefix.length, -2)), slot: k.slice(-1) as "a" | "b" }))
      .filter((e) => isWithin(e.path, folder));
  const remove = async (path: string) => {
    for (const e of await within(path)) await storage.delete("cache", e.key);
  };
  return {
    slots: (path) => ({
      where: "per-user storage",
      async read(slot) {
        const v = await storage.load("cache", key(path, slot));
        return typeof v === "string" ? v : null;
      },
      async write(slot, text) {
        await storage.save("cache", key(path, slot), text);
      },
    }),
    async move(from, to) {
      await remove(to);
      for (const e of await within(from)) {
        await storage.save("cache", key(to + e.path.slice(from.length), e.slot), await storage.load("cache", e.key));
        await storage.delete("cache", e.key);
      }
    },
    remove,
  };
}

/** Where a history is written: the project folder when asked for and writable, otherwise per-user storage. */
function currentSpace(project: EditorProject, kind: HistoryKind, location: HistoryLocation, p: EditorPlatform): SlotSpace {
  return (location === "project" ? folderSpace(project, kind, p) : null) ?? userSpace(project, kind, p);
}

// --- the disk queue ------------------------------------------------------------------------------

/** Each project's disk work, in order: loads, saves, relocations, moves and deletes. */
const queues = new WeakMap<EditorProject, Promise<void>>();

function enqueue(project: EditorProject, task: () => Promise<void>): Promise<void> {
  const next = (queues.get(project) ?? Promise.resolve())
    .then(task)
    .catch((err: unknown) => console.warn(`[editor] edit history: ${err instanceof Error ? err.message : String(err)}`));
  queues.set(project, next);
  return next;
}

// --- one document's history ------------------------------------------------------------------------

/** One document's history on disk: loaded when it opens, saved after every change, until `stop`. */
export interface PersistedHistory {
  /** What loading found (it resolves before the first save is written). */
  readonly loaded: Promise<HistoryOutcome>;
  /** Save after a change; changes in a row are written together. */
  save(): void;
  /** Write to the slots for the document's current path from now on (an asset's file moved); the tree is written in full. */
  relocate(): void;
  /** Resolves when the disk work queued for this history so far is done. */
  written(): Promise<void>;
  /** Stop saving and following the location setting; resolves when the queued writes are done. */
  stop(): Promise<void>;
}

/** Load `options.tree`'s saved history and keep saving it. */
export function persistHistory(options: HistoryOptions): PersistedHistory {
  const { project, kind, tree } = options;
  const location = options.location ?? historyLocation;
  const platform = options.platform ?? editorPlatform;
  const pruneDays = options.pruneDays ?? (() => historyPruneDays.peek());
  let store: HistoryStore | null = null;
  let pending = false;
  let scheduled = false;
  let failing = false;
  let stopped = false;
  let resolveLoaded!: (outcome: HistoryOutcome) => void;
  const loaded = new Promise<HistoryOutcome>((r) => (resolveLoaded = r));

  const slots = async () => currentSpace(project, kind, location.peek(), await platform()).slots(options.path());

  const failed = (err: unknown) => {
    if (!failing) options.saveFailed(err);
    failing = true;
  };

  const saveNow = async () => {
    if (!store) return;
    pending = false;
    try {
      await store.save(tree.toFile({ pruneDays: pruneDays() }));
      failing = false;
    } catch (err) {
      failed(err);
    }
  };

  // Stopped before it ran, it adopts nothing, but saves queued before the stop still have a store to write to.
  const load = async () => {
    let outcome: HistoryOutcome = { kind: "new" };
    try {
      store = new HistoryStore(await slots());
      const file = await store.load();
      if (file && !stopped) {
        if (!tree.empty) outcome = { kind: "set aside", why: "edited" };
        else {
          const result = tree.load(file, { pruneDays: pruneDays() });
          outcome = result ? { kind: "adopted", ahead: result.lastCurrent !== result.matched ? result.lastCurrent : null } : { kind: "set aside", why: "changed" };
        }
      }
    } catch (err) {
      failed(err);
    }
    resolveLoaded(outcome);
    if (!stopped) await saveNow(); // make sure a history file exists from the start
  };

  let last = enqueue(project, load);

  const relocate = () => {
    if (stopped) return;
    last = enqueue(project, async () => {
      if (stopped) return;
      try {
        store = new HistoryStore(await slots());
        await store.load(); // continue after any generation already there
      } catch (err) {
        return failed(err);
      }
      await saveNow();
    });
  };

  // Switching where history is kept moves writing there right away.
  let first = true;
  const unfollow = effect(() => {
    location.value;
    if (first) first = false;
    else relocate();
  });

  return {
    loaded,
    save() {
      if (stopped) return;
      pending = true;
      if (scheduled) return;
      scheduled = true;
      last = enqueue(project, async () => {
        scheduled = false;
        if (pending) await saveNow();
      });
    },
    relocate,
    written: () => last,
    stop() {
      stopped = true;
      unfollow();
      return last;
    },
  };
}

// --- asset histories follow their files ----------------------------------------------------------

const trim = (path: string) => path.replace(/\/+$/, "");

/** One move or delete failing doesn't stop the others. */
async function tryTo(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.warn(`[editor] edit history: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Every place an asset's history may be (the setting may have changed since it was written). */
async function allAssetSpaces(project: EditorProject, platform: () => Promise<EditorPlatform>): Promise<SlotSpace[]> {
  const p = await platform();
  const folder = folderSpace(project, "asset", p);
  return folder ? [folder, userSpace(project, "asset", p)] : [userSpace(project, "asset", p)];
}

/** Assets (or folders) moved: their saved histories move with them, wherever they're kept, in order with the project's other disk work. */
export function moveAssetHistories(project: EditorProject, moves: readonly (readonly [string, string])[], platform = editorPlatform): Promise<void> {
  if (!project.canSave || moves.length === 0) return Promise.resolve();
  return enqueue(project, async () => {
    for (const space of await allAssetSpaces(project, platform)) for (const [from, to] of moves) await tryTo(() => space.move(trim(from), trim(to)));
  });
}

/** Assets (or folders) deleted: their saved histories go too. */
export function deleteAssetHistories(project: EditorProject, paths: readonly string[], platform = editorPlatform): Promise<void> {
  if (!project.canSave || paths.length === 0) return Promise.resolve();
  return enqueue(project, async () => {
    for (const space of await allAssetSpaces(project, platform)) for (const path of paths) await tryTo(() => space.remove(trim(path)));
  });
}

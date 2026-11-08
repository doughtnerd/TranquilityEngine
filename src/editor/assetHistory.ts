// Keeping asset documents' edit history on disk (ADR 0133 gives them 0027's persistent tree). The
// scene's store and rules: the same two-slot `HistoryStore`, the same location setting (the
// project folder, or per-user storage, which read-only projects always use), the same pruning by
// age, and on open the state whose hash matches the file is taken (none: the history is set aside
// and a new one starts). Asset histories live apart from the scenes' (`.myco/asset-history/` in
// the folder, their own keys in per-user storage) because, unlike a scene's, they follow their
// file: a rename or move moves them, and a delete removes them, so a new file at an old path
// starts afresh. All disk work goes through one queue, so moves, deletes and saves happen in order.
import { effect } from "@preact/signals";
import { hashText, type TextHistory } from "./document";
import { defaultHistoryPlatform, type HistoryLocation, type HistoryPlatform } from "./historyPersistence";
import { HistoryStore, projectSlots, type SlotBackend } from "./historyStore";
import { pruneHistoryByAge } from "./historyPrune";
import { historyLocation, historyPruneDays } from "./preferences";
import { isWithin, joinPath, type EditorProject } from "./projects";

/** Asset documents' history folder inside a project: `<dir>/<asset path>.history.<slot>.json`. */
export const ASSET_HISTORY_DIR = ".myco/asset-history";

/** One place asset histories are kept: slots per asset, and moving or removing an asset's (or a folder's). */
interface SlotSpace {
  slots(path: string): SlotBackend;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

function projectSpace(project: EditorProject, p: HistoryPlatform): SlotSpace | null {
  // The project's own file system first: a browser folder (ADR 0038) isn't the platform's.
  const fs = project.fileSystem?.canWrite ? project.fileSystem : p.fs;
  const root = project.root;
  if (!project.canSave || !root || !fs) return null;
  const at = (rel: string) => joinPath(root, `${ASSET_HISTORY_DIR}/${rel}`);
  // An asset's two slot files, and the folder of the asset histories inside a folder.
  const entries = (path: string) => [at(`${path}.history.a.json`), at(`${path}.history.b.json`), at(path)];
  const parent = (file: string) => file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")));
  const remove = async (path: string) => {
    for (const f of entries(path)) if (await fs.exists(f)) await fs.remove(f, { recursive: true });
  };
  return {
    slots: (path) => projectSlots(fs, root, path, ASSET_HISTORY_DIR),
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

function userSpace(project: EditorProject, p: HistoryPlatform): SlotSpace {
  const storage = p.userStorage;
  const prefix = `asset-history-${hashText(project.root ?? `bundled:${project.name}`)}-`;
  const key = (path: string, slot: "a" | "b") => `${prefix}${encodeURIComponent(path)}.${slot}`;
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

/** Where an asset's history is written: the project folder when asked for and writable, otherwise per-user storage. */
function currentSpace(project: EditorProject, location: HistoryLocation, p: HistoryPlatform): SlotSpace {
  return (location === "project" ? projectSpace(project, p) : null) ?? userSpace(project, p);
}

/** Every place an asset's history may be (the setting may have changed since it was written). */
function allSpaces(project: EditorProject, p: HistoryPlatform): SlotSpace[] {
  const folder = projectSpace(project, p);
  return folder ? [folder, userSpace(project, p)] : [userSpace(project, p)];
}

let platformSource: () => Promise<HistoryPlatform> = defaultHistoryPlatform;

/** Tests: use in-memory storage (null: the real platform again). */
export function _useAssetHistoryPlatform(p: HistoryPlatform | null): void {
  platformSource = p ? async () => p : defaultHistoryPlatform;
}

let queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task).catch((err) => console.warn(`[editor] asset history: ${err instanceof Error ? err.message : String(err)}`));
  return queue;
}

/** Resolves when all queued history work (loads, saves, moves, deletes) is done. */
export async function assetHistorySettled(): Promise<void> {
  let seen: Promise<void>;
  do {
    seen = queue;
    await seen;
  } while (seen !== queue);
}

/** What an asset document gives its history's persistence. */
export interface AssetHistoryHost {
  readonly project: EditorProject;
  /** The tree; its `path` is the file's current path. */
  readonly tree: TextHistory;
  /** A saved history was found: `adopted` if it matched the file (with whether it was last past the file's state), else it was set aside. */
  loaded(result: { adopted: true; ahead: boolean } | { adopted: false }): void;
  /** A save failed (once per failure streak). */
  saveFailed(err: unknown): void;
}

const attached = new Set<AssetHistoryPersistence>();
let stopFollowingLocation: (() => void) | null = null;

/** Switching where history is kept moves writing there right away (the tree is written in full), as for scenes. */
function followLocation(): void {
  if (stopFollowingLocation) return;
  let first = true;
  stopFollowingLocation = effect(() => {
    historyLocation.value;
    if (first) {
      first = false;
      return;
    }
    for (const h of attached) h.relocate();
  });
}

/** One asset document's history on disk: loaded when the document opens, saved after every change. */
export class AssetHistoryPersistence {
  private store: HistoryStore | null = null;
  private pending = false;
  private scheduled = false;
  private failing = false;
  private stopped = false;

  constructor(private readonly host: AssetHistoryHost) {
    attached.add(this);
    followLocation();
    void enqueue(() => this.load());
  }

  private async slots(): Promise<SlotBackend> {
    return currentSpace(this.host.project, historyLocation.peek(), await platformSource()).slots(this.host.tree.path);
  }

  private async load(): Promise<void> {
    if (this.stopped) return;
    this.store = new HistoryStore(await this.slots());
    const loaded = await this.store.load();
    if (this.stopped) return;
    const file = loaded ? pruneHistoryByAge(loaded, historyPruneDays.peek()) : null;
    const tree = this.host.tree;
    // Edits made while it loaded start their own history, written over the old one.
    if (file && tree.empty) {
      const result = tree.load(file);
      this.host.loaded(result ? { adopted: true, ahead: result.lastCurrent !== result.matched } : { adopted: false });
    }
    await this.saveNow(); // make sure a history file exists from the start
  }

  /** Save after a change; changes in a row are written together. */
  save(): void {
    if (this.stopped) return;
    this.pending = true;
    if (this.scheduled) return;
    this.scheduled = true;
    void enqueue(async () => {
      this.scheduled = false;
      if (this.pending) await this.saveNow();
    });
  }

  /** Write to the slots for the tree's current path and the current location from now on (after a rename, or the setting changed). */
  relocate(): void {
    if (this.stopped) return;
    void enqueue(async () => {
      if (this.stopped) return;
      this.store = new HistoryStore(await this.slots());
      await this.store.load(); // continue after any generation already there
      await this.saveNow();
    });
  }

  /** Stop saving (queued saves still run). */
  stop(): void {
    this.stopped = true;
    attached.delete(this);
  }

  private async saveNow(): Promise<void> {
    if (!this.store) return;
    this.pending = false;
    try {
      await this.store.save(pruneHistoryByAge(this.host.tree.toFile(), historyPruneDays.peek()));
      this.failing = false;
    } catch (err) {
      if (!this.failing) this.host.saveFailed(err);
      this.failing = true;
    }
  }
}

const trim = (path: string) => path.replace(/\/+$/, "");

/** One move or delete failing doesn't stop the others. */
async function tryTo(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.warn(`[editor] asset history: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Assets (or folders) moved: their saved histories move with them, wherever they're kept. */
export function moveAssetHistories(project: EditorProject, moves: readonly (readonly [string, string])[]): Promise<void> {
  if (!project.canSave || moves.length === 0) return Promise.resolve();
  return enqueue(async () => {
    const p = await platformSource();
    for (const space of allSpaces(project, p)) for (const [from, to] of moves) await tryTo(() => space.move(trim(from), trim(to)));
  });
}

/** Assets (or folders) deleted: their saved histories go too. */
export function deleteAssetHistories(project: EditorProject, paths: readonly string[]): Promise<void> {
  if (!project.canSave || paths.length === 0) return Promise.resolve();
  return enqueue(async () => {
    const p = await platformSource();
    for (const space of allSpaces(project, p)) for (const path of paths) await tryTo(() => space.remove(trim(path)));
  });
}

/** Tests: forget attached histories and stop following the setting. */
export function _resetAssetHistory(): void {
  for (const h of [...attached]) h.stop();
  stopFollowingLocation?.();
  stopFollowingLocation = null;
}

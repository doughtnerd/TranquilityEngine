// Keeping a scene's edit history on disk (ADR 0027): load it when the scene opens (matching it to
// the file by content hash), and save it after every step, undo, redo, jump and save. Writes are
// queued and coalesced, so a burst of edits (a drag) costs at most one write in flight plus one
// queued.
import { BrowserStorage } from "../engine/platform/BrowserStorage";
import { getFileSystem, isTauri, type FileSystem } from "../engine/platform/FileSystem";
import { MemoryStorage, type StorageBackend } from "../engine/platform/Storage";
import type { CommandStack } from "./document";
import { HistoryStore, projectSlots, userSlots, type SlotBackend } from "./historyStore";
import type { EditorProject } from "./projects";

export type HistoryLocation = "project" | "user";

/** What `attachHistory` needs from the platform; tests pass in-memory versions. */
export interface HistoryPlatform {
  fs: FileSystem | null;
  userStorage: StorageBackend;
}

let platform: Promise<HistoryPlatform> | null = null;

/** The real platform: the FileSystem, and per-user storage (app data under Tauri, IndexedDB in browsers). */
export function defaultHistoryPlatform(): Promise<HistoryPlatform> {
  return (platform ??= (async () => {
    const fs = await getFileSystem();
    if (isTauri()) {
      const { TauriStorage } = await import("../engine/platform/TauriStorage");
      return { fs, userStorage: await TauriStorage.create(fs) };
    }
    return { fs: fs.canWrite ? fs : null, userStorage: typeof indexedDB !== "undefined" ? new BrowserStorage("tranquility-editor") : new MemoryStorage() };
  })());
}

/** Where a project's history goes: its folder when asked for and writable, otherwise per-user storage. */
export function slotsFor(project: EditorProject, scene: string, location: HistoryLocation, p: HistoryPlatform): SlotBackend {
  if (location === "project" && project.canSave && project.root && p.fs) return projectSlots(p.fs, project.root, scene);
  return userSlots(p.userStorage, project.root ?? `bundled:${project.name}`, scene);
}

export interface AttachedHistory {
  /** Set when the history was last at a state other than the file's (unsaved changes when the editor closed). */
  readonly restorable: { seq: number; label: string; time: number } | null;
  /** Whether a history file was found but didn't match the file (changed outside the editor). */
  readonly mismatched: boolean;
  /** Where it's being written, for messages. */
  readonly where: string;
  /** Write to another location from now on (the current tree is written there right away). */
  relocate(slots: SlotBackend): Promise<void>;
  /** Wait for queued writes. */
  flush(): Promise<void>;
  /** Stop saving (after a final flush). */
  detach(): Promise<void>;
}

/**
 * Load `stack`'s saved history from `slots` (if it matches the document) and keep saving it.
 * `onError` hears write failures (once per failure streak).
 */
export async function attachHistory(stack: CommandStack, scene: string, slots: SlotBackend, onError: (err: unknown) => void = () => {}): Promise<AttachedHistory> {
  let store = new HistoryStore(slots);
  let restorable: AttachedHistory["restorable"] = null;
  let mismatched = false;
  const saved = await store.load();
  if (saved && saved.scene === scene) {
    const result = stack.load(saved);
    if (!result) mismatched = true;
    else if (result.lastCurrent !== result.matched) {
      const s = stack.allStates.find((x) => x.seq === result.lastCurrent)!;
      restorable = { seq: s.seq, label: s.label, time: s.time };
    }
  }

  let writing: Promise<void> | null = null;
  let pending = false;
  let failing = false;
  const write = (): Promise<void> => {
    pending = true;
    if (writing) return writing;
    writing = (async () => {
      // Listeners hear an edit before the stack records it as a step; let that finish first.
      await Promise.resolve();
      while (pending) {
        pending = false;
        try {
          await store.save(stack.toFile(scene));
          failing = false;
        } catch (err) {
          if (!failing) onError(err);
          failing = true;
        }
      }
      writing = null;
    })();
    return writing;
  };
  const unsubscribe = stack.subscribe(() => void write());
  await write(); // make sure a history file exists from the start

  let where = slots.where;
  return {
    restorable,
    mismatched,
    get where() {
      return where;
    },
    async relocate(next) {
      await (writing ?? Promise.resolve());
      store = new HistoryStore(next);
      await store.load(); // continue after any generation already there
      where = next.where;
      await write();
    },
    async flush() {
      while (writing) await writing;
    },
    async detach() {
      unsubscribe();
      while (writing) await writing;
    },
  };
}

// The start screen's recent projects (ADR 0038): the last few project folders opened, newest
// first. The list is a per-user convenience kept in browser storage. The desktop editor
// remembers folder paths; a Chromium browser remembers folder handles (in IndexedDB, since
// handles can't be written as JSON) and asks for access again when one is reopened.
import { signal } from "@preact/signals";
import type { FsaDirectoryHandle } from "./fsaFileSystem";
import { RecentProjects, type HandleStore, type ListStore } from "./recentProjectList";

export { locationOf, type RecentProject, type RecentState } from "./recentProjectList";

let shared: RecentProjects | null = null;

/** The editor's recent projects (localStorage, plus IndexedDB for browser folder handles). */
export function recentProjects(): RecentProjects {
  return (shared ??= new RecentProjects(localListStore(), indexedDbHandleStore()));
}

/** Bumped when the list changes, so the start screen and File > Open Recent re-read it. */
export const recentVersion = signal(0);

/** The list in localStorage. */
function localListStore(key = "myco.editor.recentProjects"): ListStore {
  return {
    read: () => globalThis.localStorage?.getItem(key) ?? null,
    write: (text) => globalThis.localStorage?.setItem(key, text),
  };
}

/** Folder handles in IndexedDB (structured-cloneable there, unlike in JSON). */
function indexedDbHandleStore(dbName = "myco-editor-recent", storeName = "handles"): HandleStore | null {
  if (typeof indexedDB === "undefined") return null;
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async <T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const store = (await open()).transaction(storeName, mode).objectStore(storeName);
    return new Promise((resolve, reject) => {
      const req = op(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  // Handles stored this session are kept as they are too (reopening one needn't wait for the database).
  const live = new Map<string, FsaDirectoryHandle>();
  return {
    get: async (id) => live.get(id) ?? run("readonly", (s) => s.get(id) as IDBRequest<FsaDirectoryHandle | undefined>),
    set: async (id, handle) => {
      live.set(id, handle);
      try {
        await run("readwrite", (s) => s.put(handle, id));
      } catch (err) {
        console.warn(`[editor] couldn't keep the folder for the recent projects list after this session: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    delete: async (id) => {
      live.delete(id);
      await run("readwrite", (s) => s.delete(id));
    },
  };
}

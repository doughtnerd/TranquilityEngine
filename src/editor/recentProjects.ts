// The start screen's recent projects (ADR 0038): the last few project folders opened, newest
// first. The list is a per-user convenience kept in browser storage. The desktop editor
// remembers folder paths; a Chromium browser remembers folder handles (in IndexedDB, since
// handles can't be written as JSON) and asks for access again when one is reopened.
import type { FileSystem } from "../engine/platform/FileSystem";
import { FsaFileSystem, type FsaDirectoryHandle } from "./fsaFileSystem";
import { RecentProjects, type HandleStore, type ListStore } from "./recentProjectList";

export { locationOf, type RecentProject, type RecentState, type RemovedProject } from "./recentProjectList";

let shared: RecentProjects | null = null;

/** The editor's recent projects (localStorage, plus IndexedDB for browser folder handles). */
export function recentProjects(): RecentProjects {
  return (shared ??= new RecentProjects(localListStore(), indexedDbHandleStore()));
}

/**
 * Add an opened folder project to the recent projects (a browser folder by its handle, a desktop folder by its path),
 * as the editor and the Audio Studio do when one opens. A project in memory (no folder) is skipped; a failure is
 * warned about (as `[app]`), never thrown, so opening never fails over the list.
 */
export async function rememberProject(project: { readonly name: string; readonly fileSystem: FileSystem | null; readonly root: string | null }, app = "editor", list: RecentProjects = recentProjects()): Promise<void> {
  const fs = project.fileSystem, root = project.root;
  if (!fs || !root) return;
  try {
    if (fs instanceof FsaFileSystem) {
      const handle = await fs.directoryHandle(root);
      await list.add({ name: project.name, path: handle.name, handle });
    } else await list.add({ name: project.name, path: root });
  } catch (err) {
    console.warn(`[${app}] couldn't add ${root} to the recent projects: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The list in localStorage. Another window's writes (the desktop editor window adding the project it opened, seen
 * by the Projects window, ADR 0059) arrive as storage events.
 */
function localListStore(key = "myco.editor.recentProjects"): ListStore {
  return {
    read: () => globalThis.localStorage?.getItem(key) ?? null,
    write: (text) => globalThis.localStorage?.setItem(key, text),
    subscribe: (changed) => globalThis.addEventListener?.("storage", (e: StorageEvent) => (e.key === key || e.key === null) && changed()),
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

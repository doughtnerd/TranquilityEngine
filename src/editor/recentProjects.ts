// The start screen's recent projects (ADR 0038): the last few project folders opened, newest
// first. The list is a per-user convenience kept in browser storage. The desktop editor
// remembers folder paths; a Chromium browser remembers folder handles (in IndexedDB, since
// handles can't be written as JSON) and asks for access again when one is reopened.
import { signal } from "@preact/signals";
import type { FileSystem } from "../engine/platform/FileSystem";
import type { FsaDirectoryHandle } from "./fsaFileSystem";
import { joinPath } from "./projectPaths";

export interface RecentProject {
  id: string;
  /** The project's name when it was last opened. */
  name: string;
  /** The folder: a path on disk (desktop), or the folder's name (browser). */
  path: string;
  /** When it was last opened (ms since the epoch). */
  lastOpened: number;
  /** "path": reopened by path (desktop). "handle": reopened from a stored folder handle (browser). */
  kind: "path" | "handle";
  /**
   * Browser folders only: a note the user typed saying where the folder is (the File System
   * Access API never reveals a real path, ADR 0116), shown instead of the bare folder name.
   */
  label?: string;
}

/** What the start screen shows under a recent project's name: a browser folder's note if it has one, else its path or folder name. */
export const locationOf = (e: RecentProject): string => (e.kind === "handle" && e.label ? e.label : e.path);

/** A location note as stored: single-line, trimmed, at most 200 characters (empty: none). */
export const cleanLabel = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 200) : "");

/** What reopening a recent project would find. */
export type RecentState = "ok" | "missing" | "needs-access" | "unknown";

/** Where the list itself is kept (localStorage in the editor). */
export interface ListStore {
  read(): string | null;
  write(text: string): void;
}

/** Where browser folder handles are kept, by recent entry id (IndexedDB in the editor). */
export interface HandleStore {
  get(id: string): Promise<FsaDirectoryHandle | undefined>;
  set(id: string, handle: FsaDirectoryHandle): Promise<void>;
  delete(id: string): Promise<void>;
}

export const MAX_RECENT = 10;

const isEntry = (e: unknown): e is RecentProject => {
  const r = e as RecentProject;
  return !!r && typeof r.id === "string" && typeof r.name === "string" && typeof r.path === "string" && typeof r.lastOpened === "number" && (r.kind === "path" || r.kind === "handle") && (r.label === undefined || typeof r.label === "string");
};

let counter = 0;
const newId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class RecentProjects {
  constructor(
    private readonly store: ListStore,
    private readonly handles: HandleStore | null,
    private readonly max = MAX_RECENT,
  ) {}

  /** The recent projects, newest first. Unreadable storage reads as an empty list. */
  list(): RecentProject[] {
    try {
      const parsed = JSON.parse(this.store.read() ?? "[]") as unknown;
      return Array.isArray(parsed) ? parsed.filter(isEntry).sort((a, b) => b.lastOpened - a.lastOpened) : [];
    } catch {
      return [];
    }
  }

  /**
   * Record that a project was opened: move it to the top (matching by path, or for a browser
   * folder by handle) and drop the oldest past the limit.
   */
  async add(project: { name: string; path: string; handle?: FsaDirectoryHandle }, now = Date.now()): Promise<RecentProject> {
    const list = this.list();
    const kind = project.handle ? "handle" : "path";
    let existing: RecentProject | undefined;
    if (project.handle && this.handles) {
      for (const e of list) {
        if (e.kind !== "handle") continue;
        const h = await this.handles.get(e.id).catch(() => undefined);
        if (h && (h === project.handle || (await h.isSameEntry?.(project.handle).catch(() => false)))) {
          existing = e;
          break;
        }
      }
    } else if (!project.handle) {
      existing = list.find((e) => e.kind === "path" && samePath(e.path, project.path));
    }
    const entry: RecentProject = { id: existing?.id ?? newId(), name: project.name, path: project.path, lastOpened: now, kind, ...(existing?.label ? { label: existing.label } : {}) };
    if (project.handle) await this.handles?.set(entry.id, project.handle);
    const next = [entry, ...list.filter((e) => e.id !== entry.id)];
    for (const dropped of next.slice(this.max)) if (dropped.kind === "handle") await this.handles?.delete(dropped.id).catch(() => {});
    this.save(next.slice(0, this.max));
    return entry;
  }

  /** Set (or with empty text, clear) the location note of a browser folder's entry. */
  setLabel(id: string, label: string): void {
    const list = this.list();
    const entry = list.find((e) => e.id === id);
    if (!entry || entry.kind !== "handle") return;
    const clean = cleanLabel(label);
    if (clean) entry.label = clean;
    else delete entry.label;
    this.save(list);
  }

  /** Take a project off the list (its folder is untouched). */
  async remove(id: string): Promise<void> {
    const list = this.list();
    const entry = list.find((e) => e.id === id);
    if (!entry) return;
    this.save(list.filter((e) => e.id !== id));
    if (entry.kind === "handle") await this.handles?.delete(id).catch(() => {});
  }

  /** A browser entry's folder handle, if it's still stored. */
  async handle(id: string): Promise<FsaDirectoryHandle | undefined> {
    return this.handles?.get(id).catch(() => undefined);
  }

  /**
   * What reopening `entry` would find, without asking the user anything: "missing" when the
   * folder or its project.json is gone, "needs-access" when the browser must ask for permission
   * first, "unknown" when it can't be checked (e.g. the desktop editor's folder access lapsed).
   */
  async check(entry: RecentProject, fs: FileSystem | null): Promise<RecentState> {
    if (entry.kind === "path") {
      if (!fs?.canWrite) return "unknown";
      try {
        return (await fs.exists(joinPath(entry.path, "project.json"))) ? "ok" : "missing";
      } catch {
        return "unknown";
      }
    }
    const handle = await this.handle(entry.id);
    if (!handle) return "missing";
    try {
      if (handle.queryPermission && (await handle.queryPermission({ mode: "readwrite" })) !== "granted") return "needs-access";
      await handle.getFileHandle("project.json");
      return "ok";
    } catch (err) {
      return err instanceof Error && (err.name === "NotFoundError" || err.name === "TypeMismatchError") ? "missing" : "unknown";
    }
  }

  private save(list: RecentProject[]): void {
    try {
      this.store.write(JSON.stringify(list));
    } catch {
      // storage blocked: the list just isn't remembered
    }
  }
}

/** Paths are compared case-insensitively on Windows-style paths, and ignoring a trailing separator. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const t = p.replace(/[\\/]+$/, "");
    return /^[a-z]:[\\/]/i.test(t) || t.includes("\\") ? t.toLowerCase().replace(/\//g, "\\") : t;
  };
  return norm(a) === norm(b);
}

let shared: RecentProjects | null = null;

/** The editor's recent projects (localStorage, plus IndexedDB for browser folder handles). */
export function recentProjects(): RecentProjects {
  return (shared ??= new RecentProjects(localListStore(), indexedDbHandleStore()));
}

/** Bumped when the list changes, so the start screen and File > Open Recent re-read it. */
export const recentVersion = signal(0);

/** The list in localStorage. */
export function localListStore(key = "myco.editor.recentProjects"): ListStore {
  return {
    read: () => globalThis.localStorage?.getItem(key) ?? null,
    write: (text) => globalThis.localStorage?.setItem(key, text),
  };
}

/** Folder handles in IndexedDB (structured-cloneable there, unlike in JSON). */
export function indexedDbHandleStore(dbName = "myco-editor-recent", storeName = "handles"): HandleStore | null {
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

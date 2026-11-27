// The recent projects list (ADR 0038) over the stores it's given: newest first, a reopened project
// moved to the top, at most a few kept, browser folder handles kept beside the list. The editor's
// list (recentProjects.ts) keeps it in localStorage and IndexedDB. The list carries its own change signal
// (`version`, ADR 0318): its own writes bump it, and so do another window's writes where the store reports them.
import { signal, type ReadonlySignal } from "@preact/signals";
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

/** An entry taken off the list, with a browser folder's handle, so it can be put back (`RecentProjects.restore`). */
export interface RemovedProject {
  readonly entry: RecentProject;
  readonly handle?: FsaDirectoryHandle;
}

/** What the start screen shows under a recent project's name: a browser folder's note if it has one, else its path or folder name. */
export const locationOf = (e: RecentProject): string => (e.kind === "handle" && e.label ? e.label : e.path);

/** A location note as stored: single-line, trimmed, at most 200 characters (empty: none). */
const cleanLabel = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 200) : "");

/** What reopening a recent project would find. */
export type RecentState = "ok" | "missing" | "needs-access" | "unknown";

/** Where the list itself is kept (localStorage in the editor). */
export interface ListStore {
  read(): string | null;
  write(text: string): void;
  /** Call `changed` when something else (another window) writes the list. */
  subscribe?(changed: () => void): void;
}

/** Where browser folder handles are kept, by recent entry id (IndexedDB in the editor). */
export interface HandleStore {
  get(id: string): Promise<FsaDirectoryHandle | undefined>;
  set(id: string, handle: FsaDirectoryHandle): Promise<void>;
  delete(id: string): Promise<void>;
}

const MAX_RECENT = 10;

const isEntry = (e: unknown): e is RecentProject => {
  const r = e as RecentProject;
  return !!r && typeof r.id === "string" && typeof r.name === "string" && typeof r.path === "string" && typeof r.lastOpened === "number" && (r.kind === "path" || r.kind === "handle") && (r.label === undefined || typeof r.label === "string");
};

let counter = 0;
const newId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class RecentProjects {
  private readonly changes = signal(0);

  constructor(
    private readonly store: ListStore,
    private readonly handles: HandleStore | null,
    private readonly max = MAX_RECENT,
  ) {
    store.subscribe?.(() => this.changes.value++);
  }

  /** Changes whenever the list does (here or in another window), so views reading it re-read it. */
  get version(): ReadonlySignal<number> {
    return this.changes;
  }

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

  /**
   * Take a project off the list (its folder is untouched). Returns what was removed, which `restore` puts back (the
   * projects screen's Undo), or null when there was no such entry.
   */
  async remove(id: string): Promise<RemovedProject | null> {
    const list = this.list();
    const entry = list.find((e) => e.id === id);
    if (!entry) return null;
    const handle = entry.kind === "handle" ? await this.handle(id) : undefined;
    this.save(list.filter((e) => e.id !== id));
    if (entry.kind === "handle") await this.handles?.delete(id).catch(() => {});
    return { entry, ...(handle ? { handle } : {}) };
  }

  /**
   * Put back an entry `remove` took off, where its last opening places it. Nothing changes when the project is on the
   * list again already (reopened meanwhile); past the limit the oldest falls off as usual.
   */
  async restore(removed: RemovedProject): Promise<void> {
    const { entry, handle } = removed;
    const list = this.list();
    if (list.some((e) => e.id === entry.id || (entry.kind === "path" && e.kind === "path" && samePath(e.path, entry.path)))) return;
    if (entry.kind === "handle" && handle) await this.handles?.set(entry.id, handle);
    const next = [...list, entry].sort((a, b) => b.lastOpened - a.lastOpened);
    for (const dropped of next.slice(this.max)) if (dropped.kind === "handle") await this.handles?.delete(dropped.id).catch(() => {});
    this.save(next.slice(0, this.max));
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
    this.changes.value++;
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

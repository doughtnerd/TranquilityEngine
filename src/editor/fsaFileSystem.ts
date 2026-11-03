// A writable FileSystem over the File System Access API, for the editor in Chromium browsers
// (ADR 0038). The user picks a folder with `showDirectoryPicker()`; the folder's handle is
// "mounted" under a path like `/MyGame`, and every FileSystem call on a path inside it walks the
// handles. Safari and Firefox don't have `showDirectoryPicker`, so they keep read-only samples.
import type { DirEntry, FileSystem } from "../engine/platform/FileSystem";

// The handle types this needs, structurally (the DOM lib's are incomplete: no async iteration,
// no permissions), so tests can pass in-memory fakes.
export interface FsaWritable {
  write(data: string | Uint8Array | Blob): Promise<void>;
  close(): Promise<void>;
}
export interface FsaFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<Blob & { readonly lastModified: number }>;
  createWritable(): Promise<FsaWritable>;
}
export interface FsaDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsaDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsaFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterable<FsaDirectoryHandle | FsaFileHandle>;
  isSameEntry?(other: FsaDirectoryHandle): Promise<boolean>;
  queryPermission?(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

type Picker = (options?: { mode?: "read" | "readwrite"; id?: string; startIn?: string }) => Promise<FsaDirectoryHandle>;

/** True when the browser can open folders for writing (Chromium's File System Access API). */
export function fsaSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

/** Ask for read and write access to a folder handle (stored handles start with "prompt" after a restart). Needs a user gesture to prompt. */
export async function ensureWritable(handle: FsaDirectoryHandle): Promise<boolean> {
  const mode = { mode: "readwrite" as const };
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission(mode)) === "granted") return true;
  return (await handle.requestPermission?.(mode)) === "granted";
}

const isNotFound = (err: unknown) => err instanceof Error && (err.name === "NotFoundError" || err.name === "TypeMismatchError");

/** The polling interval for `watch` (there are no change events for local folders). */
export const WATCH_INTERVAL_MS = 1000;

export class FsaFileSystem implements FileSystem {
  readonly canWrite = true;
  private readonly mounts = new Map<string, FsaDirectoryHandle>();

  constructor(private readonly picker: Picker | null = fsaSupported() ? ((o) => (window as unknown as { showDirectoryPicker: Picker }).showDirectoryPicker(o)) : null) {}

  /** Make `handle` reachable as a path (reusing the path if it's already mounted) and return that path. */
  async mount(handle: FsaDirectoryHandle): Promise<string> {
    for (const [path, h] of this.mounts) if (h === handle || (await h.isSameEntry?.(handle))) return path;
    const base = `/${handle.name.replace(/[\\/]/g, "_") || "folder"}`;
    let path = base;
    for (let n = 2; this.mounts.has(path); n++) path = `${base} (${n})`;
    this.mounts.set(path, handle);
    return path;
  }

  /** The directory handle for a folder path (to remember it, e.g. in the recent projects list). */
  async directoryHandle(path: string): Promise<FsaDirectoryHandle> {
    const { root, parts } = this.resolve(path);
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    return dir;
  }

  async readText(path: string): Promise<string> {
    return (await (await this.file(path)).getFile()).text();
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return new Uint8Array(await (await (await this.file(path)).getFile()).arrayBuffer());
  }

  async writeText(path: string, text: string): Promise<void> {
    await this.write(path, text);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    await this.write(path, data);
  }

  async list(path: string): Promise<DirEntry[]> {
    const dir = await this.directoryHandle(path);
    const out: DirEntry[] = [];
    for await (const entry of dir.values()) out.push({ name: entry.name, isDirectory: entry.kind === "directory" });
    return out;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.entry(path);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async mkdir(path: string): Promise<void> {
    const { root, parts } = this.resolve(path);
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    const { parent, name } = await this.parentOf(path);
    await parent.removeEntry(name, { recursive: options?.recursive ?? false });
  }

  /** Copy, then delete the original: the API has no portable move for local folders. */
  async rename(from: string, to: string): Promise<void> {
    if (await this.exists(to)) throw new Error(`"${to}" already exists.`);
    const source = await this.entry(from);
    await this.copy(source, to);
    await this.remove(from, { recursive: true });
  }

  async pickFolder(_title?: string): Promise<string | null> {
    if (!this.picker) return null;
    try {
      return await this.mount(await this.picker({ mode: "readwrite", id: "myco-projects" }));
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return null; // cancelled
      throw err;
    }
  }

  /**
   * Poll folder `path` for changes (files added, removed, resized or modified) every
   * `WATCH_INTERVAL_MS`, since local folders send no change events.
   */
  async watch(path: string, onChange: (paths: string[]) => void, intervalMs = WATCH_INTERVAL_MS): Promise<() => void> {
    let previous = await this.snapshot(path).catch(() => new Map<string, string>());
    let stopped = false;
    let busy = false;
    const timer = setInterval(() => {
      if (busy || stopped) return;
      busy = true;
      void this.snapshot(path)
        .catch(() => new Map<string, string>())
        .then((next) => {
          if (stopped) return;
          const changed = [...next].filter(([p, stamp]) => previous.get(p) !== stamp).map(([p]) => p);
          for (const p of previous.keys()) if (!next.has(p)) changed.push(p);
          previous = next;
          if (changed.length > 0) onChange(changed);
        })
        .finally(() => (busy = false));
    }, intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  // --- internals -------------------------------------------------------------------------------

  /** Every file under `path` (full paths) with its size and modification time. */
  private async snapshot(path: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const walk = async (dir: FsaDirectoryHandle, at: string) => {
      for await (const entry of dir.values()) {
        const p = `${at}/${entry.name}`;
        if (entry.kind === "directory") await walk(entry, p);
        else {
          const f = await entry.getFile();
          out.set(p, `${f.size}:${f.lastModified}`);
        }
      }
    };
    await walk(await this.directoryHandle(path), path.replace(/[\\/]+$/, ""));
    return out;
  }

  private resolve(path: string): { root: FsaDirectoryHandle; parts: string[] } {
    const norm = path.replace(/\\/g, "/");
    for (const [mount, handle] of this.mounts) {
      if (norm === mount || norm.startsWith(`${mount}/`)) {
        const parts = norm.slice(mount.length).split("/").filter((p) => p !== "" && p !== ".");
        if (parts.includes("..")) throw new Error(`"${path}" leaves the folder it's in.`);
        return { root: handle, parts };
      }
    }
    const err = new Error(`"${path}" isn't in a folder opened in this browser tab. Open the project folder again.`);
    err.name = "NotFoundError";
    throw err;
  }

  private async parentOf(path: string): Promise<{ parent: FsaDirectoryHandle; name: string }> {
    const { root, parts } = this.resolve(path);
    const name = parts.pop();
    if (name === undefined) throw new Error(`Can't change the opened folder itself ("${path}").`);
    let parent = root;
    for (const part of parts) parent = await parent.getDirectoryHandle(part);
    return { parent, name };
  }

  private async entry(path: string): Promise<FsaDirectoryHandle | FsaFileHandle> {
    const { root, parts } = this.resolve(path);
    if (parts.length === 0) return root;
    const name = parts.pop()!;
    let parent = root;
    for (const part of parts) parent = await parent.getDirectoryHandle(part);
    try {
      return await parent.getFileHandle(name);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      return parent.getDirectoryHandle(name);
    }
  }

  private async file(path: string): Promise<FsaFileHandle> {
    const { parent, name } = await this.parentOf(path);
    return parent.getFileHandle(name);
  }

  /** Write a file, creating missing parent folders. `createWritable` writes to a swap file and replaces the original on close. */
  private async write(path: string, data: string | Uint8Array): Promise<void> {
    const { root, parts } = this.resolve(path);
    const name = parts.pop();
    if (name === undefined) throw new Error(`"${path}" is a folder.`);
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await writable.write(data);
    await writable.close();
  }

  private async copy(source: FsaDirectoryHandle | FsaFileHandle, to: string): Promise<void> {
    if (source.kind === "file") {
      await this.write(to, new Uint8Array(await (await source.getFile()).arrayBuffer()));
      return;
    }
    await this.mkdir(to);
    for await (const entry of source.values()) await this.copy(entry, `${to}/${entry.name}`);
  }
}

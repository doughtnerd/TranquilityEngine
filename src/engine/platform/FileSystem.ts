/**
 * File access for the editor and tooling (ADR 0003, 0026). Internal: not exported from the
 * engine's public API, and game code never uses it (games use Storage, ADR 0024).
 *
 * Under Tauri, files go through the fs and dialog plugins (`TauriFileSystem`). In a plain
 * browser only reads work, by fetching URLs from the dev server; writes, directory listing and
 * the folder dialog throw `UnsupportedError`.
 */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface FileSystem {
  /** True when writes, listing and the folder dialog are available. */
  readonly canWrite: boolean;
  readText(path: string): Promise<string>;
  /** Write via a temporary file in the same folder, then rename it over `path`. */
  writeText(path: string, text: string): Promise<void>;
  readBinary(path: string): Promise<Uint8Array>;
  /** Atomic like `writeText`. */
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  list(path: string): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;
  /** Create the folder and any missing parents. */
  mkdir(path: string): Promise<void>;
  /** Delete a file, or a folder (`recursive` for one that isn't empty). */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Rename or move a file or folder. Fails if `to` exists. */
  rename(from: string, to: string): Promise<void>;
  /** Native folder picker. Returns the chosen path, or null if cancelled. */
  pickFolder(title?: string): Promise<string | null>;
  /**
   * Call `onChange` with the paths that changed in folder `path` (at any depth), batched a
   * moment after the changes. Returns a function that stops watching. Desktop only.
   */
  watch?(path: string, onChange: (paths: string[]) => void): Promise<() => void>;
  /** Open a file or folder with the system's default app (for a script: its code editor). Desktop only. */
  openExternally?(path: string): Promise<void>;
  /** Show a file or folder in the system's file manager (Explorer, Finder). Desktop only. */
  reveal?(path: string): Promise<void>;
}

export class UnsupportedError extends Error {
  constructor(operation: string) {
    super(`FileSystem.${operation} is not available in the browser; run the editor under Tauri.`);
    this.name = "UnsupportedError";
  }
}

/** True when running inside a Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Read-only file access over HTTP, for the editor in a plain browser. */
export class BrowserFileSystem implements FileSystem {
  readonly canWrite = false;

  async readText(path: string): Promise<string> {
    return (await this.fetch(path)).text();
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.fetch(path)).arrayBuffer());
  }

  async exists(path: string): Promise<boolean> {
    const res = await fetch(path, { method: "HEAD" });
    return res.ok;
  }

  writeText(): Promise<void> { return Promise.reject(new UnsupportedError("writeText")); }
  writeBinary(): Promise<void> { return Promise.reject(new UnsupportedError("writeBinary")); }
  list(): Promise<DirEntry[]> { return Promise.reject(new UnsupportedError("list")); }
  mkdir(): Promise<void> { return Promise.reject(new UnsupportedError("mkdir")); }
  remove(): Promise<void> { return Promise.reject(new UnsupportedError("remove")); }
  rename(): Promise<void> { return Promise.reject(new UnsupportedError("rename")); }
  pickFolder(): Promise<string | null> { return Promise.reject(new UnsupportedError("pickFolder")); }

  private async fetch(path: string): Promise<Response> {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Failed to read "${path}": HTTP ${res.status}`);
    return res;
  }
}

let instance: FileSystem | null = null;

/** The file system for the current platform: Tauri when available, read-only browser otherwise. */
export async function getFileSystem(): Promise<FileSystem> {
  if (!instance) {
    if (isTauri()) {
      const { TauriFileSystem } = await import("./TauriFileSystem");
      instance = new TauriFileSystem();
    } else {
      instance = new BrowserFileSystem();
    }
  }
  return instance;
}

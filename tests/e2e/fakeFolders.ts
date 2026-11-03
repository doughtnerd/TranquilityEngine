import type { Page } from "@playwright/test";

// Playwright can't drive the native folder picker, so these specs replace `showDirectoryPicker`
// with in-memory File System Access handles (ADR 0038). `window.fakeFolders` lets a test queue the
// folder the next pick returns and read or change what the editor wrote.

/** Seed folders: name → files (path → text). */
export type FolderSeed = Record<string, Record<string, string>>;

export interface FakeFolders {
  /** The folder the next `showDirectoryPicker()` returns (made empty if it doesn't exist); null cancels. */
  next(name: string | null): void;
  /** A file's text, by `folder/path`, or undefined. */
  read(path: string): string | undefined;
  /** Every file path under a folder (sorted), including hidden ones. */
  list(folder: string): string[];
  /** Delete a file or folder by `folder/path`. */
  remove(path: string): void;
  /** How many times the picker was shown. */
  picks: number;
}

/** Install the fake picker before the editor loads, with `seed` folders. */
export async function installFakeFolders(page: Page, seed: FolderSeed = {}): Promise<void> {
  await page.addInitScript((seedFolders: FolderSeed) => {
    let clock = 1;
    const err = (name: string, message: string) => Object.assign(new Error(message), { name });
    class FileHandle {
      readonly kind = "file";
      data = new Uint8Array();
      modified = clock++;
      constructor(readonly name: string) {}
      async getFile() {
        return Object.assign(new Blob([this.data as BlobPart]), { lastModified: this.modified });
      }
      async createWritable() {
        const chunks: Uint8Array[] = [];
        return {
          write: async (d: string | Uint8Array | Blob) => {
            chunks.push(typeof d === "string" ? new TextEncoder().encode(d) : d instanceof Uint8Array ? d : new Uint8Array(await d.arrayBuffer()));
          },
          close: async () => {
            const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
            let at = 0;
            for (const c of chunks) {
              out.set(c, at);
              at += c.length;
            }
            this.data = out;
            this.modified = clock++;
          },
        };
      }
    }
    class DirHandle {
      readonly kind = "directory";
      entries = new Map<string, DirHandle | FileHandle>();
      constructor(readonly name: string) {}
      async getDirectoryHandle(name: string, o?: { create?: boolean }) {
        const e = this.entries.get(name);
        if (e instanceof DirHandle) return e;
        if (e) throw err("TypeMismatchError", `${name} is a file`);
        if (!o?.create) throw err("NotFoundError", `${name} not found`);
        const d = new DirHandle(name);
        this.entries.set(name, d);
        return d;
      }
      async getFileHandle(name: string, o?: { create?: boolean }) {
        const e = this.entries.get(name);
        if (e instanceof FileHandle) return e;
        if (e) throw err("TypeMismatchError", `${name} is a folder`);
        if (!o?.create) throw err("NotFoundError", `${name} not found`);
        const f = new FileHandle(name);
        this.entries.set(name, f);
        return f;
      }
      async removeEntry(name: string, o?: { recursive?: boolean }) {
        const e = this.entries.get(name);
        if (!e) throw err("NotFoundError", `${name} not found`);
        if (e instanceof DirHandle && e.entries.size > 0 && !o?.recursive) throw err("InvalidModificationError", `${name} isn't empty`);
        this.entries.delete(name);
      }
      async *values() {
        yield* [...this.entries.values()];
      }
      async isSameEntry(other: unknown) {
        return other === this;
      }
      async queryPermission() {
        return "granted";
      }
      async requestPermission() {
        return "granted";
      }
    }
    const roots = new Map<string, DirHandle>();
    const walk = (path: string, create: boolean): { dir: DirHandle; name: string } | null => {
      const parts = path.split("/");
      const root = roots.get(parts.shift()!);
      if (!root) return null;
      let dir: DirHandle = root;
      const name = parts.pop()!;
      for (const p of parts) {
        let next: DirHandle | FileHandle | undefined = dir.entries.get(p);
        if (!(next instanceof DirHandle)) {
          if (!create) return null;
          dir.entries.set(p, (next = new DirHandle(p)));
        }
        dir = next;
      }
      return { dir, name };
    };
    for (const [folder, files] of Object.entries(seedFolders)) {
      roots.set(folder, new DirHandle(folder));
      for (const [path, text] of Object.entries(files)) {
        const at = walk(`${folder}/${path}`, true)!;
        const f = new FileHandle(at.name);
        f.data = new TextEncoder().encode(text);
        at.dir.entries.set(at.name, f);
      }
    }
    let queued: string | null | undefined;
    const fake = {
      picks: 0,
      next(name: string | null) {
        queued = name;
      },
      read(path: string) {
        const at = walk(path, false);
        const f = at?.dir.entries.get(at.name);
        return f instanceof FileHandle ? new TextDecoder().decode(f.data) : undefined;
      },
      list(folder: string) {
        const out: string[] = [];
        const go = (dir: DirHandle, at: string) => {
          for (const [name, e] of dir.entries) {
            if (e instanceof DirHandle) go(e, `${at}${name}/`);
            else out.push(`${at}${name}`);
          }
        };
        const root = roots.get(folder);
        if (root) go(root, "");
        return out.sort();
      },
      remove(path: string) {
        const at = walk(path, false);
        at?.dir.entries.delete(at.name);
      },
    };
    Object.assign(window, {
      fakeFolders: fake,
      showDirectoryPicker: async () => {
        fake.picks++;
        const name = queued;
        queued = undefined;
        if (name === null || name === undefined) throw err("AbortError", "The user aborted a request.");
        if (!roots.has(name)) roots.set(name, new DirHandle(name));
        return roots.get(name)!;
      },
    });
  }, seed);
}

/** Make the editor look like Safari or Firefox: no folder picker. */
export async function removeFolderPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    delete (Window.prototype as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
}

type Win = { fakeFolders: FakeFolders };

/** Queue the folder the next pick returns (null: the user cancels). */
export const nextFolder = (page: Page, name: string | null) => page.evaluate((n) => (window as unknown as Win).fakeFolders.next(n), name);
/** A file's text by `folder/path`. */
export const readFile = (page: Page, path: string) => page.evaluate((p) => (window as unknown as Win).fakeFolders.read(p), path);
/** Every file under a folder. */
export const listFolder = (page: Page, folder: string) => page.evaluate((f) => (window as unknown as Win).fakeFolders.list(f), folder);
/** Delete a file or folder by `folder/path`, as if outside the editor. */
export const removeFile = (page: Page, path: string) => page.evaluate((p) => (window as unknown as Win).fakeFolders.remove(p), path);

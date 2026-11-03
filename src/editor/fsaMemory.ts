// In-memory File System Access handles, for tests of the browser folder file system (ADR 0038).
import type { FsaDirectoryHandle, FsaFileHandle, FsaWritable } from "./fsaFileSystem";

const notFound = (name: string) => Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
const mismatch = (name: string) => Object.assign(new Error(`${name} is the wrong kind`), { name: "TypeMismatchError" });

let clock = 1;

export class MemoryFileHandle implements FsaFileHandle {
  readonly kind = "file";
  data: Uint8Array = new Uint8Array();
  modified = clock++;
  constructor(readonly name: string) {}
  async getFile() {
    const blob = new Blob([this.data as BlobPart]);
    return Object.assign(blob, { lastModified: this.modified });
  }
  async createWritable(): Promise<FsaWritable> {
    const chunks: Uint8Array[] = [];
    return {
      write: async (d) => void chunks.push(typeof d === "string" ? new TextEncoder().encode(d) : d instanceof Uint8Array ? d : new Uint8Array(await d.arrayBuffer())),
      close: async () => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) (out.set(c, at), (at += c.length));
        this.data = out;
        this.modified = clock++;
      },
    };
  }
  /** The file's text (test convenience). */
  get text(): string {
    return new TextDecoder().decode(this.data);
  }
}

export class MemoryDirectoryHandle implements FsaDirectoryHandle {
  readonly kind = "directory";
  readonly entries = new Map<string, MemoryDirectoryHandle | MemoryFileHandle>();
  permission: PermissionState = "granted";
  /** What `requestPermission` answers (the user's choice). */
  grant: PermissionState = "granted";
  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const e = this.entries.get(name);
    if (e instanceof MemoryDirectoryHandle) return e;
    if (e) throw mismatch(name);
    if (!options?.create) throw notFound(name);
    const dir = new MemoryDirectoryHandle(name);
    this.entries.set(name, dir);
    return dir;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    const e = this.entries.get(name);
    if (e instanceof MemoryFileHandle) return e;
    if (e) throw mismatch(name);
    if (!options?.create) throw notFound(name);
    const file = new MemoryFileHandle(name);
    this.entries.set(name, file);
    return file;
  }
  async removeEntry(name: string, options?: { recursive?: boolean }) {
    const e = this.entries.get(name);
    if (!e) throw notFound(name);
    if (e instanceof MemoryDirectoryHandle && e.entries.size > 0 && !options?.recursive) throw Object.assign(new Error(`${name} isn't empty`), { name: "InvalidModificationError" });
    this.entries.delete(name);
  }
  async *values() {
    yield* [...this.entries.values()];
  }
  async isSameEntry(other: FsaDirectoryHandle) {
    return other === this;
  }
  async queryPermission() {
    return this.permission;
  }
  async requestPermission() {
    this.permission = this.grant;
    return this.permission;
  }

  /** The text of the file at a `/`-separated path below this folder, or undefined (test convenience). */
  read(path: string): string | undefined {
    const parts = path.split("/");
    let dir: MemoryDirectoryHandle = this;
    for (const part of parts.slice(0, -1)) {
      const next = dir.entries.get(part);
      if (!(next instanceof MemoryDirectoryHandle)) return undefined;
      dir = next;
    }
    const file = dir.entries.get(parts.at(-1)!);
    return file instanceof MemoryFileHandle ? file.text : undefined;
  }

  /** Write a text file at a `/`-separated path, making folders (test convenience). */
  put(path: string, text: string): this {
    const parts = path.split("/");
    let dir: MemoryDirectoryHandle = this;
    for (const part of parts.slice(0, -1)) {
      let next = dir.entries.get(part);
      if (!(next instanceof MemoryDirectoryHandle)) dir.entries.set(part, (next = new MemoryDirectoryHandle(part)));
      dir = next;
    }
    const file = new MemoryFileHandle(parts.at(-1)!);
    file.data = new TextEncoder().encode(text);
    dir.entries.set(file.name, file);
    return this;
  }
}

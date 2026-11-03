import type { FileSystem } from "./FileSystem";
import type { StorageBackend, StorageNamespace, StorageValue } from "./Storage";

/**
 * Storage backend for Tauri builds (ADR 0024): one file per key under the app's data folder,
 * `<appDataDir>/<namespace>/<key>.json` (or `.bin` for ArrayBuffer/Uint8Array values), written
 * atomically. Keys are URI-encoded so any string makes a safe file name.
 */
export class TauriStorage implements StorageBackend {
  private readonly ready = new Map<StorageNamespace, Promise<void>>();

  constructor(private readonly fs: FileSystem, private readonly root: string) {}

  /** Storage rooted at the app's data folder (from the Tauri path API). */
  static async create(fs: FileSystem): Promise<TauriStorage> {
    const { appDataDir } = await import("@tauri-apps/api/path");
    return new TauriStorage(fs, await appDataDir());
  }

  async save(ns: StorageNamespace, key: string, value: StorageValue): Promise<void> {
    await this.ensureDir(ns);
    const binary = toBytes(value);
    if (binary) {
      await this.fs.writeBinary(this.file(ns, key, "bin"), binary);
      await this.removeIfExists(this.file(ns, key, "json"));
    } else {
      await this.fs.writeText(this.file(ns, key, "json"), JSON.stringify(value));
      await this.removeIfExists(this.file(ns, key, "bin"));
    }
  }

  async load(ns: StorageNamespace, key: string): Promise<StorageValue | undefined> {
    const json = this.file(ns, key, "json");
    if (await this.fs.exists(json)) return JSON.parse(await this.fs.readText(json));
    const bin = this.file(ns, key, "bin");
    if (await this.fs.exists(bin)) {
      const bytes = await this.fs.readBinary(bin);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    return undefined;
  }

  async delete(ns: StorageNamespace, key: string): Promise<void> {
    await this.removeIfExists(this.file(ns, key, "json"));
    await this.removeIfExists(this.file(ns, key, "bin"));
  }

  async list(ns: StorageNamespace): Promise<string[]> {
    const dir = this.dir(ns);
    if (!(await this.fs.exists(dir))) return [];
    const keys = new Set<string>();
    for (const e of await this.fs.list(dir)) {
      const m = !e.isDirectory && /^(.*)\.(json|bin)$/.exec(e.name);
      if (m) keys.add(decodeURIComponent(m[1]));
    }
    return [...keys];
  }

  private dir(ns: StorageNamespace): string {
    return `${this.root.replace(/[\\/]+$/, "")}/${ns}`;
  }

  private file(ns: StorageNamespace, key: string, ext: "json" | "bin"): string {
    return `${this.dir(ns)}/${encodeURIComponent(key)}.${ext}`;
  }

  private ensureDir(ns: StorageNamespace): Promise<void> {
    let p = this.ready.get(ns);
    if (!p) {
      p = this.fs.mkdir(this.dir(ns));
      this.ready.set(ns, p);
      p.catch(() => this.ready.delete(ns));
    }
    return p;
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.fs.exists(path)) await this.fs.remove(path);
  }
}

function toBytes(value: StorageValue): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  return null;
}

// An in-memory FileSystem, for tests and the end-to-end test project (session.ts).
import type { DirEntry, FileSystem } from "../engine/platform/FileSystem";

/** An in-memory FileSystem with Windows-style paths, like Tauri's on Windows. */
export class MemoryFileSystem implements FileSystem {
  readonly canWrite = true;
  readonly files = new Map<string, string | Uint8Array>();
  readonly writes: string[] = [];
  private key = (p: string) => p.replace(/\//g, "\\");
  async readText(p: string) {
    const v = this.files.get(this.key(p));
    if (typeof v !== "string") throw new Error(`no text file ${p}`);
    return v;
  }
  async writeText(p: string, text: string) {
    this.writes.push(this.key(p));
    this.files.set(this.key(p), text);
  }
  async readBinary(p: string) {
    const v = this.files.get(this.key(p));
    if (!(v instanceof Uint8Array)) throw new Error(`no binary file ${p}`);
    return v;
  }
  async writeBinary(p: string, data: Uint8Array) {
    this.files.set(this.key(p), data);
  }
  async list(dir: string): Promise<DirEntry[]> {
    if (this.files.has(this.key(dir))) throw new Error(`${dir} is not a directory`); // as Tauri's readDir
    const prefix = this.key(dir).replace(/\\$/, "") + "\\";
    const names = new Map<string, boolean>();
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length).split("\\");
      names.set(rest[0], rest.length > 1 || names.get(rest[0]) === true);
    }
    for (const k of this.folders) if (k.startsWith(prefix)) names.set(k.slice(prefix.length).split("\\")[0], true);
    return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async exists(p: string) {
    const k = this.key(p);
    const folder = k.replace(/\\$/, "") + "\\";
    return this.files.has(k) || this.folders.has(k) || [...this.files.keys()].some((f) => f.startsWith(folder)); // a file, or a folder
  }
  readonly folders = new Set<string>();
  async mkdir(p: string) {
    this.folders.add(this.key(p));
  }
  async remove(p: string, options?: { recursive?: boolean }) {
    const k = this.key(p), inside = k.replace(/\\$/, "") + "\\";
    const children = [...this.files.keys()].filter((f) => f.startsWith(inside));
    if (children.length > 0 && !options?.recursive) throw new Error(`${p} isn't empty`);
    for (const f of children) this.files.delete(f);
    for (const f of [...this.folders]) if (f === k || f.startsWith(inside)) this.folders.delete(f);
    this.files.delete(k);
  }
  async rename(from: string, to: string) {
    const f = this.key(from), t = this.key(to);
    if (await this.exists(to)) throw new Error(`"${to}" already exists.`);
    if (this.files.has(f)) {
      this.files.set(t, this.files.get(f)!);
      this.files.delete(f);
      return;
    }
    const inside = f + "\\";
    for (const [k, v] of [...this.files]) {
      if (!k.startsWith(inside)) continue;
      this.files.set(t + k.slice(f.length), v);
      this.files.delete(k);
    }
    for (const k of [...this.folders]) {
      if (k !== f && !k.startsWith(inside)) continue;
      this.folders.add(t + k.slice(f.length));
      this.folders.delete(k);
    }
  }
  async pickFolder() {
    return null;
  }
}

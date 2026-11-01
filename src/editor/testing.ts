// Test helpers for editor tests (not part of the editor build).
import type { DirEntry, FileSystem } from "../engine/platform/FileSystem";
import { joinPath } from "./projects";

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
    const prefix = this.key(dir).replace(/\\$/, "") + "\\";
    const names = new Map<string, boolean>();
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length).split("\\");
      names.set(rest[0], rest.length > 1 || names.get(rest[0]) === true);
    }
    return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async exists(p: string) {
    const k = this.key(p);
    const folder = k.replace(/\\$/, "") + "\\";
    return this.files.has(k) || [...this.files.keys()].some((f) => f.startsWith(folder)); // a file, or a folder holding files
  }
  async mkdir() {}
  async remove(p: string) {
    this.files.delete(this.key(p));
  }
  async pickFolder() {
    return null;
  }
}

export const ROOT = "C:\\Games\\flappy";
export const raw = import.meta.glob("../demo/flappy/**/*.json", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

export function demoFolder(): MemoryFileSystem {
  const fs = new MemoryFileSystem();
  for (const [key, text] of Object.entries(raw)) fs.files.set(joinPath(ROOT, key.slice("../demo/flappy/".length)), text);
  for (const img of ["PipeDown.png", "PipeUp.png", "background.png", "flappyBird.png", "flower.jpg", "ground.jpg", "moderncraft.png"]) {
    fs.files.set(joinPath(ROOT, `images/${img}`), new Uint8Array([137, 80, 78, 71]));
  }
  for (const mp3 of ["foo.mp3", "town.mp3"]) fs.files.set(joinPath(ROOT, `music/${mp3}`), new Uint8Array([1, 2, 3]));
  fs.files.set(joinPath(ROOT, "behaviors/Bird.ts"), "// not an asset");
  fs.files.set(joinPath(ROOT, "node_modules/pkg/package.json"), "{}");
  fs.files.set(joinPath(ROOT, ".git/config.json"), "{}");
  return fs;
}


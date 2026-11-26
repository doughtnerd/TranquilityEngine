// Editor projects (ADR 0026): where scenes, prefabs and assets come from, and where saves go.
// - A project folder on disk, opened through the platform FileSystem (Tauri): read and write.
// - A read-only project from files in memory: a sample served beside the editor (ADR 0031).
//
// A project's own scripts (`scripts/**/*.ts`, ADR 0030) are read here and loaded by the session
// (scriptLoader.ts). No game code is compiled into the editor.
import { Assets, type AssetSource, type ProjectSettingsInput } from "../engine";
import { acquireProjectContext, type ProjectContext } from "../engine/core/projectContext";
import type { FileSystem } from "../engine/platform/FileSystem";
import { isSidecarPath, sidecarPath } from "../engine/scene/importSettings";
import { isProjectFile, loadProjectFiles, projectFileKind, skipsFolder, textFileValue } from "../engine/scene/projectFiles";
import { isScriptPath, isTextAsset, joinPath } from "./projectPaths";
import { isUISourcePath } from "../projectCode/uiModules";
import { readOnlyMessage } from "./readOnly";
import { migrateLegacyAudio, settingsWithAudio } from "./audioProjectFile";
import { AUDIO_PROJECT_FILE } from "../engine/audio/project/types";

export { isTextAsset, joinPath };

export interface EditorProject {
  /** Shown in the toolbar. */
  readonly name: string;
  /** The folder on disk, or null for a read-only project in memory (a sample). */
  readonly root: string | null;
  /** The sample's id when this is a sample opened read-only (ADR 0031), so another app can open the same one (ADR 0380); else null. */
  readonly sample: string | null;
  /** The folder's file system (for watching scripts and opening files externally), or null for a project in memory. */
  readonly fileSystem: FileSystem | null;
  readonly canSave: boolean;
  /**
   * The parsed `project.json` (empty if there's none), with `audio` set to `audio.json`'s runtime view (ADR 0344). Follows
   * writes to both, so play mode uses the current bootstrap and mix.
   */
  readonly settings: ProjectSettingsInput;
  /** Every project file by path relative to the project root, as its asset value (ADR 0254): parsed JSON, a text file's text, a URL otherwise. */
  readonly assets: AssetSource;
  /** Asset paths, sorted. Grows when new files are written. */
  readonly files: readonly string[];
  /** The scene to open first, if any. */
  readonly mainScene: string | null;
  /** The project's scripts (the `.ts` files under `scripts/`): source text by project-relative path. */
  readonly scripts: ReadonlyMap<string, string>;
  /** Read the scripts from disk again (they may have been edited elsewhere). */
  rereadScripts(): Promise<void>;
  /** Write a script and update `scripts`. */
  writeScript(path: string, text: string): Promise<void>;
  /** The text a JSON file had when last read or written (keeps its layout on save). */
  textOf(path: string): string | undefined;
  /** Write a JSON file and update what the project serves for it. */
  writeText(path: string, text: string): Promise<void>;
  /** Write a text asset (JSON, which must parse, or JavaScript) and update what the project serves for it. */
  writeFile(path: string, text: string): Promise<void>;
  /**
   * Write a binary asset (a baked navigation chunk, ADR 0065) and serve its new bytes: the project's
   * URL for it changes, so loaders see the new file.
   */
  writeBinary(path: string, bytes: Uint8Array): Promise<void>;
  /** Delete a file (an asset or a script) from disk and from the project, with its import settings sidecar (ADR 0040). */
  deleteFile(path: string): Promise<void>;
  /** Every folder (project-relative, sorted), empty ones included. */
  readonly folders: readonly string[];
  /** A file's size in bytes, if known. */
  sizeOf(path: string): number | undefined;
  /** Create a folder on disk (and its parents). */
  createFolder(path: string): Promise<void>;
  /** Rename or move a file or folder (with everything in it) on disk and in the project. A file takes its sidecar along. */
  move(from: string, to: string): Promise<void>;
  /** Copy a file to `to` (which mustn't exist), with a copy of its sidecar. */
  copyFile(from: string, to: string): Promise<void>;
  /** Delete a folder and everything in it from disk and from the project. */
  deleteFolder(path: string): Promise<void>;
  /**
   * Files changed on disk by someone else (another app, a code editor, git; ADR 0341): read `paths` (project-relative
   * files or folders) again and serve what they hold now, adding new files and dropping deleted ones, and tell
   * `Assets.onChanged` listeners. What this project wrote itself reads as unchanged. Does nothing for a project in
   * memory. Resolves to what changed.
   */
  rereadFiles(paths: readonly string[]): Promise<FileChanges>;
  /**
   * `from` (a file or folder) was moved to `to` on disk by someone else (ADR 0341, pending moves): follow it as `move`
   * does after its rename (a file's sidecar along), then read what is at `to`. Doesn't touch the disk.
   */
  followMove(from: string, to: string): Promise<void>;
}

/** What `rereadFiles` found: project-relative files whose content changed, that appeared, and that are gone. */
export interface FileChanges {
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/** A cheap fingerprint of a binary file's bytes (FNV-1a and the length), to tell a file this project wrote from a changed one. */
function bytesStamp(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return `${bytes.length}:${(h >>> 0).toString(36)}`;
}

/** True if `path` is `folder` or inside it. */
export const isWithin = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * The project's UI code with its text (ADR 0419): Svelte components and rune modules, which the project code
 * linker compiles like scripts, and the `.css` files components may import.
 */
export function uiFiles(project: EditorProject): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of project.files) {
    const text = isUISourcePath(path) || path.endsWith(".css") ? project.textOf(path) : undefined;
    if (text !== undefined) out.set(path, text);
  }
  return out;
}

/** The project's JSON files with their text (scripts can import them, ADR 0030). */

export function jsonFiles(project: EditorProject): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of project.files) {
    const text = path.endsWith(".json") ? project.textOf(path) : undefined;
    if (text !== undefined) out.set(path, text);
  }
  return out;
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4",
  obj: "model/obj", mtl: "model/mtl", fbx: "application/octet-stream", gltf: "model/gltf+json", glb: "model/gltf-binary", ktx2: "image/ktx2",
  hdr: "application/octet-stream", exr: "application/octet-stream", cube: "text/plain", env: "application/octet-stream", dds: "application/octet-stream", bin: "application/octet-stream",
  woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf",
};

export const isScenePath = (path: string) => /\.(scene|prefab)\.json$/.test(path);

/** An object URL serving a binary asset's bytes. */
const blobUrl = (path: string, bytes: Uint8Array) =>
  URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream" }));

const textBytes = (text: string) => new TextEncoder().encode(text).length;

/** The first scene to open: `scenes/main.scene.json`, else the first scene file. */
export function pickMainScene(files: readonly string[]): string | null {
  if (files.includes("scenes/main.scene.json")) return "scenes/main.scene.json";
  return files.find((f) => f.endsWith(".scene.json")) ?? null;
}

class MapProject implements EditorProject {
  readonly mainScene: string | null;
  readonly assets: AssetSource;
  private sortedFiles: string[] | null = null;
  /** The bytes this project last wrote or re-read for a binary file (`bytesStamp`), so `rereadFiles` knows them. */
  private readonly binaryStamps = new Map<string, string>();
  sample: string | null = null;

  constructor(
    private readonly baseName: string,
    readonly root: string | null,
    private readonly values: Map<string, unknown>,
    private readonly texts: Map<string, string>,
    private readonly write: ((path: string, text: string) => Promise<void>) | null,
    private readonly scriptFiles: { read: () => Promise<Map<string, string>> } | null = null,
    readonly fileSystem: FileSystem | null = null,
    private scriptMap: Map<string, string> = new Map(),
    private readonly folderSet: Set<string> = new Set(),
    private readonly sizes: Map<string, number> = new Map(),
    /** Name the project after `project.json`'s `name` (following edits to it), with `baseName` as the fallback. */
    private readonly namedBySettings = false,
  ) {
    this.mainScene = pickMainScene(this.files);
    this.assets = { has: (p) => values.has(p), get: (p) => values.get(p), paths: () => values.keys() }; // listed: Locale finds string tables (ADR 0356)
  }

  get name(): string {
    const named = this.namedBySettings ? (this.settings as { name?: unknown }).name : undefined;
    return typeof named === "string" && named.trim() !== "" ? named : this.baseName;
  }

  /** Asset paths, sorted. Includes files written since the project opened. */
  get files(): readonly string[] {
    return (this.sortedFiles ??= [...this.values.keys()].sort());
  }

  private settingsView: { project: unknown; audio: unknown; view: ProjectSettingsInput } | null = null;

  /**
   * Read from `project.json` each time, so it reflects edits saved since the project opened, with `audio` from
   * `audio.json` (ADR 0344: its runtime view). The same object until either file changes.
   */
  get settings(): ProjectSettingsInput {
    const project = this.values.get("project.json"), audio = this.values.get(AUDIO_PROJECT_FILE);
    const cached = this.settingsView;
    if (cached && cached.project === project && cached.audio === audio) return cached.view;
    const view = settingsWithAudio(project, audio);
    this.settingsView = { project, audio, view };
    return view;
  }

  get canSave(): boolean {
    return this.write !== null;
  }

  textOf(path: string): string | undefined {
    return this.texts.get(path);
  }

  get scripts(): ReadonlyMap<string, string> {
    return this.scriptMap;
  }

  async rereadScripts(): Promise<void> {
    if (this.scriptFiles) this.scriptMap = await this.scriptFiles.read();
  }

  async writeScript(path: string, text: string): Promise<void> {
    if (!this.write) throw new Error(readOnlyMessage(this, "save"));
    if (!isScriptPath(path)) throw new Error(`${path} isn't a script: scripts are .ts files under scripts/ (or a plugin's folder under plugins/).`);
    await this.write(path, text);
    this.scriptMap = new Map(this.scriptMap).set(path, text);
  }

  async writeText(path: string, text: string): Promise<void> {
    if (!this.write) throw new Error(readOnlyMessage(this, "save"));
    const value = JSON.parse(text);
    await this.write(path, text);
    if (!this.values.has(path)) this.sortedFiles = null;
    this.texts.set(path, text);
    this.values.set(path, value);
    Assets.notifyChanged(path);
  }

  async writeFile(path: string, text: string): Promise<void> {
    if (path.toLowerCase().endsWith(".json")) {
      try {
        JSON.parse(text);
      } catch (err) {
        throw new Error(`${path} isn't valid JSON, so it wasn't saved: ${err instanceof Error ? err.message : String(err)}`);
      }
      return this.writeText(path, text);
    }
    if (!this.write) throw new Error(readOnlyMessage(this, "save"));
    // A file that loads as a URL (ADR 0254), such as a `.cube` LUT written as text, is served from its bytes.
    if (projectFileKind(path) === "url") return this.writeBinary(path, new TextEncoder().encode(text));
    await this.write(path, text);
    if (!this.values.has(path)) this.sortedFiles = null;
    this.texts.set(path, text);
    this.values.set(path, textFileValue(path, text));
    Assets.notifyChanged(path);
  }

  async writeBinary(path: string, bytes: Uint8Array): Promise<void> {
    const { fs, root } = this.disk();
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (folder && !(await fs.exists(joinPath(root, folder)))) await fs.mkdir(joinPath(root, folder));
    await fs.writeBinary(joinPath(root, path), bytes);
    const old = this.values.get(path);
    if (typeof old === "string" && old.startsWith("blob:")) URL.revokeObjectURL(old);
    if (!this.values.has(path)) this.sortedFiles = null;
    this.texts.delete(path);
    this.values.set(path, blobUrl(path, bytes));
    this.sizes.set(path, bytes.length);
    this.binaryStamps.set(path, bytesStamp(bytes));
    Assets.notifyChanged(path);
  }

  async rereadFiles(paths: readonly string[]): Promise<FileChanges> {
    const out = { changed: [] as string[], added: [] as string[], removed: [] as string[] };
    if (!this.write || !this.fileSystem || !this.root) return out;
    const fs = this.fileSystem, root = this.root;
    const files = new Set<string>();
    for (const path of paths) {
      if (path === "" || !isProjectFile(path)) continue;
      if (!(await fs.exists(joinPath(root, path)).catch(() => false))) {
        for (const known of [...this.values.keys()]) {
          if (!isWithin(known, path)) continue;
          this.forget(known);
          out.removed.push(known);
          Assets.notifyChanged(known);
        }
        for (const f of [...this.folderSet]) if (isWithin(f, path)) this.folderSet.delete(f);
        continue;
      }
      if (this.values.has(path)) {
        files.add(path);
        continue;
      }
      // Not a file this project knows: a folder (read everything in it) or a new file (listing a file fails).
      let folder = this.folders.includes(path);
      if (!folder) folder = await fs.list(joinPath(root, path)).then(() => true, () => false);
      if (!folder) {
        files.add(path);
        continue;
      }
      const found = new Set<string>();
      const inside = await listFiles(fs, root, path, isProjectFile, found).catch(() => [] as string[]);
      for (const f of [path, ...found]) this.folderSet.add(f);
      for (const f of inside) files.add(f);
    }
    for (const path of files) {
      const known = this.values.has(path);
      const changed = await this.reread(fs, root, path).catch((err: unknown) => {
        console.warn(`[editor] couldn't read ${path} again: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      });
      if (!changed) continue;
      if (!known) this.sortedFiles = null;
      (known ? out.changed : out.added).push(path);
      Assets.notifyChanged(path);
    }
    return out;
  }

  /** Read one file again; true if what the project serves for it changed. */
  private async reread(fs: FileSystem, root: string, path: string): Promise<boolean> {
    const kind = projectFileKind(path);
    if (kind === "url") {
      const bytes = await fs.readBinary(joinPath(root, path));
      const stamp = bytesStamp(bytes);
      if (this.values.has(path) && this.binaryStamps.get(path) === stamp) return false;
      const old = this.values.get(path);
      if (typeof old === "string" && old.startsWith("blob:")) URL.revokeObjectURL(old);
      this.texts.delete(path);
      this.values.set(path, blobUrl(path, bytes));
      this.sizes.set(path, bytes.length);
      this.binaryStamps.set(path, stamp);
      return true;
    }
    const before = this.texts.get(path);
    const text = await fs.readText(joinPath(root, path));
    // This project wrote the file meanwhile: that write is what it holds (its own event follows).
    if (this.texts.get(path) !== before) return false;
    if (text === before && this.values.has(path)) return false;
    let value: unknown;
    if (kind === "json") {
      try {
        value = JSON.parse(text);
      } catch (err) {
        // Half-written, or broken by hand: keep serving what it held, as opening the project skips it.
        console.warn(`[editor] ${path} changed on disk but isn't valid JSON (${err instanceof Error ? err.message : String(err)}); keeping what it held`);
        return false;
      }
    } else value = textFileValue(path, text);
    this.texts.set(path, text);
    this.values.set(path, value);
    return true;
  }

  async followMove(from: string, to: string): Promise<void> {
    if (!this.write || from === to) return;
    const known = this.values.has(from) || this.scriptMap.has(from) || this.folders.includes(from);
    if (known) {
      const meta = sidecarPath(from), toMeta = sidecarPath(to);
      const isFile = this.values.has(from);
      this.rekeyMoved(from, to);
      // A file's sidecar went with it (the other app moved it as `move` does).
      if (isFile && !isSidecarPath(from) && this.values.has(meta)) this.rekeyMoved(meta, toMeta);
    }
    await this.rereadFiles([to]);
  }

  async deleteFile(path: string): Promise<void> {
    const { fs, root } = this.disk();
    await fs.remove(joinPath(root, path));
    this.forget(path);
    // Its import settings go with it (ADR 0040).
    const meta = sidecarPath(path);
    if (!isSidecarPath(path) && this.values.has(meta)) {
      await fs.remove(joinPath(root, meta));
      this.forget(meta);
    }
  }

  get folders(): readonly string[] {
    const all = new Set(this.folderSet);
    for (const file of [...this.values.keys(), ...this.scriptMap.keys()]) {
      for (let i = file.indexOf("/"); i >= 0; i = file.indexOf("/", i + 1)) all.add(file.slice(0, i));
    }
    return [...all].sort();
  }

  sizeOf(path: string): number | undefined {
    const text = this.scriptMap.get(path) ?? this.texts.get(path);
    return text !== undefined ? textBytes(text) : this.sizes.get(path);
  }

  async createFolder(path: string): Promise<void> {
    const { fs, root } = this.disk();
    await fs.mkdir(joinPath(root, path));
    this.folderSet.add(path);
  }

  async move(from: string, to: string): Promise<void> {
    const { fs, root } = this.disk();
    await fs.rename(joinPath(root, from), joinPath(root, to));
    this.rekeyMoved(from, to);
    // A file's import settings go with it (ADR 0040). A sidecar already at the new name belongs
    // to no file (that name was free), so it's replaced rather than adopted.
    const meta = sidecarPath(from), toMeta = sidecarPath(to);
    if (isSidecarPath(from) || !this.values.has(to)) return;
    if (this.values.has(toMeta)) {
      await fs.remove(joinPath(root, toMeta));
      this.forget(toMeta);
    }
    if (this.values.has(meta)) {
      await fs.rename(joinPath(root, meta), joinPath(root, toMeta));
      this.rekeyMoved(meta, toMeta);
    }
  }

  /** Update the project's maps after `from` moved to `to` on disk. */
  private rekeyMoved(from: string, to: string): void {
    const rename = (p: string) => (isWithin(p, from) ? to + p.slice(from.length) : p);
    const rekey = <T>(map: Map<string, T>) => {
      for (const [p, v] of [...map]) {
        if (!isWithin(p, from)) continue;
        map.delete(p);
        map.set(rename(p), v);
      }
    };
    rekey(this.values);
    rekey(this.texts);
    rekey(this.sizes);
    rekey(this.binaryStamps);
    const scripts = new Map(this.scriptMap);
    rekey(scripts);
    this.scriptMap = scripts;
    for (const f of [...this.folderSet]) {
      if (!isWithin(f, from)) continue;
      this.folderSet.delete(f);
      this.folderSet.add(rename(f));
    }
    if (!this.values.has(to) && !this.scriptMap.has(to)) this.folderSet.add(to); // a folder (perhaps empty)
    this.sortedFiles = null;
  }

  async copyFile(from: string, to: string): Promise<void> {
    await this.copyOne(from, to);
    // A copy gets a copy of the import settings (ADR 0040), replacing a stray sidecar at its name.
    const meta = sidecarPath(from), toMeta = sidecarPath(to);
    if (isSidecarPath(from) || !this.values.has(meta)) return;
    if (this.values.has(toMeta)) await this.deleteFile(toMeta);
    await this.copyOne(meta, toMeta);
  }

  private async copyOne(from: string, to: string): Promise<void> {
    const { fs, root } = this.disk();
    if (this.values.has(to) || this.scriptMap.has(to) || (await fs.exists(joinPath(root, to)))) throw new Error(`"${to}" already exists.`);
    const script = this.scriptMap.get(from);
    if (script !== undefined) return this.writeScript(to, script);
    const text = this.texts.get(from);
    if (text !== undefined) return this.writeFile(to, text);
    const bytes = await fs.readBinary(joinPath(root, from));
    await fs.writeBinary(joinPath(root, to), bytes);
    this.values.set(to, blobUrl(to, bytes));
    this.sizes.set(to, bytes.length);
    this.binaryStamps.set(to, bytesStamp(bytes));
    this.sortedFiles = null;
  }

  async deleteFolder(path: string): Promise<void> {
    const { fs, root } = this.disk();
    await fs.remove(joinPath(root, path), { recursive: true });
    for (const p of [...this.values.keys(), ...this.scriptMap.keys()]) if (isWithin(p, path)) this.forget(p);
    for (const f of [...this.folderSet]) if (isWithin(f, path)) this.folderSet.delete(f);
  }

  /** The folder's file system, or an error for read-only projects. */
  private disk(): { fs: FileSystem; root: string } {
    if (!this.write || !this.fileSystem || !this.root) throw new Error(`${this.name} is read-only.`);
    return { fs: this.fileSystem, root: this.root };
  }

  /** Drop a deleted file from the project. */
  private forget(path: string): void {
    const value = this.values.get(path);
    if (typeof value === "string" && value.startsWith("blob:")) URL.revokeObjectURL(value);
    if (this.values.delete(path)) this.sortedFiles = null;
    this.texts.delete(path);
    this.sizes.delete(path);
    this.binaryStamps.delete(path);
    if (this.scriptMap.has(path)) {
      this.scriptMap = new Map(this.scriptMap);
      this.scriptMap.delete(path);
    }
  }
}

/**
 * A read-only project from files in memory: `values` by project path (asset values, ADR 0254:
 * parsed JSON, text, or a URL), `texts` (the JSON and text files' text), `scripts` and, where
 * known, file `sizes`.
 */
export function readOnlyProject(
  name: string,
  files: { values: Map<string, unknown>; texts: Map<string, string>; scripts?: Map<string, string>; sizes?: Map<string, number> },
  sample: string | null = null,
): EditorProject {
  const project = new MapProject(name, null, files.values, files.texts, null, null, null, files.scripts ?? new Map(), new Set(), files.sizes ?? new Map());
  project.sample = sample;
  return project;
}

/** Every file under `root` that `accept` takes, as project-relative paths. Skips hidden, dependency and build folders (ADR 0254). */
async function listFiles(fs: FileSystem, root: string, dir: string, accept: (path: string) => boolean, folders?: Set<string>): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.list(dir ? joinPath(root, dir) : root)) {
    if (entry.name.startsWith(".")) continue; // hidden files and folders (the editor's .myco/)
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      if (skipsFolder(entry.name)) continue;
      folders?.add(path);
      out.push(...(await listFiles(fs, root, path, accept, folders)));
    } else if (accept(path)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Open a project folder: it must contain `project.json`. Loads every project file up front as its
 * asset value (ADR 0254: JSON parsed, text files' text, the rest as object URLs), since scene
 * loading looks assets up synchronously. With `readOnly` nothing is written, not even a migration, and the project
 * can't be saved (the Audio Studio opens a project whose old audio events weren't migrated this way, ADR 0343).
 */
export async function openFolderProject(fs: FileSystem, root: string, options: { readOnly?: boolean } = {}): Promise<EditorProject> {
  if (!(await fs.exists(joinPath(root, "project.json")))) {
    throw new Error(`"${root}" isn't a Myco Engine project: it has no project.json.`);
  }
  // ADR 0344: an `audio` section still in project.json moves to audio.json before anything reads the files.
  if (!options.readOnly) await migrateLegacyAudio(fs, root);
  const folders = new Set<string>();
  const sizes = new Map<string, number>();
  const { values, texts, problems } = await loadProjectFiles(await listFiles(fs, root, "", isProjectFile, folders), {
    readText: (path) => fs.readText(joinPath(root, path)),
    url: async (path) => {
      const bytes = await fs.readBinary(joinPath(root, path));
      sizes.set(path, bytes.length);
      return blobUrl(path, bytes);
    },
  });
  for (const p of problems) console.warn(`[editor] skipping ${p.path}: not valid JSON (${p.message})`);
  const readScripts = async () => {
    const scripts = new Map<string, string>();
    // Scripts, and project plugins' sources, which compile like scripts (ADR 0139).
    for (const folder of ["scripts", "plugins"]) {
      if (!(await fs.exists(joinPath(root, folder)))) continue;
      for (const path of await listFiles(fs, root, folder, isScriptPath)) scripts.set(path, await fs.readText(joinPath(root, path)));
    }
    return scripts;
  };
  const folder = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
  const write = options.readOnly ? null : (path: string, text: string) => fs.writeText(joinPath(root, path), text);
  return new MapProject(folder, root, values, texts, write, { read: readScripts }, options.readOnly ? null : fs, await readScripts(), folders, sizes, true);
}

const takesFolderProjects = new WeakSet<EditorProject>();

/** The files a takes folder workspace loads: takes, their notes, and Profiler captures. */
const isTakesFolderFile = (path: string): boolean => {
  const lower = path.toLowerCase();
  return lower.endsWith(".sporesample") || lower.endsWith(".sporesample.notes.json");
};

/**
 * ADR 0408: open a folder of take files as a takes workspace, with no `project.json` (the Audio Studio's Take and
 * Profiler without a project). The folder is made if it's missing. It loads only takes, their notes and captures; its
 * settings are empty, so it serves no audio. Named after the folder.
 */
export async function openTakesFolder(fs: FileSystem, root: string): Promise<EditorProject> {
  if (!(await fs.exists(root))) await fs.mkdir(root);
  const folders = new Set<string>();
  const sizes = new Map<string, number>();
  const { values, texts } = await loadProjectFiles(await listFiles(fs, root, "", isTakesFolderFile, folders), {
    readText: (path) => fs.readText(joinPath(root, path)),
    url: async (path) => {
      const bytes = await fs.readBinary(joinPath(root, path));
      sizes.set(path, bytes.length);
      return blobUrl(path, bytes);
    },
  });
  const folder = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
  const project = new MapProject(folder, root, values, texts, (path, text) => fs.writeText(joinPath(root, path), text), null, fs, new Map(), folders, sizes);
  takesFolderProjects.add(project);
  return project;
}

/** True when `project` is a takes folder workspace (`openTakesFolder`), not a Myco project. */
export const isTakesFolder = (project: EditorProject | null | undefined): boolean => !!project && takesFolderProjects.has(project);

/** Settings for the Editor World: the project's, minus autoloads, with the editor's background. */
export function editorSettings(project: EditorProject): ProjectSettingsInput {
  const s = project.settings;
  return { ...s, autoload: [], display: { ...s.display, backgroundColor: "#24272d" } };
}

/** The open project's context (ADR 0319): its asset source, replaced when another project opens. */
let projectContext: ProjectContext | null = null;

/** Register a project's assets as the editor's project source, releasing the previous project's (ADR 0319). */
export function useProjectAssets(project: EditorProject): void {
  projectContext?.release();
  projectContext = acquireProjectContext({ assets: project.assets });
}

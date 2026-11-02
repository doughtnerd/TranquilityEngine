// Editor projects (ADR 0026): where scenes, prefabs and assets come from, and where saves go.
// - The bundled Flappy demo: always available, read-only (works in a plain browser).
// - A project folder on disk, opened through the platform FileSystem (Tauri): read and write.
//
// A folder project's own scripts (`scripts/**/*.ts`, ADR 0030) are read here and loaded by the
// session (scriptLoader.ts). The demo's script types are compiled into the editor, so the
// bundled demo (which works in a plain browser) needs no loading.
import { Assets, type AssetSource, type ProjectSettingsInput } from "../engine";
import type { FileSystem } from "../engine/platform/FileSystem";
import "../demo/flappy/game"; // registers the demo's behaviors, data components and systems
import { isScriptPath } from "./scriptLoader";

export interface EditorProject {
  /** Shown in the toolbar. */
  readonly name: string;
  /** The folder on disk, or null for the bundled demo. */
  readonly root: string | null;
  /** The folder's file system (for watching scripts and opening files externally), or null for the bundled demo. */
  readonly fileSystem: FileSystem | null;
  readonly canSave: boolean;
  readonly settings: ProjectSettingsInput;
  /** Every asset by path relative to the project root: parsed JSON for `.json`, a URL otherwise. */
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
  /** Delete a file (an asset or a script) from disk and from the project. */
  deleteFile(path: string): Promise<void>;
  /** Every folder (project-relative, sorted), empty ones included. */
  readonly folders: readonly string[];
  /** A file's size in bytes, if known (the bundled demo's binary assets aren't). */
  sizeOf(path: string): number | undefined;
  /** Create a folder on disk (and its parents). */
  createFolder(path: string): Promise<void>;
  /** Rename or move a file or folder (with everything in it) on disk and in the project. */
  move(from: string, to: string): Promise<void>;
  /** Copy a file to `to` (which mustn't exist). */
  copyFile(from: string, to: string): Promise<void>;
  /** Delete a folder and everything in it from disk and from the project. */
  deleteFolder(path: string): Promise<void>;
}

/** True if `path` is `folder` or inside it. */
export const isWithin = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

const ASSET_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|mp3|ogg|wav|json|js)$/i;

/** The project's JSON files with their text (scripts can import them, ADR 0030). */
export function jsonFiles(project: EditorProject): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of project.files) {
    const text = path.endsWith(".json") ? project.textOf(path) : undefined;
    if (text !== undefined) out.set(path, text);
  }
  return out;
}

/** Files the project keeps as text (and the Code panel can edit): JSON, and plain JavaScript (edit only). */
export const isTextAsset = (path: string) => /\.(json|js)$/i.test(path);
const SKIP_DIRS = new Set(["node_modules", "dist", "target", "test-results", "playwright-report"]);
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
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

  constructor(
    readonly name: string,
    readonly root: string | null,
    readonly settings: ProjectSettingsInput,
    private readonly values: Map<string, unknown>,
    private readonly texts: Map<string, string>,
    private readonly write: ((path: string, text: string) => Promise<void>) | null,
    private readonly scriptFiles: { read: () => Promise<Map<string, string>> } | null = null,
    readonly fileSystem: FileSystem | null = null,
    private scriptMap: Map<string, string> = new Map(),
    private readonly folderSet: Set<string> = new Set(),
    private readonly sizes: Map<string, number> = new Map(),
  ) {
    this.mainScene = pickMainScene(this.files);
    this.assets = { has: (p) => values.has(p), get: (p) => values.get(p) };
  }

  /** Asset paths, sorted. Includes files written since the project opened. */
  get files(): readonly string[] {
    return (this.sortedFiles ??= [...this.values.keys()].sort());
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
    if (!this.write) throw new Error(`${this.name} is read-only. Open a project folder to save.`);
    if (!isScriptPath(path)) throw new Error(`${path} isn't a script: scripts are .ts files under scripts/.`);
    await this.write(path, text);
    this.scriptMap = new Map(this.scriptMap).set(path, text);
  }

  async writeText(path: string, text: string): Promise<void> {
    if (!this.write) throw new Error(`${this.name} is read-only. Open a project folder to save.`);
    const value = JSON.parse(text);
    await this.write(path, text);
    if (!this.values.has(path)) this.sortedFiles = null;
    this.texts.set(path, text);
    this.values.set(path, value);
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
    if (!this.write) throw new Error(`${this.name} is read-only. Open a project folder to save.`);
    await this.write(path, text);
    if (!this.values.has(path)) this.sortedFiles = null;
    this.texts.set(path, text);
    this.values.set(path, text);
  }

  async deleteFile(path: string): Promise<void> {
    const { fs, root } = this.disk();
    await fs.remove(joinPath(root, path));
    this.forget(path);
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
    if (this.scriptMap.has(path)) {
      this.scriptMap = new Map(this.scriptMap);
      this.scriptMap.delete(path);
    }
  }
}

/** The Flappy demo, bundled into the editor. Read-only. */
export function bundledDemoProject(): EditorProject {
  const ROOT = "../demo/flappy/";
  const rel = (key: string) => key.slice(ROOT.length);
  const values = new Map<string, unknown>();
  const texts = new Map<string, string>();
  const binaries = import.meta.glob("../demo/flappy/**/*.{png,jpg,jpeg,mp3}", { eager: true, import: "default" });
  const raw = import.meta.glob("../demo/flappy/**/*.json", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
  for (const [key, url] of Object.entries(binaries)) values.set(rel(key), url);
  for (const [key, text] of Object.entries(raw)) {
    texts.set(rel(key), text);
    values.set(rel(key), JSON.parse(text));
  }
  const settings = (values.get("project.json") ?? {}) as ProjectSettingsInput;
  return new MapProject("Flappy demo (read-only)", null, settings, values, texts, null);
}

/** Join a project-relative path onto a folder path, using the folder's separator. */
export function joinPath(root: string, path: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + path.split("/").join(sep);
}

/** Every asset file under `root` (or the files `accept` takes), as project-relative paths. Skips hidden and build folders. */
export async function listAssetFiles(
  fs: FileSystem,
  root: string,
  dir = "",
  accept: (path: string) => boolean = (p) => ASSET_EXTENSIONS.test(p),
  folders?: Set<string>,
): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.list(dir ? joinPath(root, dir) : root)) {
    if (entry.name.startsWith(".")) continue;
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      folders?.add(path);
      out.push(...(await listAssetFiles(fs, root, path, accept, folders)));
    } else if (accept(path)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Open a project folder: it must contain `project.json`. Reads every JSON file and turns binary
 * assets into object URLs up front, since scene loading looks assets up synchronously.
 */
export async function openFolderProject(fs: FileSystem, root: string): Promise<EditorProject> {
  if (!(await fs.exists(joinPath(root, "project.json")))) {
    throw new Error(`"${root}" isn't a TranquilityEngine project: it has no project.json.`);
  }
  const values = new Map<string, unknown>();
  const texts = new Map<string, string>();
  const folders = new Set<string>();
  const sizes = new Map<string, number>();
  for (const path of await listAssetFiles(fs, root, "", undefined, folders)) {
    if (path.endsWith(".json")) {
      const text = await fs.readText(joinPath(root, path));
      try {
        values.set(path, JSON.parse(text));
        texts.set(path, text);
      } catch (err) {
        console.warn(`[editor] skipping ${path}: not valid JSON (${String(err)})`);
      }
    } else if (isTextAsset(path)) {
      const text = await fs.readText(joinPath(root, path));
      values.set(path, text);
      texts.set(path, text);
    } else {
      const bytes = await fs.readBinary(joinPath(root, path));
      values.set(path, blobUrl(path, bytes));
      sizes.set(path, bytes.length);
    }
  }
  const readScripts = async () => {
    const scripts = new Map<string, string>();
    if (await fs.exists(joinPath(root, "scripts"))) {
      for (const path of await listAssetFiles(fs, root, "scripts", isScriptPath)) scripts.set(path, await fs.readText(joinPath(root, path)));
    }
    return scripts;
  };
  const settings = (values.get("project.json") ?? {}) as ProjectSettingsInput & { name?: string };
  const folder = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
  const write = (path: string, text: string) => fs.writeText(joinPath(root, path), text);
  return new MapProject(settings.name ?? folder, root, settings, values, texts, write, { read: readScripts }, fs, await readScripts(), folders, sizes);
}

/** Settings for the Editor World: the project's, minus autoloads, with the editor's background. */
export function editorSettings(project: EditorProject): ProjectSettingsInput {
  const s = project.settings;
  return { ...s, autoload: [], display: { ...s.display, backgroundColor: "#24272d" } };
}

/** Register a project's assets as the only asset source. */
export function useProjectAssets(project: EditorProject): void {
  Assets.clearSources();
  Assets.addSource(project.assets);
}

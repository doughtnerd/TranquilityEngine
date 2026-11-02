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
}

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
    if (!this.write || !this.fileSystem || !this.root) throw new Error(`${this.name} is read-only.`);
    await this.fileSystem.remove(joinPath(this.root, path));
    const value = this.values.get(path);
    if (typeof value === "string" && value.startsWith("blob:")) URL.revokeObjectURL(value);
    if (this.values.delete(path)) this.sortedFiles = null;
    this.texts.delete(path);
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
export async function listAssetFiles(fs: FileSystem, root: string, dir = "", accept: (path: string) => boolean = (p) => ASSET_EXTENSIONS.test(p)): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.list(dir ? joinPath(root, dir) : root)) {
    if (entry.name.startsWith(".")) continue;
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...(await listAssetFiles(fs, root, path, accept)));
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
  for (const path of await listAssetFiles(fs, root)) {
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
      const type = MIME[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
      values.set(path, URL.createObjectURL(new Blob([bytes as BlobPart], { type })));
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
  return new MapProject(settings.name ?? folder, root, settings, values, texts, (path, text) => fs.writeText(joinPath(root, path), text), { read: readScripts }, fs, await readScripts());
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

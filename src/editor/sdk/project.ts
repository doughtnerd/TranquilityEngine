// The editor SDK's project and assets surfaces (ADR 0147): the open project, its change version,
// paths, creating a file, and what a path is, so a plugin's editor half never reads the shell's signals (state.ts) itself.
// Reading `editor.project.current` or `editor.project.version` inside a component, `computed` or `effect`
// tracks it, as reading the signal would.
import type { ImportSettings } from "../../engine/scene/importSettings";
import { readImportSettings, showAsset } from "../assetImport";
import { assetKind, type AssetKind } from "../assetKindLookup";
import { freePath } from "../freePath";
import { openScript } from "../code/codeState";
import { fileName, folderOf, listedFiles } from "../assetBrowser";
import { joinPath } from "../projectPaths";
import { isScenePath, type EditorProject } from "../projects";
import { currentProject, docVersion } from "../state";
import { messages } from "./messages";

export type { AssetKind, EditorProject };

/** What `project.createFile` writes: a new file in `folder`, named `name` or the first free "<base> 2", "<base> 3"… */
export interface CreateFileOptions {
  folder: string;
  name: string;
  /** What the file is, plural, for the read-only message: "materials", "skies". */
  what: string;
  /** Write the file's first contents at `path` (throws on failure). */
  write(project: EditorProject, path: string): Promise<void>;
  /** The status message once it's written (default "Created <file name>."). */
  created?(path: string): string;
}

export interface ProjectSurface {
  /** The open project, or null before one opens. Tracks. */
  readonly current: EditorProject | null;
  /** `current` without tracking (in event handlers and async code that must not subscribe). */
  peek(): EditorProject | null;
  /**
   * Bumped whenever the open scene or a project file changes. Read it in a component or `computed`
   * that shows project files or the scene, so it re-renders. Tracks.
   */
  readonly version: number;
  /** `version` without tracking (a cache key computed inside a draw callback). */
  peekVersion(): number;
  /** Say that files or the open scene changed, so everything reading `version` re-renders. */
  changed(): void;
  /** True (after an info message naming `what`, plural) when the project is read-only (a sample). */
  refuseReadOnly(project: EditorProject, what: string): boolean;
  /**
   * Create a file: refuses in a read-only project, picks a free name, writes it, reports success
   * or the error in the status bar and bumps `version`. Returns its path, or null when nothing was
   * written (no project, read-only, or the write failed).
   */
  createFile(options: CreateFileOptions): Promise<string | null>;
  /** A free project path in `folder` for `name`: the name, else "<base> 2"…; with `copy`, "<base> copy"… */
  freePath(project: EditorProject, folder: string, name: string, copy?: boolean): string;
  /** A project path on disk: `root` joined with the project-relative `path`, in the root's separator style. */
  joinPath(root: string, path: string): string;
}

export const project: ProjectSurface = {
  get current() {
    return currentProject.value;
  },
  peek: () => currentProject.peek(),
  get version() {
    return docVersion.value;
  },
  peekVersion: () => docVersion.peek(),
  changed() {
    docVersion.value++;
  },
  refuseReadOnly(p, what) {
    if (p.canSave) return false;
    messages.info(`${p.name} is read-only. Open a project folder (or copy the sample) to add ${what}.`);
    return true;
  },
  async createFile(options) {
    const p = currentProject.peek();
    if (!p || project.refuseReadOnly(p, options.what)) return null;
    const path = freePath(p, options.folder, options.name);
    try {
      await options.write(p, path);
    } catch (err) {
      messages.failed(`Couldn't create ${path}`, err);
      return null;
    }
    project.changed();
    messages.info(options.created ? options.created(path) : `Created ${fileName(path)}.`);
    return path;
  },
  freePath,
  joinPath,
};

/** An asset's import settings as its sidecar holds them (defaults when it has none). */
export interface AssetImportSettings {
  settings: ImportSettings;
  /** Whether the sidecar exists. */
  exists: boolean;
  /** What's wrong with it (bad values read as the defaults). */
  problems: string[];
}

export interface AssetsSurface {
  /** The registered asset kind of `path` (ADR 0134), "other" when none claims it. */
  kindOf(path: string): AssetKind;
  /** The last segment of a project path: `images/bird.png` → `bird.png`. */
  fileName(path: string): string;
  /** The folder of a project path: `images/bird.png` → `images`, `project.json` → `""`. */
  folderOf(path: string): string;
  /** The files the Assets panel lists (import-settings sidecars left out). */
  listed(files: readonly string[]): string[];
  /** True for a scene or prefab file. */
  isScene(path: string): boolean;
  /** An asset's import settings (ADR 0040). */
  importSettings(project: EditorProject, path: string): AssetImportSettings;
  /** Reveal `path` in the Assets panel, select it and show it in the Inspector. */
  reveal(path: string): void;
  /** Open a script in the Code panel, optionally at a 1-based line and column. */
  openScript(path: string, at?: { line: number; column: number }): void;
}

export const assets: AssetsSurface = {
  kindOf: assetKind,
  fileName,
  folderOf,
  listed: listedFiles,
  isScene: isScenePath,
  importSettings: readImportSettings,
  reveal: showAsset,
  openScript,
};

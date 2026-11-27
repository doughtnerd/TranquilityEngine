// The editor side of importing Tiled and LDtk files (ADR 0436): reading a source and the files it names from the open
// project, planning what the native writer would write (and what that overwrites), and writing it in one batch. The
// Import dialog drives it; it loads with the dialog, so the parsers and `fast-xml-parser` stay out of the editor's
// first bundle.
import { projectFileKind } from "../../../../engine/scene/projectFiles";
import { parseImportSettings, sidecarAsset, isSidecarPath } from "../../../../engine/scene/importSettings";
import { editor, type EditorProject } from "../../../../editor/sdk";
import { parseLdtkProject } from "./ldtk";
import { parseTiledMap, parseTiledTileset } from "./tiled";
import { writeNative, type ImportSource, type NativeFile, type NativeImportOptions } from "./nativeWriter";
import { dirOf } from "./shared";

/** A file's text from the project: a JSON or text file's as loaded, else read from disk, else fetched from its URL. */
export async function readProjectText(project: EditorProject, path: string): Promise<string | null> {
  const text = project.textOf(path);
  if (text !== undefined) return text;
  if (project.fileSystem && project.root) {
    try {
      return await project.fileSystem.readText(editor.project.joinPath(project.root, path));
    } catch {
      // Not on disk under that name: try what the project serves.
    }
  }
  if (!project.assets.has(path)) return null;
  const value = project.assets.get(path);
  if (typeof value !== "string") return null;
  if (projectFileKind(path) !== "url") return value;
  try {
    const res = await fetch(value);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** Which parser reads a file, by extension; null for a file the importer doesn't read. */
export function importFormatOf(path: string): "tiledMap" | "tiledTileset" | "ldtk" | null {
  const p = path.toLowerCase();
  if (p.endsWith(".tmx") || p.endsWith(".tmj")) return "tiledMap";
  if (p.endsWith(".tsx") || p.endsWith(".tsj")) return "tiledTileset";
  if (p.endsWith(".ldtk")) return "ldtk";
  return null;
}

/** Parse the source file at `path` (and the files it names) from the project. Throws with a message for the dialog. */
export async function loadImportSource(project: EditorProject, path: string): Promise<ImportSource> {
  const format = importFormatOf(path);
  if (!format) throw new Error(`${path} isn't a Tiled map or tileset, or an LDtk project.`);
  const text = await readProjectText(project, path);
  if (text === null) throw new Error(`Couldn't read ${path}.`);
  const read = (p: string) => readProjectText(project, p);
  if (format === "tiledMap") return parseTiledMap(text, path, read);
  if (format === "tiledTileset") return parseTiledTileset(text, path, read);
  return parseLdtkProject(text, path, read);
}

/** What an import would write. */
export interface ImportPlan {
  files: NativeFile[];
  warnings: string[];
  /** Generated files that are already there (tilesets, prefabs): re-importing overwrites them, keeping uuids and ids. */
  overwrites: string[];
  /** Image sidecars that gain slices (merged, never replaced). */
  sidecars: string[];
}

/** Why `folder` can't hold the output, or null. */
export function whyNotOutputFolder(folder: string): string | null {
  const f = folder.trim();
  if (f.startsWith("/") || /^[A-Za-z]:/.test(f) || f.split("/").some((s) => s === ".." || s === ".")) return "The output folder must be a folder inside the project, such as levels/forest.";
  if (/[\\:*?"<>|#]/.test(f)) return "The output folder's name can't contain \\ : * ? \" < > | or #.";
  return null;
}

/** The files `source` makes with `options` in the open project, with what they overwrite. */
export function planImport(project: EditorProject, source: ImportSource, options: NativeImportOptions): ImportPlan {
  const { files, warnings } = writeNative(source, { ...options, folder: options.folder.trim().replace(/^\/+|\/+$/g, "") }, (p) => project.textOf(p) ?? null);
  const existing = new Set(project.files);
  return {
    files,
    warnings,
    overwrites: files.filter((f) => !isSidecarPath(f.path) && existing.has(f.path)).map((f) => f.path),
    sidecars: files.filter((f) => isSidecarPath(f.path)).map((f) => f.path),
  };
}

/** The folder an import writes to by default: beside its source. */
export const defaultOutputFolder = (path: string): string => dirOf(path);

/**
 * Write a plan's files in one batch (assets, not a scene edit, so not an undo step) and report it in the status bar.
 * Sidecars go through the editor's import settings, so the Inspector and pickers see the new slices. Resolves to the
 * files written; refuses in a read-only project.
 */
export async function writeImport(project: EditorProject, source: string, plan: ImportPlan): Promise<string[]> {
  if (editor.project.refuseReadOnly(project, "imports")) return [];
  const written: string[] = [];
  try {
    const folders = [...new Set(plan.files.map((f) => dirOf(f.path)).filter((f) => f && !project.folders.includes(f)))].sort();
    for (const folder of folders) if (!project.folders.includes(folder)) await project.createFolder(folder);
    for (const f of plan.files) {
      if (isSidecarPath(f.path)) await editor.assets.writeImportSettings(project, sidecarAsset(f.path), parseImportSettings(JSON.parse(f.text), f.path).settings);
      else await project.writeText(f.path, f.text);
      written.push(f.path);
    }
  } catch (err) {
    editor.project.changed();
    editor.messages.failed(`Importing ${editor.assets.fileName(source)} stopped after ${written.length} of ${plan.files.length} files`, err);
    return written;
  }
  editor.project.changed();
  const warned = plan.warnings.length ? `, ${plan.warnings.length} warning${plan.warnings.length === 1 ? "" : "s"}` : "";
  editor.messages.info(`Imported ${editor.assets.fileName(source)}: wrote ${written.length} file${written.length === 1 ? "" : "s"}${warned}.`, [...written, ...plan.warnings.map((w) => `Warning: ${w}`)].join("\n"));
  return written;
}

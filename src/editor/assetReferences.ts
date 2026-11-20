// The asset reference module (ADR 0148): which files refer to an asset, what an asset refers to,
// and rewriting or removing those references when files move or go. Everything else in the editor
// asks here instead of matching paths itself.
//
// What counts as a reference:
// - A **reference string** names a project path, optionally with an `asset:` prefix and a leading
//   `./` or `/`, optionally followed by `#slice` (ADR 0040): `asset:images/sheet.png#walk_0`,
//   `./images/bird.png`, `prefabs/pipe.prefab.json`. `parseAssetRef` (assetRefValues.ts) splits one up.
// - A file **uses** a path when its text holds a quoted reference string to it (single, double or
//   back quotes), to one of its slices, or (for a folder) to something inside it. Scenes, prefabs,
//   other JSON files and scripts are searched, and the open scene's unsaved document when given.
// - A file **depends on** the project files it names: every reference string in a JSON file, and
//   what its asset kind's `references` extractor reads from a file in its own format (models' material
//   libraries, textures and buffers come from the Meshes plugin; the shell knows no model format).
//
// Edits go through the project file loop (`projectFileEdits.ts`, shared with the settings names module):
// scenes and prefabs, project.json and plain JSON, the open scene as one undo step (save to keep it).
import { assetRefPath, sceneWithoutAsset, settingsWithoutAsset, withMovedAssets } from "./assetRefValues";
import { assetKind, registeredKind } from "./assetKindLookup";
import type { AssetReferenceExtractor } from "./sdk/contributions";
import { editProjectFiles } from "./projectFileEdits";
import { isWithin, type EditorProject } from "./projects";

export { assetRefTarget } from "./assetRefValues";

// ---------------------------------------------------------------------------------------------
// Normalisation

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True if `text` holds a quoted reference to one of `paths`, one of its slices, or something inside it (a folder). */
function mentions(text: string | undefined, paths: readonly string[]): boolean {
  if (!text || paths.length === 0) return false;
  return new RegExp(`["'\`](?:asset:)?(?:\\.?/)?(?:${paths.map(escapeRegExp).join("|")})(?=["'\`#/])`).test(text);
}

// ---------------------------------------------------------------------------------------------
// Who uses an asset, and what it depends on

/**
 * The files that refer to `path` (a file, a slice or a folder): JSON files (scenes, prefabs, settings,
 * materials…) and scripts that quote it, plus the open scene's unsaved document, if given and it does
 * (listed as "<path> (unsaved edits)" when its file on disk doesn't).
 */
export function assetUsers(project: EditorProject, path: string, openDocument?: { path: string; text: string } | null): string[] {
  const users = project.files.filter((f) => f !== path && f.endsWith(".json") && mentions(project.textOf(f), [path]));
  for (const [script, text] of project.scripts) if (script !== path && mentions(text, [path])) users.push(script);
  if (openDocument && openDocument.path !== path && mentions(openDocument.text, [path]) && !users.includes(openDocument.path)) users.push(`${openDocument.path} (unsaved edits)`);
  return users;
}

/** The scripts that quote one of `paths` (or something inside one): scripts are never rewritten, so callers list them. */
export function scriptUsers(project: EditorProject, paths: readonly string[]): string[] {
  return [...project.scripts].filter(([script, text]) => !paths.includes(script) && mentions(text, paths)).map(([script]) => script);
}

/** What a dependency walk can read: the project's files and the text of its text files. */
export interface ReferenceSource {
  readonly files: readonly string[];
  /** A text file's text (JSON, or a format a kind's `references` reads), or undefined for binaries and missing files. */
  text(path: string): string | undefined;
}

/** The `references` extractor of the file's asset kind (ADR 0148), if it has one that reads this file's ending. */
function extractorFor(path: string): AssetReferenceExtractor | undefined {
  const extractor = registeredKind(assetKind(path))?.references;
  const lower = path.toLowerCase();
  return extractor && (!extractor.extensions || extractor.extensions.some((e) => lower.endsWith(e))) ? extractor : undefined;
}

/** True if the file at `path` names other files in its own (text) format: its asset kind reads it (ADR 0148). Such files' text is worth reading even when the project serves them as bytes. */
export const hasOwnReferences = (path: string): boolean => extractorFor(path) !== undefined;

/**
 * The project files `path` refers to directly, without duplicates: what its kind's `references`
 * extractor reads if it has one, else, for a JSON file, every string in it that is a reference to a
 * project file.
 */
export function assetDependencies(source: ReferenceSource, path: string): string[] {
  const text = source.text(path);
  if (text === undefined) return [];
  const files = new Set(source.files);
  const extract = extractorFor(path)?.read;
  const out = new Set<string>();
  if (extract) {
    for (const p of extract(path, text)) if (files.has(p) && p !== path) out.add(p);
  } else if (path.toLowerCase().endsWith(".json")) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return [];
    }
    const walk = (v: unknown) => {
      if (typeof v === "string") {
        const p = assetRefPath(v);
        if (p !== path && files.has(p)) out.add(p);
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(value);
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------
// Moves (the pure edits on parsed files are in assetRefValues.ts)

/** A path's new path under `moves` (each a project path and its new path; folders move what's in them), or null if it didn't move. */
export function movedPath(moves: readonly (readonly [string, string])[]): (path: string) => string | null {
  return (path) => {
    for (const [from, to] of moves) if (isWithin(path, from)) return to + path.slice(from.length);
    return null;
  };
}

// ---------------------------------------------------------------------------------------------
// Edits across the project

/**
 * Point references at moved files' new paths, everywhere a file's users are found: scenes, prefabs,
 * project.json and other JSON files on disk, and the open scene (one undo step labelled `label`).
 * Each move is a project path (a file, a folder, or a slice `image#name`) and its new path. Returns
 * the files updated and the scripts that still quote an old path (scripts aren't edited).
 */
export async function rewriteReferences(project: EditorProject, moves: readonly (readonly [string, string])[], label: string): Promise<{ updated: string[]; scriptUsers: string[] }> {
  const froms = moves.map(([from]) => from);
  const rename = movedPath(moves);
  const moved = <T>(value: T): T | null => {
    const result = withMovedAssets(value, rename);
    return result.changed ? result.value : null;
  };
  const updated = await editProjectFiles(project, { mentioned: (text) => mentions(text, froms), scene: moved, settings: moved, json: moved }, label);
  return { updated, scriptUsers: scriptUsers(project, froms) };
}

/**
 * Take the deleted `path` out of the project's scenes, prefabs and settings (see `sceneWithoutAsset`
 * and `settingsWithoutAsset`): files on disk are rewritten, the open scene is edited as one undo
 * step labelled `label`. Other JSON files (materials…) and scripts keep their references; `assetUsers`
 * lists them. Returns the files cleaned (the open scene as "<path> (unsaved)").
 */
export function removeReferences(project: EditorProject, path: string, label: string): Promise<string[]> {
  return editProjectFiles(
    project,
    {
      mentioned: (text) => mentions(text, [path]),
      scene: (file) => {
        const result = sceneWithoutAsset(file, path);
        return result.changed ? result.file : null;
      },
      settings: (json) => {
        const result = settingsWithoutAsset(json, path);
        return result.changed ? result.settings : null;
      },
      json: () => null,
    },
    label,
  );
}

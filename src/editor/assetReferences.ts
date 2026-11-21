// The asset reference module (ADR 0148, 0302): which files refer to an asset, what an asset refers to,
// and rewriting or removing those references when files move or go. Everything else in the editor
// asks here instead of matching paths itself.
//
// What counts as a reference:
// - A **reference string** names a project path, optionally with an `asset:` prefix and a leading
//   `./` or `/`, optionally followed by `#slice` (ADR 0040): `asset:images/sheet.png#walk_0`,
//   `./images/bird.png`, `prefabs/pipe.prefab.json`. `parseAssetRef` (assetRefValues.ts) splits one up.
// - **The references a file holds**, by one rule (`referencesIn`): what its asset kind's `references`
//   reader reads from a file in its own format (models' material libraries, textures and buffers come
//   from the Meshes plugin; the shell knows no model format), else, for a JSON file, every reference
//   string in it. A file **depends on** the project files among them; a file **uses** a path when one
//   of them names it, one of its slices, or (for a folder) something inside it. So users and
//   dependencies always agree (ADR 0302). Scripts have no reader: they use a path when they quote it
//   (single, double or back quotes); the open scene's unsaved document is read like a JSON file.
//
// Edits go through the project file loop (`projectFileEdits.ts`, shared with the settings names module),
// which asks each JSON file's owner to apply them: scenes and prefabs, asset documents (open or by the
// kind's format), project.json and plain JSON, the open scene as one undo step (save to keep it). A move
// asks each other file whose kind reads its format to rewrite it (ADR 0314): references to moved files,
// and a moved file's own relative references (a .gltf moved without its .bin). Files no one rewrites
// (scripts, and kinds that read a format without rewriting it) are reported.
import { assetRefTarget, sceneWithoutAsset, settingsWithoutAsset, withMovedAssets } from "./assetRefValues";
import { assetKind, registeredKind } from "./assetKindLookup";
import type { AssetReferences } from "./sdk/contributions";
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
// The references a file holds

/** One reference a file holds: a project path and, for a JSON reference string to a slice, the slice. */
interface HeldReference {
  readonly path: string;
  readonly slice: string | null;
}

/** The `references` reader of the file's asset kind (ADR 0148), if it has one that reads this file's ending. */
function extractorFor(path: string): AssetReferences | undefined {
  const extractor = registeredKind(assetKind(path))?.references;
  const lower = path.toLowerCase();
  return extractor && (!extractor.extensions || extractor.extensions.some((e) => lower.endsWith(e))) ? extractor : undefined;
}

/** True if the file at `path` names other files in its own (text) format: its asset kind reads it (ADR 0148). Such files' text is worth reading even when the project serves them as bytes. */
export const hasOwnReferences = (path: string): boolean => extractorFor(path) !== undefined;

const isJsonPath = (path: string) => path.toLowerCase().endsWith(".json");

/** Every string in a JSON value, as a reference. */
function jsonReferences(text: string): HeldReference[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const out: HeldReference[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const target = assetRefTarget(v);
      const hash = target.indexOf("#");
      out.push(hash < 0 ? { path: target, slice: null } : { path: target.slice(0, hash), slice: target.slice(hash + 1) });
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}

/** The references the file at `path` (with text `text`) holds: its kind's reader's if it has one, else a JSON file's reference strings. */
function referencesIn(path: string, text: string): HeldReference[] {
  const extract = extractorFor(path)?.read;
  if (extract) return extract(path, text).map((p) => ({ path: p, slice: null }));
  return isJsonPath(path) ? jsonReferences(text) : [];
}

/** True if `ref` names `path`: the file, one of its slices, that slice (a slice path `image#name`), or something inside it (a folder). */
const refNames = (ref: HeldReference, path: string) => isWithin(ref.path, path) || (ref.slice !== null && `${ref.path}#${ref.slice}` === path);

// ---------------------------------------------------------------------------------------------
// Who uses an asset, and what it depends on

/** What a dependency walk can read: the project's files and the text of its text files. */
export interface ReferenceSource {
  readonly files: readonly string[];
  /** A text file's text (JSON, or a format a kind's `references` reads), or undefined for binaries and missing files. */
  text(path: string): string | undefined;
}

/** The project files `path` refers to directly, without duplicates (see `referencesIn`). */
export function assetDependencies(source: ReferenceSource, path: string): string[] {
  const text = source.text(path);
  if (text === undefined) return [];
  const files = new Set(source.files);
  const out = new Set<string>();
  for (const ref of referencesIn(path, text)) if (ref.path !== path && files.has(ref.path)) out.add(ref.path);
  return [...out];
}

/** A project file's text: a JSON or text file's, or, for a file served as bytes whose kind reads its format, read from the project's URL for it. */
async function projectText(project: EditorProject, path: string): Promise<string | undefined> {
  const text = project.textOf(path);
  if (text !== undefined) return text;
  const url = project.assets.get(path);
  if (typeof url !== "string") return undefined;
  try {
    const res = await fetch(url);
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The files that refer to one of `paths` (each a file, a slice or a folder), by the rule dependencies use (see
 * `referencesIn`): JSON files and files a kind's reader reads, in project order, then scripts that quote one, plus
 * the open scene's unsaved document, if given and it does (listed as "<path> (unsaved edits)" when its file on
 * disk doesn't). A file isn't listed for naming itself.
 */
export async function assetUsers(project: EditorProject, paths: string | readonly string[], openDocument?: { path: string; text: string } | null): Promise<string[]> {
  const targets = typeof paths === "string" ? [paths] : paths;
  const uses = (file: string, refs: readonly HeldReference[]) => refs.some((ref) => targets.some((p) => p !== file && refNames(ref, p)));
  // A JSON reference string holds its target's last name as written: files without any are skipped unparsed.
  const names = targets.map((p) => p.slice(p.lastIndexOf("/") + 1).split("#")[0]);
  const users: string[] = [];
  for (const file of project.files) {
    const json = isJsonPath(file) && !hasOwnReferences(file);
    if (!json && !hasOwnReferences(file)) continue;
    const text = await projectText(project, file);
    if (text === undefined || (json && !names.some((n) => text.includes(n)))) continue;
    if (uses(file, referencesIn(file, text))) users.push(file);
  }
  for (const [script, text] of project.scripts) if (mentions(text, targets.filter((p) => p !== script))) users.push(script);
  if (openDocument && uses(openDocument.path, jsonReferences(openDocument.text)) && !users.includes(openDocument.path)) users.push(`${openDocument.path} (unsaved edits)`);
  return users;
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

/**
 * Ask each file (not JSON) whose kind rewrites its own format to follow `moves`, which have happened (ADR 0314):
 * references to moved files, and a moved file's relative references to files that stayed. Returns the files written.
 */
async function rewriteOwnFormats(project: EditorProject, moves: readonly (readonly [string, string])[]): Promise<string[]> {
  const rename = movedPath(moves);
  const before = movedPath(moves.map(([from, to]) => [to, from] as const));
  const written: string[] = [];
  for (const path of project.files) {
    const rewrite = extractorFor(path)?.rewrite;
    if (!rewrite || isJsonPath(path)) continue;
    const text = await projectText(project, path);
    if (text === undefined) continue;
    const next = rewrite(path, text, { from: before(path) ?? path, to: (p) => rename(p) ?? p });
    if (next === null || next === text) continue;
    await project.writeFile(path, next);
    written.push(path);
  }
  return written;
}

// ---------------------------------------------------------------------------------------------
// Edits across the project

/**
 * Point references at moved files' new paths, everywhere a JSON file's owner can rewrite them: scenes, prefabs,
 * asset files (an open asset document's whole history, ADR 0302), project.json and other JSON files on disk, and
 * the open scene (one undo step labelled `label`); and in the files whose kind rewrites its own format (ADR 0314:
 * .obj, .mtl, .gltf), which also keep a moved file's relative references at their targets. Each move, done
 * already, is a project path (a file, a folder, or a slice `image#name`) and its new path. Returns the files
 * updated and the files that still name an old path because no one rewrites them: scripts, and files of a kind
 * that reads its format without rewriting it.
 */
export async function rewriteReferences(project: EditorProject, moves: readonly (readonly [string, string])[], label: string): Promise<{ updated: string[]; notRewritten: string[] }> {
  const froms = moves.map(([from]) => from);
  const rename = movedPath(moves);
  const moved = <T>(value: T): T | null => {
    const result = withMovedAssets(value, rename);
    return result.changed ? result.value : null;
  };
  const updated = await editProjectFiles(project, { mentioned: (text) => mentions(text, froms), scene: moved, settings: moved, json: moved }, label);
  updated.push(...(await rewriteOwnFormats(project, moves)));
  const notRewritten = (await assetUsers(project, froms)).filter((f) => !isJsonPath(f));
  return { updated, notRewritten };
}

/**
 * Take the deleted `path` out of the project's scenes, prefabs and settings (see `sceneWithoutAsset`
 * and `settingsWithoutAsset`): files on disk are rewritten, the open scene is edited as one undo
 * step labelled `label`. Other files (asset files such as materials, model files, scripts) keep their
 * references; `assetUsers` lists them. Returns the files cleaned (the open scene as "<path> (unsaved)").
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

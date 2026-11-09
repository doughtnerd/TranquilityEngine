// The asset reference module (ADR 0148): which files refer to an asset, what an asset refers to,
// and rewriting or removing those references when files move or go. Everything else in the editor
// asks here instead of matching paths itself.
//
// What counts as a reference:
// - A **reference string** names a project path, optionally with an `asset:` prefix and a leading
//   `./` or `/`, optionally followed by `#slice` (ADR 0040): `asset:images/sheet.png#walk_0`,
//   `./images/bird.png`, `prefabs/pipe.prefab.json`. `parseAssetRef` splits one up.
// - A file **uses** a path when its text holds a quoted reference string to it (single, double or
//   back quotes), to one of its slices, or (for a folder) to something inside it. Scenes, prefabs,
//   other JSON files and scripts are searched, and the open scene's unsaved document when given.
// - A file **depends on** the project files it names: every reference string in a JSON file, and
//   what its asset kind's `references` extractor reads from a file in its own format (models' material
//   libraries, textures and buffers come from the Meshes plugin; the shell knows no model format).
//
// Edits know three kinds of JSON file: scenes and prefabs (one format, written keeping their layout,
// and instances of a changed prefab in the open scene are rebuilt), project.json (the settings) and
// plain JSON. The open scene is edited as one undo step instead of on disk (save to keep it).
import { normalizeAssetPath } from "../engine/scene/Assets";
import type { OverrideEntry, SceneFile } from "./document";
import { ReplaceDocument } from "./document";
import { assetKind, registeredKind } from "./assetKindLookup";
import type { AssetReferenceExtractor } from "./sdk/contributions";
import { instancesOf } from "./prefabs";
import { writeSceneFile } from "./project";
import { isWithin, type EditorProject } from "./projects";
import { openScene, type OpenScene } from "./state";

// ---------------------------------------------------------------------------------------------
// Normalisation

/** A reference string split up: what came before the path, the path, and the slice name (or null). */
export interface AssetRef {
  /** `asset:`, `./`, `/` or `asset:./`…, as written (kept when a reference is rewritten). */
  readonly prefix: string;
  /** The project path, without prefix or slice. */
  readonly path: string;
  readonly slice: string | null;
}

const PREFIX = /^(?:asset:)?(?:\.?\/)?/;

/** Split a reference string: `asset:./images/a.png#walk` → `{ prefix: "asset:./", path: "images/a.png", slice: "walk" }`. */
export function parseAssetRef(ref: string): AssetRef {
  const prefix = PREFIX.exec(ref)![0];
  const rest = ref.slice(prefix.length);
  const hash = rest.indexOf("#");
  return hash < 0 ? { prefix, path: rest, slice: null } : { prefix, path: rest.slice(0, hash), slice: rest.slice(hash + 1) };
}

/** The project path a reference names, without `asset:`, `./` or `#slice`: `asset:images/a.png#walk` → `images/a.png`. */
export const assetRefPath = (ref: string): string => parseAssetRef(ref).path;

/** What a reference names, slice included, without its prefix: `asset:./images/a.png#walk` → `images/a.png#walk` (the engine's `normalizeAssetPath`). */
export const assetRefTarget = (ref: string): string => normalizeAssetPath(ref);

/**
 * True for a value naming `path`: a reference string to it or to one of its slices. A slice path
 * (`images/a.png#walk`) is named only by references to that slice.
 */
export function namesAsset(value: unknown, path: string): boolean {
  if (typeof value !== "string") return false;
  const target = assetRefTarget(value);
  return target === path || target.startsWith(`${path}#`);
}

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
// Pure edits on parsed files

/**
 * `value` without anything naming `path` (object keys and array items naming it go), and with
 * `{ $node: id }` references to `removed` nodes set to null. `changed` says whether anything did.
 */
function cleanValue(value: unknown, path: string, removed: ReadonlySet<string>): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      if (namesAsset(item, path)) {
        changed = true;
        continue;
      }
      const c = cleanValue(item, path, removed);
      changed ||= c.changed;
      out.push(c.value);
    }
    return { value: out, changed };
  }
  if (value && typeof value === "object") {
    const ref = (value as { $node?: unknown }).$node;
    if (typeof ref === "string" && Object.keys(value).length === 1) return removed.has(ref) ? { value: null, changed: true } : { value, changed: false };
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (namesAsset(v, path)) {
        changed = true;
        continue;
      }
      const c = cleanValue(v, path, removed);
      changed ||= c.changed;
      out[key] = c.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

/**
 * A scene or prefab file without references to the deleted asset `path`: nodes that are instances
 * of it go (with their children, and `{ $node }` references to them become null); component fields,
 * overrides and nested values naming it are dropped (fields go back to their defaults). Returns the
 * new file, the ids of the nodes removed, and whether anything changed. The input isn't modified.
 */
export function sceneWithoutAsset(file: SceneFile, path: string): { file: SceneFile; removedNodes: string[]; changed: boolean } {
  // Instances of it, then everything parented under them.
  const removed = new Set(file.nodes.filter((n) => n.prefab !== undefined && assetRefTarget(n.prefab) === path).map((n) => n.id));
  for (let grew = removed.size > 0; grew; ) {
    grew = false;
    for (const n of file.nodes) {
      if (n.parent && removed.has(n.parent) && !removed.has(n.id)) {
        removed.add(n.id);
        grew = true;
      }
    }
  }
  let changed = removed.size > 0;
  const nodes = file.nodes
    .filter((n) => !removed.has(n.id))
    .map((n) => {
      const node = structuredClone(n);
      for (const c of node.components ?? []) {
        if (!c.data) continue;
        const cleaned = cleanValue(c.data, path, removed);
        if (cleaned.changed) {
          changed = true;
          c.data = cleaned.value as Record<string, unknown>;
        }
      }
      if (node.overrides) {
        const kept: OverrideEntry[] = [];
        for (const o of node.overrides) {
          if (o.value !== undefined && namesAsset(o.value, path)) {
            changed = true; // the field goes back to the prefab's value
            continue;
          }
          const c = cleanValue(o, path, removed);
          changed ||= c.changed;
          kept.push(c.value as OverrideEntry);
        }
        if (kept.length > 0) node.overrides = kept;
        else delete node.overrides;
      }
      return node;
    });
  return { file: { ...file, nodes }, removedNodes: [...removed], changed };
}

/** Project settings without autoloads of the deleted asset `path`. */
export function settingsWithoutAsset(settings: Record<string, unknown>, path: string): { settings: Record<string, unknown>; changed: boolean } {
  const autoload = settings.autoload;
  if (!Array.isArray(autoload) || !autoload.some((a) => namesAsset(a, path))) return { settings, changed: false };
  return { settings: { ...settings, autoload: autoload.filter((a) => !namesAsset(a, path)) }, changed: true };
}

/** A path's new path under `moves` (each a project path and its new path; folders move what's in them), or null if it didn't move. */
export function movedPath(moves: readonly (readonly [string, string])[]): (path: string) => string | null {
  return (path) => {
    for (const [from, to] of moves) if (isWithin(path, from)) return to + path.slice(from.length);
    return null;
  };
}

/**
 * `value` with every reference string to a moved file updated: `rename` gives a path's new path, or
 * null if it didn't move. Prefixes (`asset:`, `./`) are kept. A slice reference
 * (`images/sheet.png#walk_0`, ADR 0040) is offered to `rename` whole first (so renaming a slice is a
 * move of `sheet.png#walk_0`), then as its image, keeping the `#name`.
 */
export function withMovedAssets<T>(value: T, rename: (path: string) => string | null): { value: T; changed: boolean } {
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const ref = parseAssetRef(v);
      const target = ref.slice === null ? ref.path : `${ref.path}#${ref.slice}`;
      let to = rename(target);
      if (to === null && ref.slice !== null) {
        const image = rename(ref.path);
        if (image !== null) to = `${image}#${ref.slice}`;
      }
      if (to === null) return v;
      changed = true;
      return ref.prefix + to;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value) as T;
  return { value: changed ? out : value, changed };
}

// ---------------------------------------------------------------------------------------------
// Edits across the project

const isSceneFile = (json: unknown): json is SceneFile =>
  !!json && typeof json === "object" && typeof (json as { format?: unknown }).format === "string" && /^(myco|tranquility)\.scene@/.test((json as { format: string }).format) && Array.isArray((json as { nodes?: unknown }).nodes);

/** How one edit changes each kind of JSON file: the new value, or null for no change. */
interface FileEdit {
  /** Only files whose text this accepts are parsed. */
  mentioned(text: string): boolean;
  scene(file: SceneFile): SceneFile | null;
  settings(json: Record<string, unknown>): Record<string, unknown> | null;
  json(json: unknown): unknown;
}

/**
 * Apply `edit` to the project's JSON files on disk (scenes keep their layout, and instances of a
 * changed prefab in the open scene are rebuilt) and to the open scene as one undo step labelled
 * `label`. Returns the files changed (the open scene as "<path> (unsaved)").
 */
async function editProject(project: EditorProject, edit: FileEdit, label: string): Promise<string[]> {
  const scene: OpenScene | null = openScene.peek();
  const changed: string[] = [];
  for (const file of project.files) {
    if (!file.endsWith(".json") || file === scene?.path) continue;
    const text = project.textOf(file);
    if (text === undefined || !edit.mentioned(text)) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue; // a broken file is left alone
    }
    if (isSceneFile(json)) {
      // Scenes and prefabs share the format.
      const next = edit.scene(json);
      if (!next) continue;
      await writeSceneFile(project, file, next);
      // Instances of a changed prefab in the open scene show its new contents.
      if (scene) scene.sync.apply(instancesOf(scene.doc, file).map((node) => ({ kind: "rebuild", node }) as const));
    } else {
      const next = file === "project.json" && json && typeof json === "object" && !Array.isArray(json) ? edit.settings(json as Record<string, unknown>) : edit.json(json);
      if (next === null) continue;
      await project.writeText(file, `${JSON.stringify(next, null, 2)}\n`);
    }
    changed.push(file);
  }
  if (scene) {
    const next = edit.scene(scene.doc.toJSON());
    if (next) {
      scene.stack.execute(new ReplaceDocument(next, label));
      changed.push(`${scene.path} (unsaved)`);
    }
  }
  return changed;
}

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
  const updated = await editProject(project, { mentioned: (text) => mentions(text, froms), scene: moved, settings: moved, json: moved }, label);
  return { updated, scriptUsers: scriptUsers(project, froms) };
}

/**
 * Take the deleted `path` out of the project's scenes, prefabs and settings (see `sceneWithoutAsset`
 * and `settingsWithoutAsset`): files on disk are rewritten, the open scene is edited as one undo
 * step labelled `label`. Other JSON files (materials…) and scripts keep their references; `assetUsers`
 * lists them. Returns the files cleaned (the open scene as "<path> (unsaved)").
 */
export function removeReferences(project: EditorProject, path: string, label: string): Promise<string[]> {
  return editProject(
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

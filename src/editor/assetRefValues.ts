// Asset reference strings and pure edits of values that hold them (ADR 0148), split out of
// assetReferences.ts, which applies them to the project's files and the open scene.
//
// A reference string names a project path, optionally with an `asset:` prefix and a leading `./`
// or `/`, optionally followed by `#slice` (ADR 0040): `asset:images/sheet.png#walk_0`. The rule is the
// engine's (`engine/scene/assetPath.ts`, ADR 0459); this module splits and rewrites references on it.
import { assetRefPrefix, normalizeAssetPath } from "../engine/scene/assetPath";
import { REMOVE_FIELD, mapSceneFile } from "../engine/scene/sceneFileWalk";
import { mapFieldNodeRefs } from "../engine/scene/nodeReferences";
import type { NodeEntry, SceneFile } from "./document";

/** A reference string split up: what came before the path, the path, and the slice name (or null). */
export interface AssetRef {
  /** `asset:`, `./`, `/` or `asset:./`…, as written (kept when a reference is rewritten). */
  readonly prefix: string;
  /** The project path, without prefix or slice. */
  readonly path: string;
  readonly slice: string | null;
}

/** Split a reference string: `asset:./images/a.png#walk` → `{ prefix: "asset:./", path: "images/a.png", slice: "walk" }`. */
export function parseAssetRef(ref: string): AssetRef {
  const prefix = assetRefPrefix(ref);
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

/**
 * `value` without anything naming `path` (object keys and array items naming it go). `changed`
 * says whether anything did.
 */
function cleanValue(value: unknown, path: string): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      if (namesAsset(item, path)) {
        changed = true;
        continue;
      }
      const c = cleanValue(item, path);
      changed ||= c.changed;
      out.push(c.value);
    }
    return { value: out, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (namesAsset(v, path)) {
        changed = true;
        continue;
      }
      const c = cleanValue(v, path);
      changed ||= c.changed;
      out[key] = c.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

/**
 * A scene or prefab file without references to the deleted asset `path`: nodes that are instances
 * of it go (with their children, and `{ $node }` references to them become null), in the file's
 * own node list and in prefab instances' added nodes; component fields, overrides and nested values
 * naming it are dropped (fields go back to their defaults, overridden fields to the prefab's value).
 * Returns the new file, the ids of the file's own nodes removed, and whether anything changed. The
 * input isn't modified. The walk over the file is the engine's scene-file walk (ADR 0279).
 */
export function sceneWithoutAsset(file: SceneFile, path: string): { file: SceneFile; removedNodes: string[]; changed: boolean } {
  const removed = new Set<string>();
  let top = true;
  const out = mapSceneFile(file, {
    nodes: (nodes) => {
      const gone = instancesOf(nodes, path);
      if (top) for (const id of gone) removed.add(id);
      top = false;
      return gone.size > 0 ? nodes.filter((n) => !gone.has(n.id)) : nodes;
    },
    field: (_component, _field, value) => {
      if (namesAsset(value, path)) return REMOVE_FIELD;
      // References to removed nodes become None, where a reference can sit (nodeReferences.ts, ADR 0280).
      const unref = mapFieldNodeRefs(value, (id) => (removed.has(id) ? null : id));
      const c = cleanValue(unref, path);
      return c.changed ? c.value : unref;
    },
  });
  return { file: out, removedNodes: [...removed], changed: out !== file };
}

/** The ids in one node list of the instances of `path` and everything parented under them. */
function instancesOf(nodes: readonly NodeEntry[], path: string): Set<string> {
  const gone = new Set(nodes.filter((n) => n.prefab !== undefined && assetRefTarget(n.prefab) === path).map((n) => n.id));
  for (let grew = gone.size > 0; grew; ) {
    grew = false;
    for (const n of nodes) {
      if (n.parent && gone.has(n.parent) && !gone.has(n.id)) {
        gone.add(n.id);
        grew = true;
      }
    }
  }
  return gone;
}

/** Project settings without autoloads, or action set files (`input.actionSets`, ADR 0433), of the deleted asset `path`. */
export function settingsWithoutAsset(settings: Record<string, unknown>, path: string): { settings: Record<string, unknown>; changed: boolean } {
  let out = settings;
  const autoload = settings.autoload;
  if (Array.isArray(autoload) && autoload.some((a) => namesAsset(a, path))) out = { ...out, autoload: autoload.filter((a) => !namesAsset(a, path)) };
  const input = settings.input;
  const sets = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).actionSets : undefined;
  if (Array.isArray(sets) && sets.some((a) => namesAsset(a, path))) out = { ...out, input: { ...(input as Record<string, unknown>), actionSets: sets.filter((a) => !namesAsset(a, path)) } };
  return { settings: out, changed: out !== settings };
}

/**
 * `value` with every reference string to a moved file updated: `rename` gives a path's new path, or
 * null if it didn't move. Prefixes (`asset:`, `./`) are kept. A slice reference
 * (`images/sheet.png#walk_0`, ADR 0040) is offered to `rename` whole first (so renaming a slice is a
 * move of `sheet.png#walk_0`), then as its image, keeping the `#name`.
 *
 * `bareFolders`, if given, lists moved folders whose path written bare (no prefix, no slice: `enemies`)
 * isn't taken for a reference: in formats where such a string is a name, an id or a tag rather than a
 * folder path (scenes, prefabs, project settings), so only `asset:enemies`, `./enemies` and paths
 * inside the folder follow the move.
 */
export function withMovedAssets<T>(value: T, rename: (path: string) => string | null, bareFolders?: readonly string[]): { value: T; changed: boolean } {
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const ref = parseAssetRef(v);
      if (bareFolders && ref.prefix === "" && ref.slice === null && bareFolders.includes(ref.path)) return v;
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

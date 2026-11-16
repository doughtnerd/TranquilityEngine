// Asset reference strings and pure edits of values that hold them (ADR 0148), split out of
// assetReferences.ts, which applies them to the project's files and the open scene.
//
// A reference string names a project path, optionally with an `asset:` prefix and a leading `./`
// or `/`, optionally followed by `#slice` (ADR 0040): `asset:images/sheet.png#walk_0`.
import { normalizeAssetPath } from "../engine/scene/Assets";
import type { OverrideEntry, SceneFile } from "./document";

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

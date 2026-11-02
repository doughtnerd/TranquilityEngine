// Taking a deleted asset out of the files that refer to it, so scenes don't keep pointing at a
// file that's gone. In scene and prefab files: nodes that are instances of it are removed (with
// their children, and references to them set to None); component fields, overrides and nested
// values that name it are dropped (fields go back to their defaults). In project.json: autoloads
// of it are dropped. For renamed or moved files, `withMovedAssets` points references at the new
// paths. Pure functions on parsed files; assetDelete.ts and assetOps.ts write the results.
import type { OverrideEntry, SceneFile } from "./document";

/** True for a value naming `path`: the plain path, or an `asset:` reference to it. */
const names = (value: unknown, path: string) => value === path || value === `asset:${path}`;

/**
 * `value` without anything naming `path` (object keys and array items naming it go), and with
 * `{ $node: id }` references to `removed` nodes set to null. `changed` says whether anything did.
 */
function cleanValue(value: unknown, path: string, removed: ReadonlySet<string>): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      if (names(item, path)) {
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
      if (names(v, path)) {
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
 * A scene or prefab file without references to the deleted asset `path`. Returns the new file,
 * the ids of the nodes removed (instances of it and their children), and whether anything
 * changed. The input isn't modified.
 */
export function sceneWithoutAsset(file: SceneFile, path: string): { file: SceneFile; removedNodes: string[]; changed: boolean } {
  // Instances of it, then everything parented under them.
  const removed = new Set(file.nodes.filter((n) => n.prefab === path).map((n) => n.id));
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
          if (o.value !== undefined && names(o.value, path)) {
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
  if (!Array.isArray(autoload) || !autoload.some((a) => names(a, path))) return { settings, changed: false };
  return { settings: { ...settings, autoload: autoload.filter((a) => !names(a, path)) }, changed: true };
}

/**
 * `value` with every string naming a moved file updated: `rename` gives a path's new path, or
 * null if it didn't move. `asset:` references keep their prefix.
 */
export function withMovedAssets<T>(value: T, rename: (path: string) => string | null): { value: T; changed: boolean } {
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const asset = v.startsWith("asset:");
      const to = rename(asset ? v.slice(6) : v);
      if (to === null) return v;
      changed = true;
      return asset ? `asset:${to}` : to;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value) as T;
  return { value: changed ? out : value, changed };
}

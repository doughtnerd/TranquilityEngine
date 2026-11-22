/**
 * Internal (ADR 0337 §7, A1): package definitions in `audio.json` (`packages`, `packaging`), read and written, and what
 * a package holds once its dependencies are added.
 *
 * ```jsonc
 * "packages": [
 *   { "name": "Core",   "preload": true, "include": ["audio/ui/**", "playlists/ui/**"] },
 *   { "name": "Boss",   "include": ["playlists/boss_theme.playlist.json"], "platforms": ["desktop", "web"] }
 * ],
 * "packaging": { "strict": true }
 * ```
 *
 * - `include` lists playlists, samples, derived samples and globs (`encoding/pathGlob.ts`). Dependencies are added
 *   automatically (`packageContents`): a playlist brings what it names (samples, nested playlists, attenuation
 *   presets), a derived sample its source and its render.
 * - Names are unique (case-sensitive) and non-empty. `platforms` absent: every platform.
 * - `strict` (default true): a packaged sound whose packages are all unloaded is refused (`notLoaded`).
 *
 * Parses are lenient (ADR 0306): bad entries are dropped or fixed with one problem line each; they never throw. Pure.
 */
import type { ImportPlatform } from "../../scene/importSettings";
import { ENCODING_PLATFORMS } from "../encoding/defaults";
import { compileGlob, hasWildcard } from "../encoding/pathGlob";
import { isPlaylistPath, parsePlaylistBody } from "../playlist/format";
import { referencedPaths } from "../playlist/references";
import { isDerivedSamplePath } from "../sample/format";

/** One package. */
export interface PackageDef {
  name: string;
  /** Project paths and globs, in the author's order. */
  include: string[];
  /** Loaded at engine start, before the first scene (FMOD's Master bank, Wwise's Init bank). */
  preload: boolean;
  /** The platforms it ships on; null = every platform. */
  platforms: ImportPlatform[] | null;
}

/** `packaging`: project-wide package rules. */
export interface PackagingOptions {
  strict: boolean;
}

export const PACKAGE_LIMITS = Object.freeze({ packages: 256, includes: 1024, nameLength: 64 });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why `name` can't name a package (given the others' names), or null if it can. */
export function whyNotPackageName(name: string, others: readonly string[] = []): string | null {
  if (name.trim() === "") return "a package name can't be empty";
  if (name !== name.trim()) return "a package name can't start or end with a space";
  if (name.length > PACKAGE_LIMITS.nameLength) return `a package name has at most ${PACKAGE_LIMITS.nameLength} characters`;
  if (/[/\\:*?"<>|]/.test(name)) return 'a package name can\'t contain / \\ : * ? " < > or |';
  if (others.includes(name)) return `there's already a package named "${name}"`;
  return null;
}

/** `audio.json`'s `packages`; absent is none. */
export function parsePackages(raw: unknown, problems: string[], where = "packages"): PackageDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push(`${where}: must be a list; ignored.`);
    return [];
  }
  const out: PackageDef[] = [];
  raw.forEach((p, i) => {
    const at = `${where}[${i}]`;
    if (!isRecord(p)) return void problems.push(`${at}: must be an object; dropped.`);
    if (out.length >= PACKAGE_LIMITS.packages) return void problems.push(`${at}: at most ${PACKAGE_LIMITS.packages} packages; dropped.`);
    const why = typeof p.name === "string" ? whyNotPackageName(p.name, out.map((d) => d.name)) : "a package needs a name";
    if (why !== null) return void problems.push(`${at}: ${why}; dropped.`);
    const name = p.name as string;
    for (const key of Object.keys(p)) if (!["name", "include", "preload", "platforms"].includes(key)) problems.push(`${at}.${key}: unknown key; ignored.`);
    const include: string[] = [];
    if (p.include !== undefined && !Array.isArray(p.include)) problems.push(`${at}.include: must be a list of paths and globs; ignored.`);
    for (const [j, inc] of (Array.isArray(p.include) ? p.include : []).entries()) {
      if (typeof inc !== "string" || inc.trim() === "") problems.push(`${at}.include[${j}]: must be a path or glob; dropped.`);
      else if (include.length >= PACKAGE_LIMITS.includes) problems.push(`${at}.include[${j}]: at most ${PACKAGE_LIMITS.includes} entries; dropped.`);
      else if (include.includes(inc)) problems.push(`${at}.include[${j}]: "${inc}" is listed twice; dropped.`);
      else include.push(inc);
    }
    let preload = false;
    if (p.preload !== undefined) {
      if (typeof p.preload === "boolean") preload = p.preload;
      else problems.push(`${at}.preload: must be true or false; using false.`);
    }
    let platforms: ImportPlatform[] | null = null;
    if (p.platforms !== undefined && p.platforms !== null) {
      if (!Array.isArray(p.platforms)) problems.push(`${at}.platforms: must be a list of platforms; using every platform.`);
      else {
        platforms = [];
        for (const pl of p.platforms) {
          if (!(ENCODING_PLATFORMS as readonly unknown[]).includes(pl)) problems.push(`${at}.platforms: unknown platform ${JSON.stringify(pl)} (expected ${ENCODING_PLATFORMS.join(", ")}); skipped.`);
          else if (!platforms.includes(pl as ImportPlatform)) platforms.push(pl as ImportPlatform);
        }
        // Kept in the platforms' fixed order, so a write is stable.
        platforms = ENCODING_PLATFORMS.filter((x) => platforms!.includes(x));
      }
    }
    out.push({ name, include, preload, platforms });
  });
  return out;
}

/** `packages` as written, or null for none (the key is then left out). */
export function packagesToJson(defs: readonly PackageDef[]): Record<string, unknown>[] | null {
  if (defs.length === 0) return null;
  return defs.map((d) => ({
    name: d.name,
    ...(d.preload ? { preload: true } : {}),
    include: [...d.include],
    ...(d.platforms !== null ? { platforms: [...d.platforms] } : {}),
  }));
}

export const defaultPackagingOptions = (): PackagingOptions => ({ strict: true });

/** `audio.json`'s `packaging`; absent is the default (strict). */
export function parsePackagingOptions(raw: unknown, problems: string[], where = "packaging"): PackagingOptions {
  const out = defaultPackagingOptions();
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    problems.push(`${where}: must be an object; using the defaults.`);
    return out;
  }
  for (const key of Object.keys(raw)) if (key !== "strict") problems.push(`${where}.${key}: unknown key; ignored.`);
  if (raw.strict !== undefined) {
    if (typeof raw.strict === "boolean") out.strict = raw.strict;
    else problems.push(`${where}.strict: must be true or false; using true.`);
  }
  return out;
}

/** `packaging` as written, or null at its default (the key is then left out). */
export function packagingOptionsToJson(o: PackagingOptions): Record<string, unknown> | null {
  return o.strict ? null : { strict: false };
}

/** Whether `def` ships on `platform`. */
export const shipsOn = (def: PackageDef, platform: ImportPlatform): boolean => def.platforms === null || def.platforms.includes(platform);

/** What a package holds. */
export interface PackageContents {
  /** Every project path in the package, its includes and their dependencies, sorted. */
  paths: string[];
  /** Include entries that match no file. */
  unmatched: string[];
  /** Dependencies named but not in the project (`from` names them). */
  missing: { path: string; from: string }[];
}

/**
 * What `def` holds among the project's `files`: each include (a path, a folder or a glob) matched against `files`, then
 * every dependency `dependencies` reports, transitively (cycles are fine: each path is visited once).
 */
export function packageContents(def: PackageDef, files: readonly string[], dependencies: (path: string) => readonly string[]): PackageContents {
  const exists = new Set(files);
  const found = new Set<string>();
  const unmatched: string[] = [];
  for (const inc of def.include) {
    const exact = inc.replace(/^\/+/, "");
    let hits = 0;
    if (!hasWildcard(inc) && exists.has(exact)) {
      found.add(exact);
      hits = 1;
    } else {
      const g = compileGlob(inc);
      for (const f of files) if (g.matches(f)) (found.add(f), hits++);
    }
    if (hits === 0) unmatched.push(inc);
  }
  const missing: { path: string; from: string }[] = [];
  const queue = [...found];
  while (queue.length > 0) {
    const from = queue.pop()!;
    for (const dep of dependencies(from)) {
      if (found.has(dep)) continue;
      if (!exists.has(dep)) {
        if (!missing.some((m) => m.path === dep)) missing.push({ path: dep, from });
        continue;
      }
      found.add(dep);
      queue.push(dep);
    }
  }
  return { paths: [...found].sort(), unmatched, missing };
}

/**
 * The dependencies of an audio asset, for `packageContents`: a playlist's named paths (samples, nested playlists,
 * attenuation presets; `playlist/references.ts`), a derived sample's `source` and render (`sample.source`, a project
 * path or a name beside the source). `readJson(path)` gives a file's parsed JSON (undefined when unreadable); other
 * files have none.
 */
export function audioDependencies(readJson: (path: string) => unknown): (path: string) => string[] {
  return (path) => {
    if (isPlaylistPath(path)) {
      const raw = readJson(path);
      if (!isRecord(raw)) return [];
      return referencedPaths(parsePlaylistBody(raw, path, []));
    }
    if (isDerivedSamplePath(path)) {
      const raw = readJson(path);
      if (!isRecord(raw)) return [];
      const out: string[] = [];
      const source = typeof raw.source === "string" && raw.source !== "" ? raw.source : null;
      if (source) out.push(source);
      const render = isRecord(raw.sample) && typeof raw.sample.source === "string" && raw.sample.source !== "" ? raw.sample.source : null;
      if (render) out.push(render.includes("/") || !source ? render : `${source.slice(0, source.lastIndexOf("/") + 1)}${render}`);
      return out;
    }
    return [];
  };
}

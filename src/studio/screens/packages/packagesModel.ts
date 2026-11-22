// The Packages screen's model (ADR 0337 §6, §7; Wwise's SoundBank Manager, FMOD's Banks tab): the packages `audio.json`
// defines, what each holds once its dependencies are added (and why each sound is in: an include, a glob, or another
// sound that needs it), sounds in several packages, sounds in none, and the edits: new, rename, delete, add or remove a
// sound, preload, the platforms it ships on and the project's strict rule. Every edit returns `{ next } | { refused }`
// over `audio.json`'s value; the screen applies it as one undo step of the document. Also the rename's project-wide edit
// (scenes' and prefabs' `AudioPackageLoader.packages`) and the lint of `Audio.package("…")` names in scripts. Pure.
import { ENCODING_PLATFORMS } from "../../../engine/audio/encoding/defaults";
import { compileGlob, hasWildcard } from "../../../engine/audio/encoding/pathGlob";
import { packageContents, shipsOn, whyNotPackageName, PACKAGE_LIMITS, type PackageDef } from "../../../engine/audio/packaging/definitions";
import { isPlaylistPath } from "../../../engine/audio/playlist/format";
import { AUDIO_PROJECT_FILE, type AudioProject } from "../../../engine/audio/project/types";
import { isDerivedSamplePath } from "../../../engine/audio/sample/format";
import type { ImportPlatform } from "../../../engine/scene/importSettings";
import type { ProjectFileEdit } from "../../../editor/projectFileEdits";
import type { EditResult } from "../../../plugins/audio/editor/editResult";
import { AUDIO_FILE } from "../../../export/audio";
import { isRecord, mapObjects } from "../../jsonObjects";

/** What `audio.json` holds of packages. */
export type PackagesDoc = Pick<AudioProject, "packages" | "packaging">;

export const defsOf = (p: PackagesDoc): readonly PackageDef[] => p.packages ?? [];
export const strictOf = (p: PackagesDoc): boolean => p.packaging?.strict ?? true;

/** The kind of an asset a package can hold. */
export type ContentKind = "sample" | "playlist" | "derived" | "other";
export function contentKind(path: string): ContentKind {
  if (isPlaylistPath(path)) return "playlist";
  if (isDerivedSamplePath(path)) return "derived";
  if (AUDIO_FILE.test(path)) return "sample";
  return "other";
}

/** Whether a file is something a package can hold (an audio file, a derived sample, a playlist). */
export const isPackable = (path: string): boolean => contentKind(path) !== "other";

/** One package in the list. */
export interface PackageListRow {
  readonly name: string;
  readonly preload: boolean;
  readonly platforms: readonly ImportPlatform[] | null;
  /** It ships on the screen's platform. */
  readonly ships: boolean;
  /** Assets it holds (dependencies included). */
  readonly count: number;
  /** Includes that match nothing and dependencies missing from the project. */
  readonly problems: number;
}

export function packageList(doc: PackagesDoc, files: readonly string[], deps: (path: string) => readonly string[], platform: ImportPlatform): PackageListRow[] {
  return defsOf(doc).map((def) => {
    const c = packageContents(def, files, deps);
    return { name: def.name, preload: def.preload, platforms: def.platforms, ships: shipsOn(def, platform), count: c.paths.length, problems: c.unmatched.length + c.missing.length };
  });
}

/** One asset in a package. */
export interface ContentRow {
  readonly path: string;
  readonly kind: ContentKind;
  /** The include entry that names it (its own path, or a glob or folder), or null for a dependency. */
  readonly include: string | null;
  /** For a dependency: the asset that needs it (a playlist naming a sample, a derived sample's source). */
  readonly via: string | null;
  /** Other packages holding it too (its bytes are duplicated in each package file). */
  readonly alsoIn: readonly string[];
}

export interface PackageView {
  readonly def: PackageDef;
  readonly rows: readonly ContentRow[];
  readonly unmatched: readonly string[];
  readonly missing: readonly { path: string; from: string }[];
}

/** The include entry of `def` that matches `path`: its exact path first, else the first glob or folder. */
function includeOf(def: PackageDef, path: string): string | null {
  for (const inc of def.include) if (!hasWildcard(inc) && inc.replace(/^\/+/, "") === path) return inc;
  for (const inc of def.include) if (compileGlob(inc).matches(path)) return inc;
  return null;
}

/** Package `name`'s contents with why each asset is in, or null when there's no such package. */
export function packageView(doc: PackagesDoc, name: string, files: readonly string[], deps: (path: string) => readonly string[]): PackageView | null {
  const defs = defsOf(doc);
  const def = defs.find((d) => d.name === name);
  if (!def) return null;
  const c = packageContents(def, files, deps);
  const held = new Set(c.paths);
  // Why each dependency is in: the first held asset (breadth first from the includes) that names it.
  const via = new Map<string, string>();
  const direct = c.paths.filter((p) => includeOf(def, p) !== null);
  const queue = [...direct];
  const seen = new Set(direct);
  while (queue.length > 0) {
    const from = queue.shift()!;
    for (const dep of deps(from)) {
      if (!held.has(dep) || seen.has(dep)) continue;
      seen.add(dep);
      via.set(dep, from);
      queue.push(dep);
    }
  }
  const others = defs.filter((d) => d !== def).map((d) => ({ name: d.name, paths: new Set(packageContents(d, files, deps).paths) }));
  const rows = c.paths.map((path): ContentRow => ({
    path,
    kind: contentKind(path),
    include: includeOf(def, path),
    via: via.get(path) ?? null,
    alsoIn: others.filter((o) => o.paths.has(path)).map((o) => o.name),
  }));
  return { def, rows, unmatched: c.unmatched, missing: c.missing };
}

/** Packable assets in no package (shipped loose, loaded on demand), sorted. */
export function looseAssets(doc: PackagesDoc, files: readonly string[], deps: (path: string) => readonly string[]): string[] {
  const held = new Set<string>();
  for (const def of defsOf(doc)) for (const p of packageContents(def, files, deps).paths) held.add(p);
  return files.filter((f) => isPackable(f) && !held.has(f)).sort();
}

// --- edits ------------------------------------------------------------------------------------------------------------

const withDefs = (p: AudioProject, defs: PackageDef[]): AudioProject => {
  const next = { ...p };
  if (defs.length > 0) next.packages = defs;
  else delete next.packages;
  return next;
};
const editDef = (p: AudioProject, name: string, change: (d: PackageDef) => EditResult<PackageDef>): EditResult<AudioProject> => {
  const defs = defsOf(p);
  const i = defs.findIndex((d) => d.name === name);
  if (i < 0) return { refused: `there's no package named "${name}"` };
  const r = change(defs[i]!);
  if ("refused" in r) return r;
  if (r.next === defs[i]) return { next: p };
  return { next: withDefs(p, defs.map((d, j) => (j === i ? r.next : d))) };
};

/** A name for a new package: `base`, else `base 2`, `base 3`… */
export function freshPackageName(doc: PackagesDoc, base = "Package"): string {
  const names = new Set(defsOf(doc).map((d) => d.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

export function addPackage(p: AudioProject, name = freshPackageName(p)): EditResult<AudioProject> {
  const defs = defsOf(p);
  if (defs.length >= PACKAGE_LIMITS.packages) return { refused: `a project has at most ${PACKAGE_LIMITS.packages} packages` };
  const why = whyNotPackageName(name, defs.map((d) => d.name));
  if (why) return { refused: why };
  return { next: withDefs(p, [...defs, { name, include: [], preload: false, platforms: null }]) };
}

export function renamePackage(p: AudioProject, from: string, to: string): EditResult<AudioProject> {
  if (from === to) return { next: p };
  const why = whyNotPackageName(to, defsOf(p).filter((d) => d.name !== from).map((d) => d.name));
  if (why) return { refused: why };
  return editDef(p, from, (d) => ({ next: { ...d, name: to } }));
}

export function deletePackage(p: AudioProject, name: string): EditResult<AudioProject> {
  const defs = defsOf(p);
  if (!defs.some((d) => d.name === name)) return { refused: `there's no package named "${name}"` };
  return { next: withDefs(p, defs.filter((d) => d.name !== name)) };
}

/** Add `path` (a sound, a derived sample, a playlist, or a glob) to package `name`'s includes. */
export function addToPackage(p: AudioProject, name: string, path: string): EditResult<AudioProject> {
  return editDef(p, name, (d) => {
    if (path.trim() === "") return { refused: "name a sound, a playlist or a glob" };
    if (d.include.includes(path)) return { refused: `${path} is already listed in "${name}"` };
    if (d.include.length >= PACKAGE_LIMITS.includes) return { refused: `a package lists at most ${PACKAGE_LIMITS.includes} entries` };
    if (!hasWildcard(path) && !isPackable(path)) return { refused: "only sounds, derived samples and playlists go in a package" };
    return { next: { ...d, include: [...d.include, path] } };
  });
}

/**
 * Remove `path` from package `name`: its own include entry. A sound a glob or folder catches, or one another asset needs,
 * can't be removed alone: the refusal says which entry or asset holds it.
 */
export function removeFromPackage(p: AudioProject, name: string, path: string, deps?: { files: readonly string[]; deps: (path: string) => readonly string[] }): EditResult<AudioProject> {
  return editDef(p, name, (d) => {
    if (d.include.includes(path)) return { next: { ...d, include: d.include.filter((i) => i !== path) } };
    const inc = includeOf(d, path);
    if (inc) return { refused: `${path} is caught by "${inc}"; edit that entry instead` };
    if (deps) {
      const row = packageView({ packages: [d] }, d.name, deps.files, deps.deps)?.rows.find((r) => r.path === path);
      if (row?.via) return { refused: `${row.via} needs ${path}, so it stays while ${row.via} is in the package` };
    }
    return { refused: `${path} isn't listed in "${name}"` };
  });
}

/** Remove one include entry (a path or a glob) of package `name`. */
export function removeInclude(p: AudioProject, name: string, include: string): EditResult<AudioProject> {
  return editDef(p, name, (d) => (d.include.includes(include) ? { next: { ...d, include: d.include.filter((i) => i !== include) } } : { refused: `"${include}" isn't listed in "${name}"` }));
}

export function setPreload(p: AudioProject, name: string, preload: boolean): EditResult<AudioProject> {
  return editDef(p, name, (d) => ({ next: d.preload === preload ? d : { ...d, preload } }));
}

/** Ship package `name` on `platform` or not; every platform again is `null` (absent in the file). */
export function setShipsOn(p: AudioProject, name: string, platform: ImportPlatform, on: boolean): EditResult<AudioProject> {
  return editDef(p, name, (d) => {
    const now = d.platforms ?? [...ENCODING_PLATFORMS];
    const next = ENCODING_PLATFORMS.filter((x) => (x === platform ? on : now.includes(x)));
    if (next.length === 0) return { refused: "a package ships on at least one platform (delete it instead)" };
    const platforms = next.length === ENCODING_PLATFORMS.length ? null : next;
    return { next: JSON.stringify(platforms) === JSON.stringify(d.platforms) ? d : { ...d, platforms } };
  });
}

/** The project's strict rule (ADR 0337 §7): a packaged sound whose packages are all unloaded is refused. */
export function setStrict(p: AudioProject, strict: boolean): EditResult<AudioProject> {
  if (strictOf(p) === strict) return { next: p };
  const next = { ...p };
  if (strict) delete next.packaging;
  else next.packaging = { strict: false };
  return { next };
}

// --- renames and lint ---------------------------------------------------------------------------------------------------

/** The component whose `packages` list names packages (ADR 0337 §9). */
export const PACKAGE_LOADER = "engine.AudioPackageLoader";

const renamed = (list: unknown, from: string, to: string): unknown =>
  Array.isArray(list) && list.includes(from) ? list.map((n) => (n === from ? to : n)) : list;

/** A scene or prefab file's JSON with `AudioPackageLoader.packages` (component data and prefab overrides) renamed. */
export function renamePackageInScene(json: unknown, from: string, to: string): unknown {
  return mapObjects(json, (o) => {
    // A component entry: { type, data }.
    if (o.type === PACKAGE_LOADER && isRecord(o.data)) {
      const list = renamed(o.data.packages, from, to);
      return list === o.data.packages ? o : { ...o, data: { ...o.data, packages: list } };
    }
    // A prefab override: { target, component, field, value } of the whole list or one entry.
    if (o.component === PACKAGE_LOADER && typeof o.field === "string" && /^packages(\.\d+|\[\d+\])?$/.test(o.field)) {
      if (o.field === "packages") {
        const list = renamed(o.value, from, to);
        return list === o.value ? o : { ...o, value: list };
      }
      return o.value === from ? { ...o, value: to } : o;
    }
    return o;
  });
}

/** The project-wide edit renaming package `from` to `to` outside `audio.json` (scenes and prefabs; ADR 0262). */
export function packageRenameEdit(from: string, to: string): ProjectFileEdit {
  return {
    mentioned: (text) => text.includes(PACKAGE_LOADER) && text.includes(JSON.stringify(from)),
    scene: (file) => {
      const next = renamePackageInScene(file, from, to);
      return next === file ? null : (next as typeof file);
    },
    settings: () => null,
    json: (json, path) => (path === AUDIO_PROJECT_FILE ? null : (() => {
      const next = renamePackageInScene(json, from, to);
      return next === json ? null : next;
    })()),
  };
}

/** A script's `Audio.package("…")` naming no package. */
export interface PackageNameLint {
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  readonly name: string;
}

/** `Audio.package("Forest")`, with any quote (a template literal only without `${`). */
const PACKAGE_CALL = /\bAudio\s*\.\s*package\s*\(\s*(["'`])((?:(?!\1)[^\\\n$]|\\.)*)\1\s*\)/g;

/**
 * Best effort (ADR 0337 §7): every `Audio.package("…")` string literal in `scripts` (path → source) that names no
 * package in `names`. Names built at run time aren't seen.
 */
export function lintPackageNames(scripts: ReadonlyMap<string, string> | Iterable<readonly [string, string]>, names: readonly string[]): PackageNameLint[] {
  const known = new Set(names);
  const out: PackageNameLint[] = [];
  for (const [path, source] of scripts) {
    for (const m of source.matchAll(PACKAGE_CALL)) {
      const name = m[2]!;
      if (known.has(name)) continue;
      const line = source.slice(0, m.index).split("\n").length;
      out.push({ path, line, name });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

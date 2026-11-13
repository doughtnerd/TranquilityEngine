// Saved layouts (ADR 0174), the pure part: one `<slug>.layout.json` file per layout, holding its name
// and a tree of versions like the scene's undo tree (ADR 0027). Saving over a layout adds a version
// as a child of `head` and moves `head` to it; restoring moves `head` back to any version, and the
// next save branches from there. Nothing is deleted except the oldest versions past `MAX_VERSIONS`
// (never `head`; old branches before head's own line). A layout can live in the project (`.layouts/`), in per-user
// storage, or both; `mergeSaved` lists each file name once, with the newer copy.
import { layoutShape, parseLayout, type Layout } from "./model";

export const LAYOUT_FORMAT = "myco.layout@1";
export const LAYOUT_EXTENSION = ".layout.json";
/** The project folder project layouts live in (hidden: the Assets panel and exports skip dot-folders). */
export const LAYOUTS_FOLDER = ".layouts";
/** Versions kept per layout file. */
export const MAX_VERSIONS = 50;

export type LayoutScope = "user" | "project";

export interface LayoutVersion {
  seq: number;
  /** The version it was saved over (0 for the first). */
  parent: number;
  /** When it was saved (ms since the epoch). */
  savedAt: number;
  /** What made it ("Saved", "Removed the Sky plugin's panels"…). */
  label: string;
  layout: Layout;
}

export interface LayoutFile {
  format: typeof LAYOUT_FORMAT;
  name: string;
  /** The version the layout means now. */
  head: number;
  versions: LayoutVersion[];
}

/** A saved layout as the Layouts menu lists it: one file name, in one or both places. */
export interface SavedLayout {
  /** `<slug>.layout.json`: its identity in both places. */
  file: string;
  /** The display name (of the newer copy). */
  name: string;
  user?: LayoutFile;
  project?: LayoutFile;
  /** The copy the menu applies: the one whose head was saved last. */
  newest: LayoutFile;
}

/** What a layout is saved as: its arrangement, instance types and plugin panel titles (no view state, which isn't in it anyway). */
const forSaving = (layout: Layout): Layout => structuredClone(layout);

/** A new layout file whose first version is `layout`. */
export function newLayoutFile(name: string, layout: Layout, now = Date.now(), label = "Saved"): LayoutFile {
  return { format: LAYOUT_FORMAT, name, head: 1, versions: [{ seq: 1, parent: 0, savedAt: now, label, layout: forSaving(layout) }] };
}

/** The file with `layout` saved over it: a new version, child of `head`, which becomes `head`. Pruned to `MAX_VERSIONS`. */
export function addVersion(file: LayoutFile, layout: Layout, now = Date.now(), label = "Saved"): LayoutFile {
  const seq = Math.max(0, ...file.versions.map((v) => v.seq)) + 1;
  return pruneVersions({ ...file, head: seq, versions: [...file.versions, { seq, parent: file.head, savedAt: now, label, layout: forSaving(layout) }] });
}

/** The file with `head` moved to version `seq` (nothing else changes). Unchanged when there's no such version. */
export function restoreVersion(file: LayoutFile, seq: number): LayoutFile {
  return file.versions.some((v) => v.seq === seq) ? { ...file, head: seq } : file;
}

/** A version of the file (its head by default). */
export function versionOf(file: LayoutFile, seq = file.head): LayoutVersion | undefined {
  return file.versions.find((v) => v.seq === seq);
}

/** The layout a version holds, checked and brought up to date (`parseLayout`), or null when it's unreadable. */
export function layoutOf(file: LayoutFile, seq = file.head): Layout | null {
  const v = versionOf(file, seq);
  return v ? parseLayout(v.layout) : null;
}

/**
 * Drop versions past `max`, never `head`: first the oldest versions off head's line (old branches), then
 * the oldest of head's ancestors. A dropped version's children hang from its parent (or become roots).
 */
export function pruneVersions(file: LayoutFile, max = MAX_VERSIONS): LayoutFile {
  if (file.versions.length <= max) return file;
  const bySeq = new Map(file.versions.map((v) => [v.seq, v]));
  const keep = new Set<number>();
  for (let v = bySeq.get(file.head); v && !keep.has(v.seq); v = bySeq.get(v.parent)) keep.add(v.seq);
  const oldest = (a: LayoutVersion, b: LayoutVersion) => a.savedAt - b.savedAt || a.seq - b.seq;
  const candidates = [...file.versions.filter((v) => !keep.has(v.seq)).sort(oldest), ...file.versions.filter((v) => keep.has(v.seq) && v.seq !== file.head).sort(oldest)];
  const drop = new Set(candidates.slice(0, file.versions.length - max).map((v) => v.seq));
  const parentOf = (seq: number): number => {
    let p = bySeq.get(seq)?.parent ?? 0;
    while (drop.has(p)) p = bySeq.get(p)?.parent ?? 0;
    return p;
  };
  return { ...file, versions: file.versions.filter((v) => !drop.has(v.seq)).map((v) => ({ ...v, parent: parentOf(v.seq) })) };
}

/** A layout file read from disk or storage, checked; null if it isn't one. (Each version's layout is checked when used.) */
export function parseLayoutFile(value: unknown): LayoutFile | null {
  try {
    const f = (typeof value === "string" ? JSON.parse(value) : structuredClone(value)) as LayoutFile;
    if (!f || f.format !== LAYOUT_FORMAT || typeof f.name !== "string" || !Array.isArray(f.versions) || f.versions.length === 0) return null;
    const seqs = new Set<number>();
    for (const v of f.versions) {
      if (!v || typeof v.seq !== "number" || typeof v.parent !== "number" || seqs.has(v.seq) || !v.layout || typeof v.layout !== "object") return null;
      if (typeof v.savedAt !== "number") v.savedAt = 0;
      if (typeof v.label !== "string") v.label = "Saved";
      seqs.add(v.seq);
    }
    if (!seqs.has(f.head)) f.head = Math.max(...seqs);
    return f;
  } catch {
    return null;
  }
}

/** A layout file's text: readable JSON, so a project's layouts diff well in version control. */
export const layoutFileText = (file: LayoutFile): string => `${JSON.stringify(file, null, 2)}\n`;

/** A file-name slug for a layout name: "My Layout!" → "my-layout". */
export function slugOf(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "layout";
}

/** The file name for a new layout called `name`, numbered when `taken` already has it ("custom-2.layout.json"). */
export function fileNameFor(name: string, taken: ReadonlySet<string>): string {
  const slug = slugOf(name);
  for (let n = 1; ; n++) {
    const file = `${n === 1 ? slug : `${slug}-${n}`}${LAYOUT_EXTENSION}`;
    if (!taken.has(file)) return file;
  }
}

/** True for a name a layout file can have (`something.layout.json`, no folders). */
export const isLayoutFileName = (name: string): boolean => name.endsWith(LAYOUT_EXTENSION) && name.length > LAYOUT_EXTENSION.length && !/[\\/]/.test(name);

const headTime = (f: LayoutFile) => versionOf(f)?.savedAt ?? 0;

/** The layouts in both places, one entry per file name, sorted by name; each with its newer copy. */
export function mergeSaved(user: ReadonlyMap<string, LayoutFile>, project: ReadonlyMap<string, LayoutFile>): SavedLayout[] {
  const files = new Set([...user.keys(), ...project.keys()]);
  const out: SavedLayout[] = [];
  for (const file of files) {
    const u = user.get(file), p = project.get(file);
    const newest = u && p ? (headTime(p) > headTime(u) ? p : u) : (u ?? p)!;
    out.push({ file, name: newest.name, user: u, project: p, newest });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
}

/** The scopes a saved layout is in. */
export const scopesOf = (s: SavedLayout): LayoutScope[] => [...(s.user ? (["user"] as const) : []), ...(s.project ? (["project"] as const) : [])];

/** How the menu names a layout's place: "User", "Project" or "User + Project". */
export function scopeLabel(scopes: readonly LayoutScope[]): string {
  return scopes.length === 2 ? "User + Project" : scopes[0] === "project" ? "Project" : "User";
}

/** True when `layout` arranges the same panel types as the file's head (sizes and instance ids aside): not modified. */
export function matchesHead(file: LayoutFile, layout: Layout): boolean {
  const head = layoutOf(file);
  return head !== null && layoutShape(head) === layoutShape(layout);
}

// The Snapshots panel's tree (ADR 0344 snapshots `folder`; the prototype's snapshot file system): snapshots by folder,
// search by name and trigger text, and the edits: new, rename, duplicate, move, delete, and folders (new, rename,
// move, delete moving their contents up). A folder exists while a snapshot is in it or `audio.json` keeps it empty
// (`snapshotFolders`), so every folder edit is an edit of the file: saved, and undone like any other ("New folder",
// "Rename folder", "Move folder", "Delete folder"). Folders and snapshots are listed alphabetically (spec §1.3).
// Pure: every edit returns `{ next } | { refused }`.
import type { ParameterDef } from "../../../engine/audio/parameters";
import { DEFAULT_SNAPSHOT_FADE_MS, DEFAULT_SNAPSHOT_PRIORITY, MIX_LIMITS } from "../../../engine/audio/project/format";
import type { AudioProject, Snapshot } from "../../../engine/audio/project/types";
import { uniqueName } from "../../../engine/core/uniqueName";
import type { EditResult } from "./busTree";
import { triggerText } from "./snapshotBlend";

export type SnapshotNode =
  | { readonly kind: "folder"; readonly path: string; readonly name: string; readonly children: readonly SnapshotNode[]; readonly count: number }
  | { readonly kind: "snapshot"; readonly name: string; readonly folder: string; readonly trigger: string };

type Mix = Pick<AudioProject, "snapshots" | "snapshotFolders">;

const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentFolder = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const norm = (folder: string) => folder.split("/").map((s) => s.trim()).filter((s) => s !== "").join("/");
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
const inFolder = (folder: string, path: string) => path === folder || path.startsWith(`${folder}/`);

/** Every folder: the snapshots' folders, the kept empty ones, and their parents. */
export function snapshotFolders(p: Mix): string[] {
  const out = new Set<string>();
  for (const f of [...p.snapshots.map((s) => s.folder), ...(p.snapshotFolders ?? [])]) {
    const parts = norm(f).split("/").filter((s) => s !== "");
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return [...out].sort(byName);
}

/**
 * `p` with `folders` kept: the ones a snapshot is in (or under) or a deeper kept folder implies aren't listed, and an
 * empty list leaves the key out (as the file writes it).
 */
function withFolders<P extends Mix>(p: P, folders: readonly string[]): P {
  const all = [...new Set(folders.map(norm).filter((f) => f !== ""))];
  const used = (f: string) => p.snapshots.some((s) => inFolder(f, norm(s.folder))) || all.some((o) => o !== f && o.startsWith(`${f}/`));
  const keep = all.filter((f) => !used(f)).sort(byName);
  const { snapshotFolders: _old, ...rest } = p;
  return (keep.length > 0 ? { ...rest, snapshotFolders: keep } : rest) as P;
}

/** The snapshots as a tree: folders first, then snapshots, each alphabetically. */
export function snapshotTree(p: Mix, params: readonly ParameterDef[] = []): SnapshotNode[] {
  const folders = snapshotFolders(p);
  const build = (folder: string): SnapshotNode[] => [
    ...folders
      .filter((f) => parentFolder(f) === folder)
      .map((f): SnapshotNode => {
        const children = build(f);
        return { kind: "folder", path: f, name: leaf(f), children, count: children.length };
      }),
    ...p.snapshots
      .filter((s) => norm(s.folder) === folder)
      .sort((a, b) => byName(a.name, b.name))
      .map((s): SnapshotNode => ({ kind: "snapshot", name: s.name, folder: norm(s.folder), trigger: triggerText(s.start, params) })),
  ];
  return build("");
}

/** Snapshots matching `query` by name or trigger text (case-insensitive), by name, with their folder for display. */
export function searchSnapshots(snapshots: readonly Snapshot[], query: string, params: readonly ParameterDef[] = []): { name: string; path: string; folder: string; trigger: string }[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  return snapshots
    .filter((s) => s.name.toLowerCase().includes(q) || triggerText(s.start, params).toLowerCase().includes(q))
    .sort((a, b) => byName(a.name, b.name))
    .map((s) => ({ name: s.name, path: norm(s.folder) ? `${norm(s.folder)}/${s.name}` : s.name, folder: norm(s.folder), trigger: triggerText(s.start, params) }));
}

/** `p` with `snapshots`, keeping every folder it had (a folder emptied by a move or delete stays). */
const withSnapshots = (p: AudioProject, snapshots: Snapshot[]): AudioProject => withFolders({ ...p, snapshots }, snapshotFolders(p));

/** A new snapshot from code with nothing in it, in `folder` ("New snapshot"). */
export function newSnapshot(p: AudioProject, folder: string, base = "New snapshot"): EditResult<{ project: AudioProject; name: string }> {
  if (p.snapshots.length >= MIX_LIMITS.snapshots) return { refused: `a mix has at most ${MIX_LIMITS.snapshots} snapshots` };
  const name = uniqueName(base, p.snapshots.map((s) => s.name));
  const snap: Snapshot = { name, folder: norm(folder), start: { kind: "code" }, fadeInMs: DEFAULT_SNAPSHOT_FADE_MS, fadeOutMs: DEFAULT_SNAPSHOT_FADE_MS, holdMs: 0, priority: DEFAULT_SNAPSHOT_PRIORITY, combine: "override", buses: {}, effects: {} };
  return { next: { project: withSnapshots(p, [...p.snapshots, snap]), name } };
}

/** Why snapshot `from` can't be named `to` (null when it can or the name is the same). */
export function whyNotRenameSnapshot(p: AudioProject, from: string, to: string): string | null {
  if (!p.snapshots.some((s) => s.name === from)) return `there's no snapshot "${from}"`;
  if (to.trim() === "") return "a name can't be empty";
  if (to !== to.trim()) return "a name can't start or end with a space";
  if (to !== from && p.snapshots.some((s) => s.name === to)) return `another snapshot is named "${to}"`;
  return null;
}

/** Snapshot `from` renamed `to` ("Rename snapshot"). Scripts that start it by name keep the old name. */
export function renameSnapshot(p: AudioProject, from: string, to: string): EditResult<AudioProject> {
  const why = whyNotRenameSnapshot(p, from, to);
  if (why) return { refused: why };
  if (from === to) return { next: p };
  return { next: withSnapshots(p, p.snapshots.map((s) => (s.name === from ? { ...s, name: to } : s))) };
}

/** A copy of `name` right after it, named "<name> copy" ("Duplicate snapshot"). A base mix copy starts from code. */
export function duplicateSnapshot(p: AudioProject, name: string): EditResult<{ project: AudioProject; name: string }> {
  const at = p.snapshots.findIndex((s) => s.name === name);
  if (at < 0) return { refused: `there's no snapshot "${name}"` };
  if (p.snapshots.length >= MIX_LIMITS.snapshots) return { refused: `a mix has at most ${MIX_LIMITS.snapshots} snapshots` };
  const src = p.snapshots[at]!;
  const copy: Snapshot = { ...structuredClone(src), name: uniqueName(`${name} copy`, p.snapshots.map((s) => s.name)) };
  if (copy.start.kind === "base") copy.start = { kind: "code" };
  const list = [...p.snapshots];
  list.splice(at + 1, 0, copy);
  return { next: { project: withSnapshots(p, list), name: copy.name } };
}

/** Snapshot `name` moved into `folder` ("Move snapshot"). The folder it leaves stays. */
export function moveSnapshot(p: AudioProject, name: string, folder: string): EditResult<AudioProject> {
  const s = p.snapshots.find((x) => x.name === name);
  if (!s) return { refused: `there's no snapshot "${name}"` };
  const to = norm(folder);
  if (norm(s.folder) === to) return { refused: `${name} is already ${to ? `in ${to}` : "at the top level"}` };
  return { next: withSnapshots(p, p.snapshots.map((x) => (x === s ? { ...x, folder: to } : x))) };
}

/** Snapshot `name` deleted ("Delete snapshot"). Its folder stays. */
export function deleteSnapshot(p: AudioProject, name: string): EditResult<AudioProject> {
  if (!p.snapshots.some((s) => s.name === name)) return { refused: `there's no snapshot "${name}"` };
  return { next: withSnapshots(p, p.snapshots.filter((s) => s.name !== name)) };
}

/** A fresh folder name under `parent` ("New folder", numbered). */
export const newFolderPath = (p: Mix, parent: string): string => {
  const taken = snapshotFolders(p).filter((f) => parentFolder(f) === norm(parent)).map(leaf);
  const name = uniqueName("New folder", taken);
  return norm(parent) ? `${norm(parent)}/${name}` : name;
};

/** A new empty folder under `parent` ("New folder"), and its path. */
export function addFolder(p: AudioProject, parent: string): EditResult<{ project: AudioProject; path: string }> {
  const path = newFolderPath(p, parent);
  return { next: { project: withFolders(p, [...snapshotFolders(p), path]), path } };
}

/** Every folder of `p` with `from` (and what's inside it) moved to `to`. */
const followed = (p: Mix, from: string, to: string) => snapshotFolders(p).map((f) => followFolder(f, from, to));
const moveInside = (s: Snapshot, from: string, to: string): Snapshot => (inFolder(from, norm(s.folder)) ? { ...s, folder: followFolder(norm(s.folder), from, to) } : s);

/** Folder `from` renamed (its last part) to `name`; what's inside follows ("Rename folder"). With its new path. */
export function renameFolder(p: AudioProject, from: string, name: string): EditResult<{ project: AudioProject; path: string }> {
  const clean = name.trim();
  if (clean === "" || clean.includes("/")) return { refused: "a folder name can't be empty or hold a /" };
  if (!snapshotFolders(p).includes(from)) return { refused: `there's no folder "${from}"` };
  const to = parentFolder(from) ? `${parentFolder(from)}/${clean}` : clean;
  if (to === from) return { next: { project: p, path: from } };
  if (snapshotFolders(p).includes(to)) return { refused: `there's already a folder "${to}"` };
  return { next: { project: withFolders({ ...p, snapshots: p.snapshots.map((s) => moveInside(s, from, to)) }, followed(p, from, to)), path: to } };
}

/** Where folder `path` is after folder `from` became `to` (a rename, a move, or a delete moving its contents up to `to`). */
export const followFolder = (path: string, from: string, to: string): string => (inFolder(from, path) ? norm(to + path.slice(from.length)) : path);

/** Where folder `folder` lands when it moves into `into` (`moveFolder`). */
export const movedFolderPath = (folder: string, into: string): string => (norm(into) ? `${norm(into)}/${leaf(folder)}` : leaf(folder));

/** Folder `folder` moved into `into` ("Move folder"); refused into itself or a folder inside it. With its new path. */
export function moveFolder(p: AudioProject, folder: string, into: string): EditResult<{ project: AudioProject; path: string }> {
  const target = norm(into);
  if (!snapshotFolders(p).includes(folder)) return { refused: `there's no folder "${folder}"` };
  if (inFolder(folder, target)) return { refused: "a folder can't move into itself" };
  if (parentFolder(folder) === target) return { refused: `${leaf(folder)} is already there` };
  const to = movedFolderPath(folder, target);
  if (snapshotFolders(p).includes(to)) return { refused: `there's already a folder "${to}"` };
  return { next: { project: withFolders({ ...p, snapshots: p.snapshots.map((s) => moveInside(s, folder, to)) }, followed(p, folder, to)), path: to } };
}

/** Folder `folder` deleted: what was in it moves up to its parent ("Delete folder"). */
export function deleteFolder(p: AudioProject, folder: string): EditResult<AudioProject> {
  if (!snapshotFolders(p).includes(folder)) return { refused: `there's no folder "${folder}"` };
  const up = parentFolder(folder);
  const folders = snapshotFolders(p).filter((f) => f !== folder).map((f) => followFolder(f, folder, up));
  return { next: withFolders({ ...p, snapshots: p.snapshots.map((s) => moveInside(s, folder, up)) }, folders) };
}

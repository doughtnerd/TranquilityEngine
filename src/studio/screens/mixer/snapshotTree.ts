// The Snapshots panel's tree (ADR 0330 snapshots `folder`; the prototype's snapshot file system): snapshots by folder,
// search by name and trigger text, and the edits: new, rename, duplicate, move, delete, and folders (new, rename,
// delete moving their contents up). A folder exists while a snapshot is in it; a folder made empty in this session is
// kept by the panel (`extraFolders`) until something moves in, as `audio.json` stores folders only on snapshots.
// Pure: every edit returns `{ next } | { refused }`.
import { DEFAULT_SNAPSHOT_FADE_MS, DEFAULT_SNAPSHOT_PRIORITY, MIX_LIMITS } from "../../../engine/audio/project/format";
import type { AudioProject, Snapshot } from "../../../engine/audio/project/types";
import { uniqueName } from "../../../engine/core/uniqueName";
import type { EditResult } from "./busTree";
import { triggerText } from "./snapshotBlend";

export type SnapshotNode =
  | { readonly kind: "folder"; readonly path: string; readonly name: string; readonly children: readonly SnapshotNode[] }
  | { readonly kind: "snapshot"; readonly name: string; readonly folder: string; readonly trigger: string };

const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentFolder = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const norm = (folder: string) => folder.split("/").map((s) => s.trim()).filter((s) => s !== "").join("/");

/** Every folder: the snapshots' folders, their parents, and `extra`. */
export function snapshotFolders(snapshots: readonly Pick<Snapshot, "folder">[], extra: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const f of [...snapshots.map((s) => s.folder), ...extra]) {
    const parts = norm(f).split("/").filter((s) => s !== "");
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** The snapshots as a tree: folders first (by name), then snapshots in list order. */
export function snapshotTree(snapshots: readonly Snapshot[], extra: readonly string[] = []): SnapshotNode[] {
  const folders = snapshotFolders(snapshots, extra);
  const build = (folder: string): SnapshotNode[] => [
    ...folders.filter((f) => parentFolder(f) === folder).map((f): SnapshotNode => ({ kind: "folder", path: f, name: leaf(f), children: build(f) })),
    ...snapshots.filter((s) => norm(s.folder) === folder).map((s): SnapshotNode => ({ kind: "snapshot", name: s.name, folder: norm(s.folder), trigger: triggerText(s.start) })),
  ];
  return build("");
}

/** Snapshots matching `query` by name or trigger text (case-insensitive), with their folder path for display. */
export function searchSnapshots(snapshots: readonly Snapshot[], query: string): { name: string; path: string; trigger: string }[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  return snapshots
    .filter((s) => s.name.toLowerCase().includes(q) || triggerText(s.start).toLowerCase().includes(q))
    .map((s) => ({ name: s.name, path: norm(s.folder) ? `${norm(s.folder)}/${s.name}` : s.name, trigger: triggerText(s.start) }));
}

const withSnapshots = (p: AudioProject, snapshots: Snapshot[]): AudioProject => ({ ...p, snapshots });

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

/** Snapshot `name` moved into `folder` ("Move snapshot"). */
export function moveSnapshot(p: AudioProject, name: string, folder: string): EditResult<AudioProject> {
  const s = p.snapshots.find((x) => x.name === name);
  if (!s) return { refused: `there's no snapshot "${name}"` };
  const to = norm(folder);
  if (norm(s.folder) === to) return { refused: `${name} is already ${to ? `in ${to}` : "at the top level"}` };
  return { next: withSnapshots(p, p.snapshots.map((x) => (x === s ? { ...x, folder: to } : x))) };
}

/** Snapshot `name` deleted ("Delete snapshot"). */
export function deleteSnapshot(p: AudioProject, name: string): EditResult<AudioProject> {
  if (!p.snapshots.some((s) => s.name === name)) return { refused: `there's no snapshot "${name}"` };
  return { next: withSnapshots(p, p.snapshots.filter((s) => s.name !== name)) };
}

const inFolder = (folder: string, path: string) => path === folder || path.startsWith(`${folder}/`);

/** Folder `from` renamed (its last part) to `name`; snapshots inside follow ("Snapshot folders"). */
export function renameFolder(p: AudioProject, from: string, name: string, extra: readonly string[] = []): EditResult<AudioProject> {
  const clean = name.trim();
  if (clean === "" || clean.includes("/")) return { refused: "a folder name can't be empty or hold a /" };
  const to = parentFolder(from) ? `${parentFolder(from)}/${clean}` : clean;
  if (to === from) return { next: p };
  if (snapshotFolders(p.snapshots, extra).includes(to)) return { refused: `there's already a folder "${to}"` };
  return { next: withSnapshots(p, p.snapshots.map((s) => (inFolder(from, norm(s.folder)) ? { ...s, folder: to + norm(s.folder).slice(from.length) } : s))) };
}

/** Folder `folder` moved into `into` ("Move snapshot"); refused into itself or a folder inside it. */
export function moveFolder(p: AudioProject, folder: string, into: string): EditResult<AudioProject> {
  const target = norm(into);
  if (inFolder(folder, target)) return { refused: "a folder can't move into itself" };
  if (parentFolder(folder) === target) return { refused: `${leaf(folder)} is already there` };
  const to = target ? `${target}/${leaf(folder)}` : leaf(folder);
  return { next: withSnapshots(p, p.snapshots.map((s) => (inFolder(folder, norm(s.folder)) ? { ...s, folder: to + norm(s.folder).slice(folder.length) } : s))) };
}

/** Folder `folder` deleted: what was in it moves up to its parent ("Snapshot folders"). */
export function deleteFolder(p: AudioProject, folder: string): EditResult<AudioProject> {
  const up = parentFolder(folder);
  return {
    next: withSnapshots(p, p.snapshots.map((s) => {
      const f = norm(s.folder);
      if (!inFolder(folder, f)) return s;
      const rest = f.slice(folder.length).replace(/^\//, "");
      return { ...s, folder: [up, rest].filter((x) => x !== "").join("/") };
    })),
  };
}

/** A fresh folder name under `parent` ("New folder", numbered). */
export const newFolderPath = (p: Pick<AudioProject, "snapshots">, parent: string, extra: readonly string[] = []): string => {
  const taken = snapshotFolders(p.snapshots, extra).filter((f) => parentFolder(f) === norm(parent)).map(leaf);
  const name = uniqueName("New folder", taken);
  return norm(parent) ? `${norm(parent)}/${name}` : name;
};

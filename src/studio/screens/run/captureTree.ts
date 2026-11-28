// The Takes and Captures panels' tree, shared by the Run screens from `screens/run/` (ADR 0348, 0445; the prototype's
// captures file system): the project's recordings (`*.sporesample`, ADR 0409: every one holds a profile, and a take's
// also holds what the game asked of audio) by folder, wherever they are, or while searching the matches by path. Saved
// and imported recordings go to `recordings/`. Pure.

import { contentFolders } from "../../components/projectFolders";

/** ADR 0409: the one recording file type, for takes and captures alike (the header's take flag tells them apart). */
export const RECORDING_SUFFIX = ".sporesample";

/** The files the Profiler opens. */
export const CAPTURE_SUFFIXES = [RECORDING_SUFFIX] as const;

/** ADR 0409: where the Studio, the editor and game builds save recordings, takes and captures alike. */
export const RECORDINGS_FOLDER = "recordings";

/** Where the Studio saves and imports captures (`RECORDINGS_FOLDER`). */
export const CAPTURES_FOLDER = RECORDINGS_FOLDER;

/** The empty state's words. */
/**
 * How to get a capture, under "No captures yet" (sentence case, UI pass T4): the Studio's own Record first (it records
 * while a playlist auditions or a take replays, `whyNotRecord`), then the editor's Play toolbar and a game build.
 */
export const NO_CAPTURES = "Record one here while a playlist or a take plays, or with F9 in a game build.";

export const isCapturePath = (path: string): boolean => {
  const lower = path.toLowerCase();
  return CAPTURE_SUFFIXES.some((s) => lower.endsWith(s));
};

/** A recording the Take screen lists (every `*.sporesample`; one without take data says so when opened, ADR 0409). */
export const isTakePath = (path: string): boolean => path.toLowerCase().endsWith(RECORDING_SUFFIX);

/** A recording the Captures tree lists: every `*.sporesample` (each holds a profile, ADR 0409). */
export const isCaptureFile = (path: string): boolean => path.toLowerCase().endsWith(RECORDING_SUFFIX);

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** A capture's name without its extension ("canyon_run_03"). */
export function captureTitle(path: string): string {
  const name = nameOf(path);
  const s = CAPTURE_SUFFIXES.find((x) => name.toLowerCase().endsWith(x));
  return s ? name.slice(0, -s.length) : name;
}

/** A recording's extension (".sporesample"), which a typed name keeps; "" for another file. */
export const recordingExtension = (path: string): string => nameOf(path).slice(captureTitle(path).length);

export type CaptureNode =
  | { readonly kind: "folder"; readonly path: string; readonly name: string; readonly children: readonly CaptureNode[] }
  | { readonly kind: "file"; readonly path: string; readonly name: string; readonly take: boolean };

/**
 * The capture files of `files` as a tree of the folders that hold them, plus `folders` (empty ones too: a folder the
 * user just made shows, so a file can be moved into it): folders first, then files, each by name.
 */
export function captureTree(files: readonly string[], folders: readonly string[] = []): CaptureNode[] {
  interface Dir {
    dirs: Map<string, Dir>;
    files: string[];
  }
  const root: Dir = { dirs: new Map(), files: [] };
  const dirOf = (folder: string): Dir => {
    let d = root;
    for (const part of folder ? folder.split("/") : []) {
      let next = d.dirs.get(part);
      if (!next) d.dirs.set(part, (next = { dirs: new Map(), files: [] }));
      d = next;
    }
    return d;
  };
  for (const folder of folders) dirOf(folder);
  for (const path of files) if (isCapturePath(path)) dirOf(folderOf(path)).files.push(path);
  const build = (d: Dir, prefix: string): CaptureNode[] => [
    ...[...d.dirs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, sub]): CaptureNode => {
      const path = prefix ? `${prefix}/${name}` : name;
      return { kind: "folder", path, name, children: build(sub, path) };
    }),
    ...d.files.sort((a, b) => nameOf(a).localeCompare(nameOf(b))).map((path): CaptureNode => ({ kind: "file", path, name: nameOf(path), take: isTakePath(path) })),
  ];
  return build(root, "");
}

/** The capture files whose path contains every word of `query` (case-insensitive), by path. */
export function searchCaptures(files: readonly string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return files.filter((p) => isCapturePath(p) && words.every((w) => p.toLowerCase().includes(w))).sort((a, b) => a.localeCompare(b));
}

/** Every folder path of the tree (to open them all at the start). */
export function treeFolders(nodes: readonly CaptureNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly CaptureNode[]) => {
    for (const n of list) if (n.kind === "folder") {
      out.push(n.path);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * The folders a Takes or Captures tree shows: of the project's content folders (`contentFolders`: not the game's scenes,
 * scripts and plugins, nor hidden ones, unless they hold such files), those holding a file the tree lists, at any depth,
 * and those holding no file at all (a folder the user just made, to move files into). A folder of samples or playlists
 * stays in the Samples and Playlists trees, and the other tree's own folder (`recordings/` for Captures, `recordings/` for
 * Takes: `otherRoots`), empty subfolders included, stays in that tree unless it holds a file this one lists. Move to…
 * offers every content folder but the other tree's (`runMoveFolders`).
 */
export function runTreeFolders(folders: readonly string[], files: readonly string[], isFile: (path: string) => boolean, otherRoots: readonly string[] = []): string[] {
  const holding = new Set<string>();
  const used = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      used.add(dir);
      if (isFile(f)) holding.add(dir);
    }
  }
  return runMoveFolders(folders, files, isFile, otherRoots).filter((f) => holding.has(f) || !used.has(f));
}

/** The folders a Takes or Captures tree's Move to… offers: the content folders, without the other tree's (`otherRoots`) unless they hold a file this tree lists. */
export function runMoveFolders(folders: readonly string[], files: readonly string[], isFile: (path: string) => boolean, otherRoots: readonly string[] = []): string[] {
  const holding = new Set<string>();
  for (const f of files) {
    if (!isFile(f)) continue;
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) holding.add(parts.slice(0, i).join("/"));
  }
  const underOther = (f: string): boolean => otherRoots.some((r) => f === r || f.startsWith(`${r}/`));
  return contentFolders(folders, files, isFile).filter((f) => holding.has(f) || !underOther(f));
}

/** The folders a search result's meta names: "HoverBike › Canyon" ("" at the top level). */
export const folderTrail = (path: string): string => folderOf(path).split("/").filter(Boolean).join(" › ");

/** A duration as the trees show it: "32.0 s" under a minute, else "1:05". */
export function durationText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A tree row's meta: its duration, and while searching its folders first ("HoverBike › Canyon · 41.0 s"). */
export function rowMeta(path: string, duration: number | null, searching: boolean): string {
  return [searching ? folderTrail(path) || "Top level" : "", duration === null ? "" : durationText(duration)].filter(Boolean).join(" · ");
}

/** The first free `recordings/<stem>_NN.sporesample` (01, 02…) in `files`. */
export function nextCapturePath(files: readonly string[], stem = "capture", folder = CAPTURES_FOLDER): string {
  const taken = new Set(files.map((f) => f.toLowerCase()));
  for (let n = 1; ; n++) {
    const path = `${folder}/${stem}_${String(n).padStart(2, "0")}.sporesample`;
    if (!taken.has(path.toLowerCase())) return path;
  }
}

/** Why `name` can't be imported into the captures folder (a take goes to the Take screen's Takes), or null. */
export function whyNotCaptureFile(name: string): string | null {
  return isCaptureFile(name) ? null : `${name} isn't a recording (.sporesample).`;
}

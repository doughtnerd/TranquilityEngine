// The Captures panel's tree (ADR 0334 "The Profiler screen"; the prototype's captures file system): the project's
// capture files (`*.mycap`, and takes, `*.mycotake`, whose profile the Profiler reads too) by folder, wherever they are,
// or while searching the matches by path. Saved and imported captures go to `captures/`. Pure.

/** The files the Profiler opens. */
export const CAPTURE_SUFFIXES = [".mycap", ".mycotake"] as const;

/** Where the Studio saves and imports captures. */
export const CAPTURES_FOLDER = "captures";

/** The empty state's words. */
export const NO_CAPTURES = "No captures yet — record one from the editor's Play (Record capture), a game build (F9), or the Studio while a take replays.";

export const isCapturePath = (path: string): boolean => {
  const lower = path.toLowerCase();
  return CAPTURE_SUFFIXES.some((s) => lower.endsWith(s));
};

export const isTakePath = (path: string): boolean => path.toLowerCase().endsWith(".mycotake");

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** A capture's name without its extension ("canyon_run_03"). */
export function captureTitle(path: string): string {
  const name = nameOf(path);
  const s = CAPTURE_SUFFIXES.find((x) => name.toLowerCase().endsWith(x));
  return s ? name.slice(0, -s.length) : name;
}

export type CaptureNode =
  | { readonly kind: "folder"; readonly path: string; readonly name: string; readonly children: readonly CaptureNode[] }
  | { readonly kind: "file"; readonly path: string; readonly name: string; readonly take: boolean };

/** The capture files of `files` as a tree of the folders that hold them: folders first, then files, each by name. */
export function captureTree(files: readonly string[]): CaptureNode[] {
  interface Dir {
    dirs: Map<string, Dir>;
    files: string[];
  }
  const root: Dir = { dirs: new Map(), files: [] };
  for (const path of files) {
    if (!isCapturePath(path)) continue;
    let d = root;
    const folder = folderOf(path);
    for (const part of folder ? folder.split("/") : []) {
      let next = d.dirs.get(part);
      if (!next) d.dirs.set(part, (next = { dirs: new Map(), files: [] }));
      d = next;
    }
    d.files.push(path);
  }
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

/** The first free `captures/<stem>_NN.mycap` (01, 02…) in `files`. */
export function nextCapturePath(files: readonly string[], stem = "capture", folder = CAPTURES_FOLDER): string {
  const taken = new Set(files.map((f) => f.toLowerCase()));
  for (let n = 1; ; n++) {
    const path = `${folder}/${stem}_${String(n).padStart(2, "0")}.mycap`;
    if (!taken.has(path.toLowerCase())) return path;
  }
}

/** A file name for importing `name` into the captures folder: it must be a capture file. Null when it isn't. */
export function whyNotCaptureFile(name: string): string | null {
  return isCapturePath(name) ? null : `${name} isn't a capture file (.mycap or .mycotake).`;
}

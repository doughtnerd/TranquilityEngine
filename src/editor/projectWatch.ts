// Following changes other apps make to an open project folder (ADR 0327, "One app owns each file; both watch"): the
// Audio Studio saving `audio.json` while the editor is open, the editor saving a scene while the Studio is, a code
// editor, `git pull`. App-agnostic: the editor and the Studio each wire it to their own documents
// (editorProjectWatch.ts is the editor's).
//
// - On the desktop the file system's `watch` (Tauri `fs.watch`) reports changes as they happen ("live").
// - In the browser a project folder opened through the File System Access API sends no events, so the folder is
//   looked at again when the window gets the focus and before Play ("on demand"): its files' size and modification
//   stamps against the last look.
// Either way the changed paths are sorted (`classifyChanges`) into project files, scripts, the lock files and the
// pending moves (projectLocks.ts) and handed on in order, one batch at a time.
import type { FileSystem } from "../engine/platform/FileSystem";
import { isProjectFile, skipsFolder } from "../engine/scene/projectFiles";
import { isScriptPath } from "./projectPaths";
import { isLockPath, lockFile, PENDING_MOVES_FILE, type ProjectApp } from "./projectLocks";

/** What changed in a project folder, project-relative ("/"-separated). */
export interface ProjectChanges {
  /** Project files (assets, sidecars, `project.json`) changed, added or removed, or folders that came or went. */
  readonly files: readonly string[];
  /** Scripts and project plugins' sources (`.ts`, ADR 0030, 0139). */
  readonly scripts: readonly string[];
  /** `pending-moves.json` was written (or removed). */
  readonly pendingMoves: boolean;
  /** Apps whose lock file was written or removed. */
  readonly locks: readonly ProjectApp[];
}

export const NO_CHANGES: ProjectChanges = { files: [], scripts: [], pendingMoves: false, locks: [] };

/** True when `changes` holds nothing. */
export const isEmpty = (changes: ProjectChanges): boolean => changes.files.length === 0 && changes.scripts.length === 0 && !changes.pendingMoves && changes.locks.length === 0;

const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
/** A Windows path (a drive letter, or backslashes): compared without case, as the file system does. */
const caseless = (root: string) => /^[A-Za-z]:/.test(root) || root.includes("\\");

/** `absolute` as a path relative to the project folder `root` ("" for the folder itself), or null when it's outside. */
export function projectRelative(root: string, absolute: string): string | null {
  const r = norm(root), a = norm(absolute);
  const [rc, ac] = caseless(root) ? [r.toLowerCase(), a.toLowerCase()] : [r, a];
  if (ac === rc) return "";
  return ac.startsWith(`${rc}/`) ? a.slice(r.length + 1) : null;
}

/**
 * The temporary files of a write in progress, never project files: an atomic write's sibling (`X.json.tmp-<id>`,
 * TauriFileSystem) and Chromium's swap file for a File System Access write (`X.json.crswap`).
 */
const isTempFile = (path: string) => /\.tmp-[a-z0-9]+$/i.test(path) || /\.crswap$/i.test(path);

/** Sort the absolute `paths` a watch reported in the project at `root` into what changed (duplicates dropped). */
export function classifyChanges(root: string, paths: readonly string[]): ProjectChanges {
  const files = new Set<string>(), scripts = new Set<string>(), locks = new Set<ProjectApp>();
  let pendingMoves = false;
  for (const absolute of paths) {
    const path = projectRelative(root, absolute);
    if (!path || isTempFile(path)) continue;
    if (path === PENDING_MOVES_FILE) pendingMoves = true;
    else if (path === lockFile("editor")) locks.add("editor");
    else if (path === lockFile("studio")) locks.add("studio");
    else if (isLockPath(path)) continue;
    else if (isScriptPath(path)) scripts.add(path);
    else if (isProjectFile(path)) files.add(path);
  }
  return { files: [...files], scripts: [...scripts], pendingMoves, locks: [...locks] };
}

/** A file system that can stamp a folder's files (size and modification time) to compare later: the browser's (`FsaFileSystem`). */
export interface StampedFileSystem {
  stamps(path: string, skipFolder?: (name: string) => boolean): Promise<Map<string, string>>;
}

const stamped = (fs: FileSystem): fs is FileSystem & StampedFileSystem => typeof (fs as Partial<StampedFileSystem>).stamps === "function";

/** The paths whose stamp differs between two looks: changed, added and removed. */
export function changedStamps(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const out = [...after].filter(([p, stamp]) => before.get(p) !== stamp).map(([p]) => p);
  for (const p of before.keys()) if (!after.has(p)) out.push(p);
  return out;
}

export interface ProjectWatch {
  /** "live": file system events (desktop); "on-demand": looked at by `rescan` (browser folders); "none": can't watch (a project in memory). */
  readonly mode: "live" | "on-demand" | "none";
  /** Look for changes now ("on demand"; live, wait for the batches already reported). Resolves once they've been handled. */
  rescan(): Promise<void>;
  /** Stop watching; batches not yet handled are dropped. */
  stop(): void;
}

/**
 * Watch the project folder at `root` and call `onChanges` with each batch of changes, one at a time, in order (a batch
 * reported while one is handled waits for it). Errors thrown by `onChanges` are passed to `onError` and don't stop
 * the watch.
 */
export async function watchProject(
  fs: FileSystem,
  root: string,
  onChanges: (changes: ProjectChanges) => void | Promise<void>,
  onError: (err: unknown) => void = (err) => console.warn("[project watch]", err),
): Promise<ProjectWatch> {
  let stopped = false;
  let tail: Promise<void> = Promise.resolve();
  const handle = (paths: readonly string[]) => {
    if (stopped || paths.length === 0) return tail;
    const changes = classifyChanges(root, paths);
    if (isEmpty(changes)) return tail;
    tail = tail.then(async () => {
      if (stopped) return;
      try {
        await onChanges(changes);
      } catch (err) {
        onError(err);
      }
    });
    return tail;
  };

  if (stamped(fs)) {
    const look = () => fs.stamps(root, skipsFolder).catch((err: unknown) => (onError(err), null));
    let last = await look();
    let looking: Promise<void> | null = null;
    return {
      mode: "on-demand",
      rescan() {
        // One look at a time; a rescan asked for during one shares it.
        looking ??= (async () => {
          try {
            const next = await look();
            if (!next || stopped) return;
            const before = last ?? new Map<string, string>();
            last = next;
            await handle(changedStamps(before, next));
          } finally {
            looking = null;
          }
        })();
        return looking;
      },
      stop: () => void (stopped = true),
    };
  }

  if (fs.watch) {
    const unwatch = await fs.watch(root, (paths) => void handle(paths));
    return {
      mode: "live",
      rescan: () => tail,
      stop() {
        stopped = true;
        unwatch();
      },
    };
  }

  return { mode: "none", rescan: () => Promise.resolve(), stop: () => void (stopped = true) };
}

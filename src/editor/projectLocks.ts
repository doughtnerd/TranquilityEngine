// Which app has a project open, and the moves one app leaves for the other (ADR 0327, "One app owns each file;
// both watch"). App-agnostic: the editor and the Audio Studio both import it.
//
// - **Locks.** While an app has a project folder open it holds `.myco/locks/<app>.json` (`{app, pid, started}`),
//   written when the project opens and removed when it closes. A lock left by an app that crashed stays until that
//   app opens the project again (it rewrites its own); nothing here guesses that a lock is stale, so a stale editor
//   lock only makes the Studio leave its moves for the editor (below), which is safe.
// - **Pending moves.** When the Studio moves or renames an asset that scenes or prefabs name while the editor holds
//   the project, it doesn't rewrite those references itself: it adds the moves to `.myco/locks/pending-moves.json`
//   (`recordPendingMoves`, before it moves the files), and the editor applies them to its documents and references
//   and deletes the file (`takePendingMoves`). One file channel for both delivery modes (Tauri events and the browser).
//
// Lenient reads (ADR 0306): a bad file reads as no lock / no moves, with the problem said once; reads never throw.
import type { FileSystem } from "../engine/platform/FileSystem";
import { joinPath } from "./projectPaths";

/** The apps that open project folders. */
export type ProjectApp = "editor" | "studio";

const APPS: readonly ProjectApp[] = ["editor", "studio"];

/** A lock file's contents. */
export interface ProjectLock {
  readonly app: ProjectApp;
  /** The holding process's id (desktop), or null where a page can't know it (the browser). */
  readonly pid: number | null;
  /** When the app opened the project (ISO 8601). */
  readonly started: string;
}

/** A move one app made that the other must follow: project-relative paths, a file or a folder. */
export interface PendingMove {
  readonly from: string;
  readonly to: string;
}

export const LOCKS_FOLDER = ".myco/locks";
export const PENDING_MOVES_FILE = `${LOCKS_FOLDER}/pending-moves.json`;

/** The project-relative path of `app`'s lock file. */
export const lockFile = (app: ProjectApp): string => `${LOCKS_FOLDER}/${app}.json`;

/** The other app. */
export const otherApp = (app: ProjectApp): ProjectApp => (app === "editor" ? "studio" : "editor");

/** The project-relative paths of the lock folder's files (to tell them apart from the project's own files when watching). */
export const isLockPath = (path: string): boolean => path === LOCKS_FOLDER || path.startsWith(`${LOCKS_FOLDER}/`);

/** A problem a lenient read found (the file is skipped). */
export interface LockProblem {
  readonly path: string;
  readonly message: string;
}

/** Read a lock file's text: the lock, or null with the problem when it doesn't hold one. */
export function parseLock(text: string, path = "lock"): { lock: ProjectLock | null; problem: LockProblem | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { lock: null, problem: { path, message: `not valid JSON (${(err as Error).message})` } };
  }
  const o = raw as { app?: unknown; pid?: unknown; started?: unknown } | null;
  if (!o || typeof o !== "object" || !(APPS as readonly unknown[]).includes(o.app)) return { lock: null, problem: { path, message: "names no app (\"editor\" or \"studio\")" } };
  const pid = typeof o.pid === "number" && Number.isInteger(o.pid) && o.pid > 0 ? o.pid : null;
  const started = typeof o.started === "string" ? o.started : "";
  return { lock: { app: o.app as ProjectApp, pid, started }, problem: null };
}

/** A lock file's text. */
export const formatLock = (lock: ProjectLock): string => `${JSON.stringify({ app: lock.app, pid: lock.pid, started: lock.started }, null, 2)}\n`;

/** A held lock: `release` removes the file (once; later calls do nothing). */
export interface HeldLock {
  readonly lock: ProjectLock;
  release(): Promise<void>;
}

/**
 * Hold `app`'s lock on the project folder at `root`: writes `.myco/locks/<app>.json` (over a lock this app left
 * before) and returns the handle that removes it. `now` and `pid` are the caller's (the desktop shells answer
 * `process_id`).
 */
export async function acquireLock(fs: FileSystem, root: string, app: ProjectApp, pid: number | null, now: Date = new Date()): Promise<HeldLock> {
  const lock: ProjectLock = { app, pid, started: now.toISOString() };
  await fs.mkdir(joinPath(root, LOCKS_FOLDER));
  await fs.writeText(joinPath(root, lockFile(app)), formatLock(lock));
  let released = false;
  return {
    lock,
    async release() {
      if (released) return;
      released = true;
      const path = joinPath(root, lockFile(app));
      // Only our own: if the same app opened the project again elsewhere, its newer lock stays.
      const current = await readLockAt(fs, path, lockFile(app));
      if (current.lock && (current.lock.started !== lock.started || current.lock.pid !== lock.pid)) return;
      if (await fs.exists(path).catch(() => false)) await fs.remove(path).catch(() => undefined);
    },
  };
}

async function readLockAt(fs: FileSystem, path: string, name: string): Promise<{ lock: ProjectLock | null; problem: LockProblem | null }> {
  let text: string;
  try {
    if (!(await fs.exists(path))) return { lock: null, problem: null };
    text = await fs.readText(path);
  } catch (err) {
    return { lock: null, problem: { path: name, message: `couldn't be read (${(err as Error).message})` } };
  }
  return parseLock(text, name);
}

/** `app`'s lock on the project at `root`, or null when it holds none (a bad lock file reads as none, with its problem). */
export function readLock(fs: FileSystem, root: string, app: ProjectApp): Promise<{ lock: ProjectLock | null; problem: LockProblem | null }> {
  return readLockAt(fs, joinPath(root, lockFile(app)), lockFile(app));
}

/** The other app's lock when it holds the project open (so `me` must leave it moves instead of rewriting its files), else null. */
export async function otherAppHolds(fs: FileSystem, root: string, me: ProjectApp): Promise<ProjectLock | null> {
  return (await readLock(fs, root, otherApp(me))).lock;
}

// ---- Pending moves ----

/** Read `pending-moves.json`'s text: `{ "moves": [{ "from", "to" }…] }` (a bare array is read too); bad entries are skipped with a problem. */
export function parsePendingMoves(text: string): { moves: PendingMove[]; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { moves: [], problems: [`${PENDING_MOVES_FILE} isn't valid JSON (${(err as Error).message})`] };
  }
  const list = Array.isArray(raw) ? raw : (raw as { moves?: unknown } | null)?.moves;
  if (!Array.isArray(list)) return { moves: [], problems: [`${PENDING_MOVES_FILE} has no "moves" list`] };
  const moves: PendingMove[] = [];
  const problems: string[] = [];
  list.forEach((m: unknown, i) => {
    const { from, to } = (m ?? {}) as { from?: unknown; to?: unknown };
    if (typeof from !== "string" || typeof to !== "string" || !validPath(from) || !validPath(to)) problems.push(`${PENDING_MOVES_FILE}: move ${i + 1} needs project-relative "from" and "to" paths`);
    else if (from !== to) moves.push({ from, to });
  });
  return { moves, problems };
}

/** A project-relative "/"-separated path: not empty, not absolute, no "." or ".." parts. */
function validPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((p) => p !== "" && p !== "." && p !== "..");
}

/** `pending-moves.json`'s text for `moves`. */
export const formatPendingMoves = (moves: readonly PendingMove[]): string => `${JSON.stringify({ moves: moves.map(({ from, to }) => ({ from, to })) }, null, 2)}\n`;

/**
 * `before` followed by `after`, as one list: a later move of something an earlier move put in place (`a → b`, then
 * `b → c`, or a folder holding it) becomes part of that earlier move (`a → c`), so the reader sees each file once,
 * from where it was to where it is. Moves that end where they began are dropped.
 */
export function chainMoves(before: readonly PendingMove[], after: readonly PendingMove[]): PendingMove[] {
  const out = before.map((m) => ({ ...m }));
  for (const m of after) {
    let absorbed = false;
    for (const prev of out) {
      if (prev.to === m.from || prev.to.startsWith(`${m.from}/`)) {
        prev.to = m.to + prev.to.slice(m.from.length);
        absorbed = absorbed || prev.to === m.to;
      }
    }
    if (!absorbed) out.push({ ...m });
  }
  return out.filter((m) => m.from !== m.to);
}

/**
 * The Studio's side: add `moves` to `pending-moves.json` (chained after any already there). Call it before moving
 * the files, so a watcher that sees the files move finds the moves waiting.
 */
export async function recordPendingMoves(fs: FileSystem, root: string, moves: readonly PendingMove[]): Promise<void> {
  if (moves.length === 0) return;
  const path = joinPath(root, PENDING_MOVES_FILE);
  const existing = (await fs.exists(path).catch(() => false)) ? parsePendingMoves(await fs.readText(path).catch(() => "")).moves : [];
  await fs.mkdir(joinPath(root, LOCKS_FOLDER));
  await fs.writeText(path, formatPendingMoves(chainMoves(existing, moves)));
}

/**
 * The editor's side: the moves waiting in `pending-moves.json` (none when there's no file), deleting the file once read,
 * so they're applied once. Problems with the file are returned to report; a file that can't be parsed is deleted too
 * (it would never become readable).
 */
export async function takePendingMoves(fs: FileSystem, root: string): Promise<{ moves: PendingMove[]; problems: string[] }> {
  const path = joinPath(root, PENDING_MOVES_FILE);
  let text: string;
  try {
    if (!(await fs.exists(path))) return { moves: [], problems: [] };
    text = await fs.readText(path);
  } catch (err) {
    return { moves: [], problems: [`${PENDING_MOVES_FILE} couldn't be read (${(err as Error).message})`] };
  }
  // The Studio may add moves while this reads: read again until two reads agree, then delete (a narrow window stays,
  // as the file system has no compare-and-delete).
  for (let tries = 0; tries < 3; tries++) {
    const again = await fs.readText(path).catch(() => text);
    if (again === text) break;
    text = again;
  }
  const read = parsePendingMoves(text);
  await fs.remove(path).catch(() => undefined);
  return read;
}

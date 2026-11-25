// The Audio Studio's start screen lists recorded takes (`*.sporesample`, ADR 0348) found in the user's recent folder
// projects, newest first. This is the data: a walk of each project's `recordings/` folder, a header read of each file.
import type { FileSystem } from "../../engine/platform/FileSystem";
import type { RecentProject } from "../../editor/recentProjects";
import { joinPath } from "../../editor/projectPaths";
import { TAKE_NOTES_SUFFIX, TAKE_SUFFIX } from "../../engine/audio/take/types";
import type { StudioOpenRequest } from "../../editor/studioAssets";
import { splitPath } from "../takesFolder";

/** What every listed take has: its name, length and date, and its file's absolute path. */
interface TakeEntry {
  /** File name without the .sporesample suffix, e.g. "canyon_run_01". */
  readonly name: string;
  /** The file's absolute path (as the file system names it). */
  readonly file: string;
  /** Length in seconds, or null when it couldn't be read. */
  readonly seconds: number | null;
  /** When recording started (ms since epoch), or null when unknown. */
  readonly recordedMs: number | null;
}

/** A take in a recent project's `recordings/` folder (badge "Project"): it opens in its project. */
export interface ProjectTake extends TakeEntry {
  readonly kind: "project";
  /** Project-relative path, e.g. "recordings/HoverBike/canyon_run_01.sporesample". */
  readonly path: string;
  /** The recent project it is in. */
  readonly project: RecentProject;
}

/**
 * ADR 0408: a take outside any project (badge "Recording"): in the takes folder, or a file added by dropping it on the
 * launcher. It opens in the takes folder workspace of `folder`.
 */
export interface LooseTake extends TakeEntry {
  readonly kind: "recording";
  /** The folder opened as the takes workspace (the takes folder, or the added file's own folder). */
  readonly folder: string;
  /** The take's path relative to `folder`, "/"-separated. */
  readonly path: string;
}

export type RecentTake = ProjectTake | LooseTake;

/** What opens `take` in the Studio: its project on the Take screen, or its folder as a takes workspace (ADR 0408). */
export function takeOpenRequest(take: RecentTake): StudioOpenRequest {
  return take.kind === "project"
    ? { project: take.project.path, asset: take.path, screen: "take" }
    : { project: null, takesFolder: take.folder, asset: take.path, screen: "take" };
}

export interface TakeReader {
  (bytes: Uint8Array): Promise<{ seconds: number | null; recordedMs: number | null }>;
}

const TAKES_FOLDER = "recordings";
const MAX_DEPTH = 8;

/** Take files under `dir` (project-relative), recursively. A folder that can't be listed is skipped. */
async function walk(fs: FileSystem, root: string, dir: string, depth: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.list(dir === "" ? root : joinPath(root, dir));
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = dir === "" ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory) {
      if (depth < MAX_DEPTH) await walk(fs, root, rel, depth + 1, out);
    } else if (e.name.endsWith(TAKE_SUFFIX) && !e.name.endsWith(TAKE_NOTES_SUFFIX)) {
      out.push(rel);
    }
  }
}

/**
 * Lists takes under each folder project's `recordings/` folder (recursively; `*.notes.json` and other files skipped), reads
 * each with `read`, sorts newest first (unknown dates last, then by name). Only desktop path entries are listed; a
 * project whose folder is missing or unreadable is skipped, a take that fails to read keeps seconds/recordedMs null.
 * `limit` caps the number of takes read.
 */
export async function listRecentTakes(projects: readonly RecentProject[], fs: FileSystem, read: TakeReader, limit = 50): Promise<RecentTake[]> {
  const found: { project: RecentProject; path: string }[] = [];
  for (const project of projects) {
    if (project.kind === "handle") continue;
    try {
      if (!(await fs.exists(joinPath(project.path, TAKES_FOLDER)))) continue;
    } catch {
      continue;
    }
    const paths: string[] = [];
    await walk(fs, project.path, TAKES_FOLDER, 0, paths);
    for (const path of paths) found.push({ project, path });
  }
  const takes: RecentTake[] = [];
  for (const { project, path } of found.slice(0, Math.max(0, limit))) {
    const file = joinPath(project.path, path);
    const { seconds, recordedMs } = await summarise(fs, file, read);
    takes.push({ kind: "project", name: takeName(path), file, path, project, seconds, recordedMs });
  }
  return newestFirst(takes);
}

const takeName = (path: string): string => {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.slice(0, file.length - TAKE_SUFFIX.length);
};

/** A take's length and start time; unreadable: nulls. */
async function summarise(fs: FileSystem, file: string, read: TakeReader): Promise<{ seconds: number | null; recordedMs: number | null }> {
  try {
    const summary = await read(await fs.readBinary(file));
    return { seconds: summary.seconds, recordedMs: summary.recordedMs };
  } catch {
    return { seconds: null, recordedMs: null }; // unreadable: listed without a length or date
  }
}

function newestFirst<T extends TakeEntry>(takes: T[]): T[] {
  return takes.sort((a, b) => {
    if (a.recordedMs !== b.recordedMs) {
      if (a.recordedMs === null) return 1;
      if (b.recordedMs === null) return -1;
      return b.recordedMs - a.recordedMs;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/**
 * ADR 0408: takes outside any project. Lists the takes folder (recursively, notes skipped; a folder that is missing or
 * null is skipped) and each added take file (a file that is gone is skipped, not an error), sorted newest first.
 * `limit` caps the number of takes read.
 */
export async function listLooseTakes(takesFolder: string | null, added: readonly string[], fs: FileSystem, read: TakeReader, limit = 50): Promise<LooseTake[]> {
  const found: { folder: string; path: string }[] = [];
  if (takesFolder) {
    try {
      if (await fs.exists(takesFolder)) {
        const paths: string[] = [];
        await walk(fs, takesFolder, "", 0, paths);
        for (const path of paths) found.push({ folder: takesFolder, path });
      }
    } catch {
      // unreadable takes folder: none from it
    }
  }
  for (const file of added) {
    try {
      if (!(await fs.exists(file))) continue;
    } catch {
      continue;
    }
    const [folder, name] = splitPath(file);
    found.push({ folder, path: name });
  }
  const takes: LooseTake[] = [];
  for (const { folder, path } of found.slice(0, Math.max(0, limit))) {
    const { seconds, recordedMs } = await summarise(fs, joinPath(folder, path), read);
    takes.push({ kind: "recording", name: takeName(path), file: joinPath(folder, path), folder, path, seconds, recordedMs });
  }
  return newestFirst(takes);
}

const sameFile = (file: string): string => file.replace(/[\\]/g, "/").toLowerCase();

/** The Recorded takes tab's list: project takes and loose takes, newest first, one row per file (a project take wins). */
export async function listAllTakes(
  projects: readonly RecentProject[],
  takesFolder: string | null,
  added: readonly string[],
  fs: FileSystem,
  read: TakeReader,
  limit = 50,
): Promise<RecentTake[]> {
  const [inProjects, loose] = await Promise.all([listRecentTakes(projects, fs, read, limit), listLooseTakes(takesFolder, added, fs, read, limit)]);
  const seen = new Set(inProjects.map((t) => sameFile(t.file)));
  const all: RecentTake[] = [...inProjects];
  for (const t of loose) {
    const key = sameFile(t.file);
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(t);
  }
  return newestFirst(all);
}

/** The real reader: opens the take file (loaded on demand, so the launcher's start-up bundle does not carry it) and returns its length and start time. */
export const readTakeSummary: TakeReader = async (bytes) => {
  const { openTakeFile } = await import("../../plugins/audio/runtime/capture/takeFile");
  const { take } = await openTakeFile(bytes);
  const started = Date.parse(take.meta.started);
  return {
    seconds: Number.isFinite(take.duration) ? take.duration : null,
    recordedMs: Number.isFinite(started) && started > 0 ? started : null,
  };
};

/** "0:42", "1:16", "12:03", "1:02:03"; "—" for null. */
export function formatTakeLength(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

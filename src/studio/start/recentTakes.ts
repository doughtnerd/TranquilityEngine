// The Audio Studio's start screen lists recorded takes (`*.mycotake`, ADR 0348) found in the user's recent folder
// projects, newest first. This is the data: a walk of each project's `takes/` folder, a header read of each file.
import type { FileSystem } from "../../engine/platform/FileSystem";
import type { RecentProject } from "../../editor/recentProjects";
import { joinPath } from "../../editor/projectPaths";
import { TAKE_NOTES_SUFFIX, TAKE_SUFFIX } from "../../engine/audio/take/types";

export interface RecentTake {
  /** File name without the .mycotake suffix, e.g. "canyon_run_01". */
  readonly name: string;
  /** Project-relative path, e.g. "takes/HoverBike/canyon_run_01.mycotake". */
  readonly path: string;
  /** The recent project it is in. */
  readonly project: RecentProject;
  /** Length in seconds, or null when it couldn't be read. */
  readonly seconds: number | null;
  /** When recording started (ms since epoch), or null when unknown. */
  readonly recordedMs: number | null;
}

export interface TakeReader {
  (bytes: Uint8Array): Promise<{ seconds: number | null; recordedMs: number | null }>;
}

const TAKES_FOLDER = "takes";
const MAX_DEPTH = 8;

/** Take files under `dir` (project-relative), recursively. A folder that can't be listed is skipped. */
async function walk(fs: FileSystem, root: string, dir: string, depth: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.list(joinPath(root, dir));
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory) {
      if (depth < MAX_DEPTH) await walk(fs, root, rel, depth + 1, out);
    } else if (e.name.endsWith(TAKE_SUFFIX) && !e.name.endsWith(TAKE_NOTES_SUFFIX)) {
      out.push(rel);
    }
  }
}

/**
 * Lists takes under each folder project's `takes/` folder (recursively; `*.notes.json` and other files skipped), reads
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
    let seconds: number | null = null;
    let recordedMs: number | null = null;
    try {
      const summary = await read(await fs.readBinary(joinPath(project.path, path)));
      seconds = summary.seconds;
      recordedMs = summary.recordedMs;
    } catch {
      // unreadable: listed without a length or date
    }
    const file = path.slice(path.lastIndexOf("/") + 1);
    takes.push({ name: file.slice(0, file.length - TAKE_SUFFIX.length), path, project, seconds, recordedMs });
  }
  return takes.sort((a, b) => {
    if (a.recordedMs !== b.recordedMs) {
      if (a.recordedMs === null) return 1;
      if (b.recordedMs === null) return -1;
      return b.recordedMs - a.recordedMs;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
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

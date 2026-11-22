/**
 * `npm run audio:migrate`: migrate a project's audio events to playlists (ADR 0329 §"Migration").
 *
 * ```sh
 * npm run audio:migrate -- <projectDir> [--dry-run]
 * ```
 *
 * Every `*.audioevent.json` becomes a `*.playlist.json` beside it, references to it in the project's JSON files are
 * rewritten, and the old file moves to `.myco/migrated/`. `--dry-run` reports what would change and writes nothing.
 * The driver is `migrateProjectAudio` (`src/engine/audio/migrate/project.ts`); this file gives it the disk.
 *
 * Exits 0 on success, 1 if the project can't be read or written, 2 for bad arguments.
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { migrateProjectAudio, type AudioMigrationReport, type MigrationFileSystem } from "../engine/audio/migrate/project";

export const USAGE = `Usage: npm run audio:migrate -- <projectDir> [options]

Turns the project's *.audioevent.json files into *.playlist.json files, rewrites the references to them, and moves
the old files to .myco/migrated/.

Options:
  --dry-run        Write nothing; report what would change
  -h, --help       Show this help`;

export class UsageError extends Error {}

export interface MigrateArgs {
  projectDir: string;
  dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): MigrateArgs | "help" {
  const args: MigrateArgs = { projectDir: "", dryRun: false };
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new UsageError("Give the project folder to migrate.");
  args.projectDir = positional[0];
  return args;
}

/** The disk as the driver's file system. */
export const nodeFileSystem: MigrationFileSystem = {
  readText: (path) => readFile(path, "utf8"),
  readBinary: async (path) => new Uint8Array(await readFile(path)),
  writeText: (path, text) => writeFile(path, text),
  list: async (path) => (await readdir(path, { withFileTypes: true })).map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
  exists: (path) => stat(path).then(() => true, () => false),
  mkdir: async (path) => void (await mkdir(path, { recursive: true })),
  rename: async (from, to) => {
    if (await stat(to).then(() => true, () => false)) throw new Error(`"${to}" already exists.`);
    await rename(from, to);
  },
};

/** The report as the lines the command prints. */
export function reportLines(report: AudioMigrationReport, dryRun: boolean): string[] {
  const would = (done: string, todo: string) => (dryRun ? todo : done);
  const lines: string[] = [];
  for (const p of report.written) lines.push(`${would("wrote", "would write")} ${p}`);
  for (const p of report.rewritten) lines.push(`${would("rewrote references in", "would rewrite references in")} ${p}`);
  for (const m of report.moved) lines.push(`${would("moved", "would move")} ${m.from} -> ${m.to}`);
  for (const n of report.notes) lines.push(`note ${n}`);
  lines.push(
    report.moved.length === 0 && report.written.length === 0
      ? "No audio events to migrate."
      : `${report.written.length} playlists ${would("written", "to write")}, ${report.rewritten.length} files ${would("rewritten", "to rewrite")}, ${report.moved.length} events ${would("moved", "to move")}, ${report.notes.length} notes.`,
  );
  return lines;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: MigrateArgs | "help";
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (args === "help") {
    console.log(USAGE);
    return 0;
  }
  let report: AudioMigrationReport;
  try {
    report = await migrateProjectAudio(nodeFileSystem, args.projectDir, { dryRun: args.dryRun });
  } catch (e) {
    console.error(`Can't migrate "${args.projectDir}": ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  for (const line of reportLines(report, args.dryRun)) console.log(line);
  return 0;
}

// Migrating a project's old audio events when it opens (ADR 0329 "Migration", decision D11): the editor and the Audio
// Studio both ask once, when the project they open still has `*.audioevent.json` files, and on yes run the engine's
// migration (`migrateProjectAudio`: each event becomes a `*.playlist.json` beside it, the files naming it are rewritten,
// the old file moves to `.myco/migrated/`) through the app's own file system, before the project's files are read, so
// nothing is open yet. A read-only folder is never asked about. What declining means is the app's: the Studio opens the
// project read-only and offers "Migrate now" on its playlist screens; the editor, which no longer edits audio, opens it
// as usual. Pure apart from the file system and the injected question.
import { findAudioEvents, migrateProjectAudio, MIGRATED_FOLDER, type AudioMigrationReport } from "../engine/audio/migrate/project";
import type { FileSystem } from "../engine/platform/FileSystem";

/** The question, in the confirm dialog's shape (`ConfirmOptions`). */
export interface AudioEventMigrationQuestion {
  readonly title: string;
  readonly message: string;
  readonly items: string[];
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly danger: false;
}

export type AudioEventMigrationOutcome =
  /** No old files, or a folder that can't be written. */
  | { readonly kind: "none" }
  /** The user said no: the old files stay. */
  | { readonly kind: "declined"; readonly files: readonly string[] }
  | { readonly kind: "migrated"; readonly report: AudioMigrationReport }
  /** The migration stopped on a file system error (what it did so far stays; running it again picks up the rest). */
  | { readonly kind: "failed"; readonly files: readonly string[]; readonly error: string };

/** At most this many file names are listed in the question; the rest are counted. */
const LISTED = 8;

/** The one question for `files` (the project's old event files). */
export function migrationQuestion(files: readonly string[]): AudioEventMigrationQuestion {
  const n = files.length;
  return {
    title: "Migrate audio events",
    message: `This project uses the old audio event format; migrate ${n} ${n === 1 ? "file" : "files"} to playlists? A copy of each goes to ${MIGRATED_FOLDER}/.`,
    items: [...files.slice(0, LISTED), ...(n > LISTED ? [`and ${n - LISTED} more`] : [])],
    confirmLabel: "Migrate",
    cancelLabel: "Not now",
    danger: false,
  };
}

/** One line for the status bar or the log saying what a migration did. */
export function migrationSummary(report: AudioMigrationReport): string {
  const n = report.written.length;
  const notes = report.notes.length > 0 ? ` ${report.notes.length} ${report.notes.length === 1 ? "note" : "notes"} in the console.` : "";
  return `Migrated ${n} audio ${n === 1 ? "event" : "events"} to playlists; the old files are in ${MIGRATED_FOLDER}/.${notes}`;
}

/** Run the migration over the project folder at `root`; its notes go to `log`, one line each. Never throws. */
export async function runAudioEventMigration(fs: FileSystem, root: string, log: (line: string) => void = (line) => console.info(line)): Promise<AudioEventMigrationOutcome> {
  let files: string[] = [];
  try {
    files = await findAudioEvents(fs, root);
    if (files.length === 0) return { kind: "none" };
    const report = await migrateProjectAudio(fs, root);
    log(`[audio] ADR 0329: ${migrationSummary(report)}`);
    for (const note of report.notes) log(`[audio] ${note}`);
    return { kind: "migrated", report };
  } catch (err) {
    return { kind: "failed", files, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Before a project folder's files are read: when it still has old audio events and can be written, ask `confirm` once
 * (`migrationQuestion`) and, on yes, migrate them (`runAudioEventMigration`).
 */
export async function offerAudioEventMigration(
  fs: FileSystem,
  root: string,
  confirm: (question: AudioEventMigrationQuestion) => Promise<boolean>,
  log?: (line: string) => void,
): Promise<AudioEventMigrationOutcome> {
  if (!fs.canWrite) return { kind: "none" };
  let files: string[];
  try {
    files = await findAudioEvents(fs, root);
  } catch {
    return { kind: "none" }; // the folder can't be listed: opening it says why
  }
  if (files.length === 0) return { kind: "none" };
  if (!(await confirm(migrationQuestion(files)))) return { kind: "declined", files };
  return runAudioEventMigration(fs, root, log);
}

// The open project's old audio events, while they aren't migrated (ADR 0329 "Migration", D11): the Studio asks when a
// project with `*.audioevent.json` files opens (`studioProject.ts`, through `audioEventMigration.ts`); declined, the
// project opens read-only and this holds what the Playlists screen's banner says and its Migrate now action. Cleared
// when the project closes or the migration ran.
import { signal } from "@preact/signals";

export interface PendingAudioMigration {
  /** The project's old event files. */
  readonly files: readonly string[];
  /** Migrate them and open the project again, writable. */
  migrate(): Promise<void>;
  /** The migration is running. */
  readonly running: boolean;
  /** Why the last try failed, or null. */
  readonly error: string | null;
}

export const pendingAudioMigration = signal<PendingAudioMigration | null>(null);

/** What the banner says for `pending`: its text, the button's label and whether it can be pressed. */
export function migrationBanner(pending: PendingAudioMigration): { text: string; button: string; disabled: boolean; error: string | null } {
  const n = pending.files.length;
  return {
    text: `This project uses the old audio event format (${n} ${n === 1 ? "file" : "files"}), so it is open read-only. Migrate ${n === 1 ? "it" : "them"} to playlists to edit; a copy of each goes to .myco/migrated/.`,
    button: pending.running ? "Migrating…" : "Migrate now",
    disabled: pending.running,
    error: pending.error === null ? null : `Couldn't migrate: ${pending.error}`,
  };
}

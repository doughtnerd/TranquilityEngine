// The banner over the Playlists screen while the open project's old audio events aren't migrated (ADR 0343): it says the
// project is read-only and why, and Migrate now runs the migration (`audioMigration.ts`).
import { migrationBanner, type PendingAudioMigration } from "./audioMigration";

export function MigrationBanner(props: { pending: PendingAudioMigration }) {
  const view = migrationBanner(props.pending);
  return (
    <div class="studio-banner studio-banner-info" role="status">
      <span>{view.text}</span>{" "}
      <button type="button" disabled={view.disabled} onClick={() => void props.pending.migrate()}>
        {view.button}
      </button>
      {view.error && (
        <span class="studio-banner-error" role="alert">
          {" "}
          {view.error}
        </span>
      )}
    </div>
  );
}

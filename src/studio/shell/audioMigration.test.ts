// ADR 0329: what the Playlists screen's banner says while a read-only project's old audio events wait for migration.
import { describe, expect, it } from "vitest";
import { migrationBanner, type PendingAudioMigration } from "./audioMigration";

const pending = (over: Partial<PendingAudioMigration> = {}): PendingAudioMigration => ({ files: ["a.audioevent.json"], migrate: async () => {}, running: false, error: null, ...over });

describe("the migration banner", () => {
  it("says the project is read-only and why, and offers Migrate now", () => {
    expect(migrationBanner(pending())).toEqual({
      text: "This project uses the old audio event format (1 file), so it is open read-only. Migrate it to playlists to edit; a copy of each goes to .myco/migrated/.",
      button: "Migrate now",
      disabled: false,
      error: null,
    });
    expect(migrationBanner(pending({ files: ["a", "b"] })).text).toMatch(/\(2 files\).*Migrate them/);
  });

  it("disables the button while running and says why a try failed", () => {
    expect(migrationBanner(pending({ running: true }))).toMatchObject({ button: "Migrating…", disabled: true });
    expect(migrationBanner(pending({ error: "disk full" })).error).toBe("Couldn't migrate: disk full");
  });
});

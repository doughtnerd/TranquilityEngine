// ADR 0330: the dedicated server's project reader takes the mix from audio.json and refuses an old project.json section.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSettings } from "../engine/core/settings";
import { ServerError, readProject } from "./project";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function folder(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "myco-audio-"));
  temps.push(dir);
  for (const [path, value] of Object.entries(files)) writeFileSync(join(dir, path), JSON.stringify(value));
  return dir;
}

describe("the server's project reader and audio.json", () => {
  it("serves audio.json's mix as the settings' audio", async () => {
    const dir = folder({ "project.json": { name: "Game" }, "audio.json": { format: "myco.audio@1", buses: [{ name: "Master" }, { name: "Crowd", parent: "Master", volumeDb: -60 }] } });
    const project = await readProject(dir);
    expect(resolveSettings(project.settings).audio.buses.map((b) => [b.name, b.volume])).toEqual([["Master", 1], ["Crowd", 0]]);
    expect(project.assets.has("audio.json")).toBe(true);
  });

  it("refuses a project.json that still has an audio section, naming the migration", async () => {
    const dir = folder({ "project.json": { name: "Game", audio: { buses: [{ name: "Master" }] } } });
    const err = await readProject(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect((err as Error).message).toMatch(/moved to audio\.json \(ADR 0330\)\. Open the project in the editor once/);
  });
});

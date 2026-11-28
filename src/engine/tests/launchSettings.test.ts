// Launch settings (ADR 0447): the project settings every host that runs a project's files launches with, read from
// those files: project.json with audio.json's mix, the refusals, and audio.json's notices.
import { describe, expect, it } from "vitest";
import { resolveSettings } from "../core/settings";
import { launchSettings } from "../launchSettings";
import { AUDIO_PROJECT_FORMAT } from "../audio/project/types";

const files = (entries: Record<string, unknown>) => new Map(Object.entries(entries));
const AUDIO = { format: AUDIO_PROJECT_FORMAT, buses: [{ name: "Master" }, { name: "Crowd", parent: "Master", volumeDb: -60 }] };

describe("launchSettings", () => {
  it("launches with project.json's settings and audio.json's mix as audio", () => {
    const read = launchSettings(files({ "project.json": { name: "Game", display: { width: 320 } }, "audio.json": AUDIO }));
    if (read.refusal !== undefined) throw new Error(read.refusal);
    expect(read.notices).toEqual([]);
    const settings = resolveSettings(read.project);
    expect(settings.name).toBe("Game");
    expect(settings.audio.buses.map((b) => [b.name, b.volume])).toEqual([["Master", 1], ["Crowd", 0]]);
  });

  it("without project.json or audio.json, empty settings and the default mix", () => {
    const read = launchSettings(files({}));
    if (read.refusal !== undefined) throw new Error(read.refusal);
    expect(read.project).toEqual({});
    expect(resolveSettings(read.project).audio.buses.map((b) => b.name)).toEqual(["Master", "Music", "SFX", "UI", "Voice"]);
  });

  it("refuses a project.json that still has an audio section, naming the migration, with or without audio.json", () => {
    const old = { name: "Game", audio: { buses: [{ name: "Master" }] } };
    for (const read of [launchSettings(files({ "project.json": old })), launchSettings(files({ "project.json": old, "audio.json": AUDIO }))]) {
      expect(read.refusal).toMatch(/project\.json still has an "audio" section, which moved to audio\.json \(ADR 0344\)\. Open the project in the editor once/);
    }
  });

  it("refuses a project.json that isn't an object", () => {
    for (const value of [[], "Game", 3, null]) {
      expect(launchSettings(files({ "project.json": value })).refusal).toBe("project.json must hold an object of project settings.");
    }
  });

  it("reports audio.json's problems as notices naming the file, and launches with the default mix", () => {
    const read = launchSettings(files({ "project.json": { name: "Game" }, "audio.json": { format: "nope", buses: 3 } }));
    if (read.refusal !== undefined) throw new Error(read.refusal);
    expect(read.notices).toHaveLength(2);
    for (const notice of read.notices) expect(notice).toMatch(/^audio\.json: /);
    expect(resolveSettings(read.project).name).toBe("Game");
  });
});

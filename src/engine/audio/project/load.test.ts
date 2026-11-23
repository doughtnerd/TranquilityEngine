import { describe, expect, it } from "vitest";
import { resolveSettings } from "../../core/settings";
import { hasLegacyAudio, projectWithAudio } from "./load";
import { AUDIO_PROJECT_FORMAT } from "./types";

const AUDIO = { format: AUDIO_PROJECT_FORMAT, buses: [{ name: "Master" }, { name: "Music", parent: "Master", volumeDb: -6 }], returns: [{ name: "Echo" }], settings: { dopplerAmount: 0.5 } };

describe("projectWithAudio", () => {
  it("gives the Engine project.json's keys with audio.json's runtime view as audio", () => {
    const read = projectWithAudio({ name: "Game", display: { width: 320 } }, AUDIO);
    expect(read.legacyAudio).toBe(false);
    expect(read.problems).toEqual([]);
    expect(read.warnings).toEqual([]);
    const settings = resolveSettings(read.project);
    expect(settings.audio.doppler.amount).toBe(0.5); // ADR 0347: the Doppler pass scales every voice's level by it
    expect(settings.name).toBe("Game");
    // ADR 0344 (ABI 4.7): the return is a bus of the view, after the buses, its output as the parent.
    expect(settings.audio.buses.map((b) => [b.name, b.volume])).toEqual([["Master", 1], ["Music", expect.closeTo(Math.pow(10, -6 / 20), 9)], ["Echo", 1]]);
    expect(settings.audio.buses[2]!.parent).toBe("Master");
  });

  it("without audio.json, the default mix", () => {
    const read = projectWithAudio({ name: "Game" }, undefined);
    expect(read.project).toEqual({ name: "Game" });
    expect(resolveSettings(read.project).audio.buses.map((b) => b.name)).toEqual(["Master", "Music", "SFX", "UI", "Voice"]);
  });

  it("refuses an old project.json audio section: flags it and leaves it out, whether or not audio.json exists", () => {
    const old = { name: "Game", audio: { buses: [{ name: "Master" }, { name: "Old", parent: "Master" }] } };
    expect(hasLegacyAudio(old)).toBe(true);
    expect(hasLegacyAudio({ name: "Game" })).toBe(false);
    const alone = projectWithAudio(old, undefined);
    expect(alone.legacyAudio).toBe(true);
    expect(alone.project).toEqual({ name: "Game" });
    const both = projectWithAudio(old, AUDIO);
    expect(both.legacyAudio).toBe(true);
    expect(resolveSettings(both.project).audio.buses.map((b) => b.name)).toEqual(["Master", "Music", "Echo"]);
  });

  it("reports audio.json's parse problems", () => {
    expect(projectWithAudio({}, { format: "nope", buses: 3 }).problems).toHaveLength(2);
  });
});

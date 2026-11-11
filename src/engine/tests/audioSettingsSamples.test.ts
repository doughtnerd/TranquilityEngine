// ADR 0162 A6b: the `stress` sample carries the high preset's numbers (HRTF 8, `maxBeds` 4, `maxClips` 2) and its audio
// section parses without a problem.
import { describe, expect, it } from "vitest";
import stress from "../../../samples/stress/project.json";
import { parseAudioSettings } from "../audio/settings";

describe("sample audio settings", () => {
  it("stress: the high preset's numbers, no problems", () => {
    const { settings, problems } = parseAudioSettings(stress.audio);
    expect(problems).toEqual([]);
    expect(settings.voices).toEqual({ mixed: 256, logical: 4096, hrtf: 8 });
    expect(settings.clipMemoryMB).toBe(256);
    expect(settings.bed.maxBeds).toBe(4);
    expect(settings.ambisonic.maxClips).toBe(2);
  });
});

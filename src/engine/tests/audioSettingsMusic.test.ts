import { describe, expect, it } from "vitest";
import { DEFAULT_MUSIC_RINGS, MUSIC_RINGS_PRESETS, defaultAudioSettings, parseAudioSettings } from "../audio/settings";

// Contract Q0 (M4 build plan). ADR 0166 api-and-models §2.1: `music.rings` (integer 0..16, default 12, clamp plus a
// problem) and `rhythmMode` (boolean, default false; anything else false plus a problem). Both inert until W1 and Rh1.
describe("audio settings: the M4 keys (ADR 0166 §2.1)", () => {
  it("defaults: no section gives music.rings 12 and rhythmMode false, with no problems", () => {
    for (const input of [undefined, {}]) {
      const { settings, problems } = parseAudioSettings(input);
      expect(problems).toEqual([]);
      expect(settings.music).toEqual({ rings: 12 });
      expect(settings.rhythmMode).toBe(false);
    }
    expect(defaultAudioSettings().music.rings).toBe(DEFAULT_MUSIC_RINGS);
    expect(defaultAudioSettings().rhythmMode).toBe(false);
    expect(MUSIC_RINGS_PRESETS).toEqual({ low: 8, default: 12, high: 16 });
  });

  it("music.rings: whole numbers 0..16 pass through, including 0 and 16", () => {
    for (const rings of [0, 8, 12, 16]) {
      const { settings, problems } = parseAudioSettings({ music: { rings } });
      expect(problems).toEqual([]);
      expect(settings.music.rings).toBe(rings);
    }
  });

  it("music.rings: out of range is clamped with a problem; a fraction is rounded", () => {
    let r = parseAudioSettings({ music: { rings: 17 } });
    expect(r.settings.music.rings).toBe(16);
    expect(r.problems).toEqual(["audio.music.rings: 17 is outside 0..16; using 16."]);
    r = parseAudioSettings({ music: { rings: -2 } });
    expect(r.settings.music.rings).toBe(0);
    expect(r.problems).toEqual(["audio.music.rings: -2 is outside 0..16; using 0."]);
    r = parseAudioSettings({ music: { rings: 9.4 } });
    expect(r.settings.music.rings).toBe(9);
    expect(r.problems).toEqual([]);
  });

  it("music.rings: a wrong type gives the default and a problem; a non-object section is a problem", () => {
    let r = parseAudioSettings({ music: { rings: "many" } });
    expect(r.settings.music.rings).toBe(12);
    expect(r.problems).toEqual(["audio.music.rings: must be a whole number from 0 to 16."]);
    r = parseAudioSettings({ music: 4 });
    expect(r.settings.music.rings).toBe(12);
    expect(r.problems).toEqual(["audio.music must be an object."]);
    r = parseAudioSettings({ music: {} });
    expect(r.settings.music.rings).toBe(12);
    expect(r.problems).toEqual([]);
  });

  it("rhythmMode: a boolean passes through; anything else is false with a problem", () => {
    expect(parseAudioSettings({ rhythmMode: true }).settings.rhythmMode).toBe(true);
    expect(parseAudioSettings({ rhythmMode: false }).problems).toEqual([]);
    for (const bad of [1, "yes", null, {}]) {
      const r = parseAudioSettings({ rhythmMode: bad });
      expect(r.settings.rhythmMode).toBe(false);
      expect(r.problems).toEqual(["audio.rhythmMode: must be true or false; using false."]);
    }
  });

  it("the music keys don't disturb the others", () => {
    const r = parseAudioSettings({ music: { rings: 8 }, rhythmMode: true, voices: { mixed: 64 } });
    expect(r.problems).toEqual([]);
    expect(r.settings.voices.mixed).toBe(64);
    expect(r.settings.music.rings).toBe(8);
  });
});

// ADR 0175: the audio project section, in one place: parse once (memoised on the section object, frozen), the two
// write-backs and the live-key list, and the round trips draft -> settings -> draft (keys outside the live set kept as
// authored, built-in occlusion materials pruned).
import { describe, expect, it } from "vitest";
import { LIVE_KEYS, audioSection, withLiveKeys, withSettings } from "./audioSection";
import { applyOpToDraft, diffOps } from "./mixOps";
import { BUILTIN_MATERIALS } from "./occlusionMaterials";
import { parseAudioSettings } from "./settings";

const lp = { type: "lowpass", frequency: 1000 };
const AUTHORED = {
  buses: [{ name: "Master" }, { name: "Music", parent: "Master", volume: 0.8, effects: [lp, lp, lp, lp, lp] }, { name: "SFX", parent: "Master", effects: [{ type: "nope" }] }],
  voices: { mixed: 64 },
  background: "pause",
  custom: 1,
  occlusion: { materials: [{ name: "wood", transmissionDb: -10, cutoffHz: 3000, wetOcclusion: 0.5 }, { name: "Curtain", transmissionDb: -80, cutoffHz: 100, wetOcclusion: 0.25 }] },
};

describe("audioSection: parse once", () => {
  it("is parseAudioSettings' settings, problems and warnings together", () => {
    const s = audioSection(AUTHORED);
    const p = parseAudioSettings(AUTHORED);
    expect(s.settings).toEqual(p.settings);
    expect(s.problems).toEqual(p.problems);
    expect(s.warnings).toEqual(p.warnings);
    expect(s.problems.length).toBeGreaterThan(0);
    expect(s.warnings.length).toBeGreaterThan(0);
  });

  it("is memoised on the section object's identity: the same object, the same result; a new object, a new parse", () => {
    const raw = structuredClone(AUTHORED);
    expect(audioSection(raw)).toBe(audioSection(raw));
    expect(audioSection(structuredClone(raw))).not.toBe(audioSection(raw));
    expect(audioSection(undefined)).toBe(audioSection(undefined));
    expect(audioSection(undefined).settings).toEqual(parseAudioSettings(undefined).settings);
    expect(audioSection(7).problems).toEqual(["audio must be an object."]);
  });

  it("is frozen all the way down (callers share it: an edit builds a copy)", () => {
    const s = audioSection(structuredClone(AUTHORED));
    expect(Object.isFrozen(s.settings)).toBe(true);
    expect(Object.isFrozen(s.settings.buses[1]!.effects[0])).toBe(true);
    expect(() => { (s.settings.voices as { mixed: number }).mixed = 1; }).toThrow();
  });
});

describe("the round trips draft -> settings -> draft", () => {
  it("withLiveKeys writes the live keys and keeps every other key as authored (applyOpToDraft)", () => {
    const d = { audio: structuredClone(AUTHORED), name: "Game" };
    const next = applyOpToDraft(d, { op: "setBus", bus: "Music", key: "volume", value: 0.5 });
    const audio = next.audio as Record<string, unknown>;
    expect(next.name).toBe("Game");
    for (const key of Object.keys(AUTHORED)) if (!(LIVE_KEYS as readonly string[]).includes(key)) expect(audio[key], key).toEqual((AUTHORED as Record<string, unknown>)[key]);
    expect((audio.buses as { name: string; volume: number }[]).find((b) => b.name === "Music")!.volume).toBe(0.5);
    expect("loudnessTargets" in audio, "a live key at its default is absent").toBe(false);
    expect(audio.custom).toBe(1);
  });

  it("withLiveKeys removes a live key the settings leave unset", () => {
    const d = { audio: { loudnessResetOnPlay: false, voices: { mixed: 64 } } };
    const next = withLiveKeys(d, audioSection(undefined).settings);
    expect(next.audio).not.toHaveProperty("loudnessResetOnPlay");
    expect((next.audio as Record<string, unknown>).voices).toEqual({ mixed: 64 });
  });

  it("applyOpToDraft returns the draft itself when the op is refused or changes nothing", () => {
    const d = { audio: undefined };
    expect(applyOpToDraft(d, { op: "removeBus", bus: "Master" })).toBe(d);
    expect(applyOpToDraft(d, { op: "setBus", bus: "Music", key: "volume", value: 1 })).toBe(d);
  });

  it("withSettings writes the whole section with the built-in materials pruned, and parses back to the same settings", () => {
    const s = audioSection(structuredClone(AUTHORED)).settings;
    expect(s.occlusion.materials.length).toBeGreaterThan(BUILTIN_MATERIALS.length); // the effective table
    const d = withSettings({ audio: AUTHORED, name: "Game" }, s);
    const materials = (d.audio as { occlusion: { materials: { name: string }[] } }).occlusion.materials.map((m) => m.name);
    expect(materials, "only the modified built-in and the custom row").toEqual(["wood", "Curtain"]);
    expect(d.name).toBe("Game");
    expect(audioSection(d.audio).settings).toEqual(s);
  });

  it("the live keys are exactly what diffOps can carry; every other key that differs has no live path", () => {
    const a = audioSection(undefined).settings;
    const b = { ...a, voices: { ...a.voices, mixed: 64 }, rhythmMode: true, loudnessResetOnPlay: false };
    expect(diffOps(a, b).restartRequired.sort()).toEqual(["rhythmMode", "voices"]);
    expect(LIVE_KEYS).toContain("loudnessResetOnPlay");
  });
});

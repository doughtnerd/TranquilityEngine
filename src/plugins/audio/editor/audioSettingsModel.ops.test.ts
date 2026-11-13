// Mo1 (api-and-models §6.2): the settings section's model functions build a MixOp and apply it with applyOpToDraft,
// so the UI and a live op edit the same way; the M5 functions (meter, effect order, targets, reset option).
import { describe, expect, it } from "vitest";
import { applyOpToDraft, type MixOp } from "../../../engine/audio/mixOps";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { readDraft } from "../../../editor/projectSettingsModel";
import {
  addBus, addBusAutomation, addDucking, addEffect, addLoudnessTarget, addParameter, addSnapshot, audioOf, loudnessTargets, mixOpRefusal, moveEffect,
  removeBus, removeDucking, removeEffect, removeLoudnessTarget, removeSnapshot, renameBus, renameSnapshot, setBusBed, setBusBedPriority,
  setBusMaxVoices, setBusMeter, setBusParent, setBusValue, setDuckingValue, setEffectValue, setLoudnessResetOnPlay, setLoudnessTarget,
  setSnapshotLowpass, setSnapshotVolume,
} from "./audioSettingsModel";

const empty = () => readDraft({});
/**
 * Chained edits of the M5 keys need the parse to keep them (`meter`, `loudnessTargets`, `loudnessResetOnPlay`: Ld5's
 * parse, W2). Until it lands, `audioOf` drops them and a second edit can't see the first; these cases run once it does.
 */
const parseKeepsM5Keys = (() => {
  const a = parseAudioSettings({ buses: [{ name: "M" }, { name: "V", meter: "loudness" }], loudnessResetOnPlay: false, loudnessTargets: [{ name: "x", integrated: -20, tolerance: 1, truePeak: -1 }] }).settings;
  return a.buses[1].meter === "loudness" && a.loudnessResetOnPlay === false && a.loudnessTargets?.[0]?.name === "x";
})();

describe("the model functions are their ops (Mo1)", () => {
  it("each function gives the same draft as applyOpToDraft of its op", () => {
    let d = addSnapshot(addDucking(addEffect(addEffect(empty(), "Music", "lowpass"), "Music", "reverb")));
    d = addBusAutomation(addParameter(d));
    const pairs: [ReturnType<typeof empty>, MixOp][] = [
      [addBus(d, "SFX"), { op: "addBus", name: "Bus", parent: "SFX" }],
      [removeBus(d, "Music"), { op: "removeBus", bus: "Music" }],
      [renameBus(d, "Music", "Score"), { op: "renameBus", from: "Music", to: "Score" }],
      [setBusParent(d, "UI", "SFX"), { op: "moveBus", bus: "UI", parent: "SFX" }],
      [setBusValue(d, "UI", "volume", 0.3), { op: "setBus", bus: "UI", key: "volume", value: 0.3 }],
      [setBusValue(d, "UI", "mute", true), { op: "setBus", bus: "UI", key: "mute", value: true }],
      [setBusMaxVoices(d, "UI", 6), { op: "setBus", bus: "UI", key: "maxVoices", value: 6 }],
      [setBusBed(d, "UI", "none"), { op: "setBus", bus: "UI", key: "bed", value: "none" }],
      [setBusBedPriority(d, "UI", 9), { op: "setBus", bus: "UI", key: "bedPriority", value: 9 }],
      [setBusMeter(d, "UI", true), { op: "setBus", bus: "UI", key: "meter", value: "loudness" }],
      [removeEffect(d, "Music", 0), { op: "removeEffect", bus: "Music", index: 0 }],
      [moveEffect(d, "Music", 1, 0), { op: "moveEffect", bus: "Music", from: 1, to: 0 }],
      [setEffectValue(d, "Music", 0, "q", 2), { op: "setEffect", bus: "Music", index: 0, key: "q", value: 2 }],
      [removeSnapshot(d, 0), { op: "removeSnapshot", index: 0 }],
      [renameSnapshot(d, 0, "Calm"), { op: "renameSnapshot", index: 0, name: "Calm" }],
      [setSnapshotVolume(d, 0, "UI", 0.5), { op: "setSnapshot", index: 0, bus: "UI", key: "volume", value: 0.5 }],
      [setSnapshotLowpass(d, 0, "UI", 900), { op: "setSnapshot", index: 0, bus: "UI", key: "lowpass", value: 900 }],
      [removeDucking(d, 0), { op: "setDucking", index: 0, rule: null }],
      [setLoudnessResetOnPlay(d, false), { op: "setOption", key: "loudnessResetOnPlay", value: false }],
      [removeLoudnessTarget(d, 1), { op: "setTarget", index: 1, target: null }],
    ];
    for (const [fromModel, op] of pairs) {
      expect(fromModel).not.toBe(d);
      expect(fromModel).toEqual(applyOpToDraft(d, op));
    }
  });
});

describe("the M5 model functions (ADR 0171 §2.1)", () => {
  it("writes the M5 keys from a fresh draft (one edit, before Ld5's parse)", () => {
    expect((setBusMeter(empty(), "Voice", true).audio as { buses: { name: string; meter?: string }[] }).buses.find((b) => b.name === "Voice")!.meter).toBe("loudness");
    expect((addLoudnessTarget(empty()).audio as { loudnessTargets: { name: string }[] }).loudnessTargets.map((t) => t.name)).toEqual(["console", "mobile", "Target"]);
    expect((setLoudnessResetOnPlay(empty(), false).audio as { loudnessResetOnPlay?: boolean }).loudnessResetOnPlay).toBe(false);
    expect(setBusMeter(empty(), "Master", true)).toEqual(empty());
    expect(mixOpRefusal(empty(), { op: "setBus", bus: "Master", key: "meter", value: "loudness" })).toBe("Master is always metered.");
  });
  it.skipIf(!parseKeepsM5Keys)("meters a bus, refuses the root with a message, and turns it off", () => {
    const d = setBusMeter(empty(), "Voice", true);
    expect((d.audio as { buses: { name: string; meter?: string }[] }).buses.find((b) => b.name === "Voice")!.meter).toBe("loudness");
    expect(setBusMeter(empty(), "Master", true)).toEqual(empty());
    expect(mixOpRefusal(empty(), { op: "setBus", bus: "Master", key: "meter", value: "loudness" })).toBe("Master is always metered.");
    expect((setBusMeter(d, "Voice", false).audio as { buses: { meter?: string }[] }).buses.every((b) => b.meter === undefined)).toBe(true);
  });
  it("reorders effects", () => {
    const d = moveEffect(addEffect(addEffect(empty(), "Music", "lowpass"), "Music", "compressor"), "Music", 1, 0);
    expect(audioOf(d).buses.find((b) => b.name === "Music")!.effects.map((e) => e.type)).toEqual(["compressor", "lowpass"]);
  });
  it.skipIf(!parseKeepsM5Keys)("adds, edits and removes loudness targets, keeping at least one", () => {
    const a0 = audioOf(empty());
    expect(loudnessTargets(a0).map((t) => t.name)).toEqual(["console", "mobile"]);
    let d = addLoudnessTarget(empty());
    let list = (d.audio as { loudnessTargets: { name: string; integrated: number }[] }).loudnessTargets;
    expect(list.map((t) => t.name)).toEqual(["console", "mobile", "Target"]);
    d = setLoudnessTarget(d, 2, { name: " web ", integrated: -16 });
    list = (d.audio as { loudnessTargets: { name: string; integrated: number }[] }).loudnessTargets;
    expect(list[2]).toEqual({ name: "web", integrated: -16, tolerance: 2, truePeak: -1 });
    expect(setLoudnessTarget(d, 2, { name: "console" })).toBe(d);
    expect(setLoudnessTarget(d, 2, { truePeak: 4 })).toBe(d);
    // Back to the default list: the key isn't written.
    d = removeLoudnessTarget(d, 2);
    expect("loudnessTargets" in (d.audio as object)).toBe(false);
  });
  it.skipIf(!parseKeepsM5Keys)("sets loudnessResetOnPlay off and back (absent when on)", () => {
    const off = setLoudnessResetOnPlay(empty(), false);
    expect((off.audio as { loudnessResetOnPlay?: boolean }).loudnessResetOnPlay).toBe(false);
    expect("loudnessResetOnPlay" in (setLoudnessResetOnPlay(off, true).audio as object)).toBe(false);
    const d = empty();
    expect(setLoudnessResetOnPlay(d, true)).toBe(d);
  });
  it("refuses a ducking rule the parse would drop: a bus ducking itself", () => {
    const d = addDucking(empty());
    expect(setDuckingValue(d, 0, "trigger", "Music")).toBe(d);
    expect(audioOf(setDuckingValue(d, 0, "trigger", "SFX")).ducking[0].trigger).toBe("SFX");
  });
});

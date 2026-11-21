// Mo1 (api-and-models §6.2): the settings section's model functions build a MixOp and apply it with applyOpToDraft,
// so the UI and a live op edit the same way, refused with the op's own refusal (ADR 0313); the M5 functions (meter,
// effect order, targets, reset option).
import { describe, expect, it } from "vitest";
import { applyOpToDraft, opRefusal, type MixOp } from "../../../engine/audio/mixOps";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { readDraft } from "../../../editor/testing";
import { addBus, addBusAutomation, addDucking, addEffect, addLoudnessTarget, addSnapshot, globalParameterList, loudnessTargets, moveEffect, removeBus, removeDucking, removeEffect, removeLoudnessTarget, removeSnapshot, renameBus, renameSnapshot, setBusBed, setBusBedPriority, setBusMaxVoices, setBusMeter, setBusParent, setBusValue, setDuckingValue, setEffectValue, setLoudnessResetOnPlay, setLoudnessTarget, setSnapshotLowpass, setSnapshotVolume } from "./audioSettingsModel";
import { audioSettings } from "./audioDraft";
import { refusalOf, type EditResult } from "./editResult";

/** The accepted draft of an edit (ADR 0307), or the test fails with its refusal. */
const nextOf = <T,>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

const empty = () => readDraft({});

describe("the model functions are their ops (Mo1)", () => {
  it("each function gives the same draft as applyOpToDraft of its op", () => {
    let d = nextOf(addSnapshot(nextOf(addDucking(nextOf(addEffect(nextOf(addEffect(empty(), "Music", "lowpass")), "Music", "reverb"))))));
    d = nextOf(addBusAutomation(nextOf(globalParameterList.add(d))));
    const pairs: [ReturnType<typeof empty>, MixOp][] = [
      [nextOf(addBus(d, "SFX")), { op: "addBus", name: "Bus", parent: "SFX" }],
      [nextOf(removeBus(d, "Music")), { op: "removeBus", bus: "Music" }],
      [nextOf(renameBus(d, "Music", "Score")), { op: "renameBus", from: "Music", to: "Score" }],
      [nextOf(setBusParent(d, "UI", "SFX")), { op: "moveBus", bus: "UI", parent: "SFX" }],
      [nextOf(setBusValue(d, "UI", "volume", 0.3)), { op: "setBus", bus: "UI", key: "volume", value: 0.3 }],
      [nextOf(setBusValue(d, "UI", "mute", true)), { op: "setBus", bus: "UI", key: "mute", value: true }],
      [nextOf(setBusMaxVoices(d, "UI", 6)), { op: "setBus", bus: "UI", key: "maxVoices", value: 6 }],
      [nextOf(setBusBed(d, "UI", "none")), { op: "setBus", bus: "UI", key: "bed", value: "none" }],
      [nextOf(setBusBedPriority(d, "UI", 9)), { op: "setBus", bus: "UI", key: "bedPriority", value: 9 }],
      [nextOf(setBusMeter(d, "UI", true)), { op: "setBus", bus: "UI", key: "meter", value: "loudness" }],
      [nextOf(removeEffect(d, "Music", 0)), { op: "removeEffect", bus: "Music", index: 0 }],
      [nextOf(moveEffect(d, "Music", 1, 0)), { op: "moveEffect", bus: "Music", from: 1, to: 0 }],
      [nextOf(setEffectValue(d, "Music", 0, "q", 2)), { op: "setEffect", bus: "Music", index: 0, key: "q", value: 2 }],
      [nextOf(removeSnapshot(d, 0)), { op: "removeSnapshot", index: 0 }],
      [nextOf(renameSnapshot(d, 0, "Calm")), { op: "renameSnapshot", index: 0, name: "Calm" }],
      [nextOf(setSnapshotVolume(d, 0, "UI", 0.5)), { op: "setSnapshot", index: 0, bus: "UI", key: "volume", value: 0.5 }],
      [nextOf(setSnapshotLowpass(d, 0, "UI", 900)), { op: "setSnapshot", index: 0, bus: "UI", key: "lowpass", value: 900 }],
      [nextOf(removeDucking(d, 0)), { op: "setDucking", index: 0, rule: null }],
      [nextOf(setLoudnessResetOnPlay(d, false)), { op: "setOption", key: "loudnessResetOnPlay", value: false }],
      [nextOf(removeLoudnessTarget(d, 1)), { op: "setTarget", index: 1, target: null }],
    ];
    for (const [fromModel, op] of pairs) {
      expect(fromModel).not.toBe(d);
      expect(fromModel).toEqual(applyOpToDraft(d, op));
    }
  });
});

describe("the M5 model functions (ADR 0171 §2.1)", () => {
  it("the parse keeps the M5 keys, so chained edits see each other (Ld5)", () => {
    const a = parseAudioSettings({ buses: [{ name: "M" }, { name: "V", meter: "loudness" }], loudnessResetOnPlay: false, loudnessTargets: [{ name: "x", integrated: -20, tolerance: 1, truePeak: -1 }] }).settings;
    expect([a.buses[1]!.meter, a.loudnessResetOnPlay, a.loudnessTargets?.[0]?.name]).toEqual(["loudness", false, "x"]);
  });
  it("writes the M5 keys from a fresh draft (one edit, before Ld5's parse)", () => {
    expect((nextOf(setBusMeter(empty(), "Voice", true)).audio as { buses: { name: string; meter?: string }[] }).buses.find((b) => b.name === "Voice")!.meter).toBe("loudness");
    expect((nextOf(addLoudnessTarget(empty())).audio as { loudnessTargets: { name: string }[] }).loudnessTargets.map((t) => t.name)).toEqual(["console", "mobile", "Target"]);
    expect((nextOf(setLoudnessResetOnPlay(empty(), false)).audio as { loudnessResetOnPlay?: boolean }).loudnessResetOnPlay).toBe(false);
    expect(setBusMeter(empty(), "Master", true)).toEqual({ refused: "Master is always metered" });
  });
  it("meters a bus, refuses the root with a message, and turns it off", () => {
    const d = nextOf(setBusMeter(empty(), "Voice", true));
    expect((d.audio as { buses: { name: string; meter?: string }[] }).buses.find((b) => b.name === "Voice")!.meter).toBe("loudness");
    expect(setBusMeter(empty(), "Master", true)).toEqual({ refused: opRefusal(audioSettings.read(empty()), { op: "setBus", bus: "Master", key: "meter", value: "loudness" }) });
    expect((nextOf(setBusMeter(d, "Voice", false)).audio as { buses: { meter?: string }[] }).buses.every((b) => b.meter === undefined)).toBe(true);
  });
  it("reorders effects", () => {
    const d = nextOf(moveEffect(nextOf(addEffect(nextOf(addEffect(empty(), "Music", "lowpass")), "Music", "compressor")), "Music", 1, 0));
    expect(audioSettings.read(d).buses.find((b) => b.name === "Music")!.effects.map((e) => e.type)).toEqual(["compressor", "lowpass"]);
  });
  it("adds, edits and removes loudness targets, keeping at least one", () => {
    const a0 = audioSettings.read(empty());
    expect(loudnessTargets(a0).map((t) => t.name)).toEqual(["console", "mobile"]);
    let d = nextOf(addLoudnessTarget(empty()));
    let list = (d.audio as { loudnessTargets: { name: string; integrated: number }[] }).loudnessTargets;
    expect(list.map((t) => t.name)).toEqual(["console", "mobile", "Target"]);
    d = nextOf(setLoudnessTarget(d, 2, { name: " web ", integrated: -16 }));
    list = (d.audio as { loudnessTargets: { name: string; integrated: number }[] }).loudnessTargets;
    expect(list[2]).toEqual({ name: "web", integrated: -16, tolerance: 2, truePeak: -1 });
    expect(refusalOf(setLoudnessTarget(d, 2, { name: "console" }))).toMatch(/already named "console"/);
    expect(refusalOf(setLoudnessTarget(d, 2, { truePeak: 4 }))).toMatch(/must be/);
    // Back to the default list: the key isn't written.
    d = nextOf(removeLoudnessTarget(d, 2));
    expect("loudnessTargets" in (d.audio as object)).toBe(false);
  });
  it("sets loudnessResetOnPlay off and back (absent when on)", () => {
    const off = nextOf(setLoudnessResetOnPlay(empty(), false));
    expect((off.audio as { loudnessResetOnPlay?: boolean }).loudnessResetOnPlay).toBe(false);
    expect("loudnessResetOnPlay" in (nextOf(setLoudnessResetOnPlay(off, true)).audio as object)).toBe(false);
    const d = empty();
    expect(setLoudnessResetOnPlay(d, true)).toEqual({ next: d });
  });
  it("refuses an op the parse would drop with its message, the draft unchanged", () => {
    const d = empty();
    expect(removeBus(d, "Master")).toEqual({ refused: "Master is the root bus and can't be removed." });
    expect(setBusValue(d, "Nope", "volume", 1)).toEqual({ refused: 'No bus named "Nope".' });
    expect(refusalOf(setEffectValue(d, "Music", 0, "q", 2))).not.toBeNull();
    expect(refusalOf(removeSnapshot(d, 0))).not.toBeNull();
  });
  it("refuses a ducking rule the parse would drop: a bus ducking itself", () => {
    const d = nextOf(addDucking(empty()));
    expect(setDuckingValue(d, 0, "trigger", "Music")).toHaveProperty("refused");
    expect(audioSettings.read(nextOf(setDuckingValue(d, 0, "trigger", "SFX"))).ducking[0].trigger).toBe("SFX");
  });
  it("refuses renaming a bus or a snapshot to a taken or empty name, with the op's message (no silent no-op)", () => {
    const d = nextOf(addSnapshot(nextOf(addSnapshot(empty()))));
    expect(renameBus(d, "Music", "SFX")).toEqual({ refused: 'Another bus is already named "SFX".' });
    expect(renameBus(d, "Music", "  ")).toEqual({ refused: "A bus needs a name." });
    expect(renameBus(d, "Nope", "X")).toEqual({ refused: 'No bus named "Nope".' });
    expect(renameSnapshot(d, 1, "Snapshot")).toEqual({ refused: 'Another snapshot is already named "Snapshot".' });
    expect(renameSnapshot(d, 0, "")).toEqual({ refused: "A snapshot needs a name." });
    // The same name (trimmed) is no change: the draft itself comes back.
    expect(renameBus(d, "Music", "Music ")).toEqual({ next: d });
    expect(renameSnapshot(d, 0, " Snapshot")).toEqual({ next: d });
  });
});

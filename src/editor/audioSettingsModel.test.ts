import { describe, expect, it } from "vitest";
import { addBus, addDucking, addEffect, addSnapshot, audioOf, busTree, removeBus, renameBus, setBusParent, setBusValue, setSnapshotVolume } from "./audioSettingsModel";
import { readDraft, withSettings } from "./projectSettingsModel";

const empty = () => readDraft({});

describe("audio settings model (ADR 0097)", () => {
  it("adds buses with unique names under a parent and shows them as a tree", () => {
    let d = addBus(empty());
    d = addBus(d, "Bus");
    expect(busTree(audioOf(d)).map((n) => `${"-".repeat(n.depth)}${n.bus.name}`)).toEqual(["Master", "-Music", "-SFX", "-UI", "-Voice", "-Bus", "--Bus 2"]);
  });
  it("renames everywhere, removes with descendants and scrubs references", () => {
    let d = addBus(empty(), "Music");
    d = addSnapshot(d);
    d = setSnapshotVolume(d, 0, "Bus", 0.5);
    d = addDucking(d);
    d = renameBus(d, "Music", "Score");
    expect(audioOf(d).buses.find((b) => b.name === "Bus")!.parent).toBe("Score");
    expect(audioOf(d).ducking[0].target).toBe("Score");
    d = removeBus(d, "Score");
    const a = audioOf(d);
    expect(a.buses.map((b) => b.name)).toEqual(["Master", "SFX", "UI", "Voice"]);
    expect(a.snapshots[0].volumes).toEqual({});
    expect(a.ducking).toEqual([]);
  });
  it("won't remove the root, create loops or duplicate names", () => {
    const d = empty();
    expect(removeBus(d, "Master")).toBe(d);
    expect(setBusParent(d, "Master", "Music")).toBe(d);
    const nested = addBus(d, "Music");
    expect(setBusParent(nested, "Music", "Bus")).toBe(nested);
    expect(renameBus(d, "Music", "SFX")).toBe(d);
  });
  it("edits values and effects, and writes the section into project.json text", () => {
    let d = setBusValue(empty(), "Music", "volume", 0.6);
    d = addEffect(d, "Music", "lowpass");
    const text = withSettings("{}", d, {});
    const audio = JSON.parse(text).audio;
    expect(audio.buses.find((b: { name: string }) => b.name === "Music")).toMatchObject({ volume: 0.6, effects: [{ type: "lowpass", frequency: 20000 }] });
  });
});

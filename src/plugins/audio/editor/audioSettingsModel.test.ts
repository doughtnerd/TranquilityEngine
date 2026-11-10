import { describe, expect, it } from "vitest";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { MAX_PARAMETERS } from "../../../engine/audio/eventFormat";
import { readDraft, withSettings } from "../../../editor/projectSettingsModel";
import {
  addBus, addDucking, addEffect, addSnapshot, applyVoicesPreset, audioOf, busTree, removeBus, renameBus, setBackend, setBackground, setBusMaxVoices, setBusParent, setBusValue,
  addBusAutomation, addParameter, removeBusAutomation, removeParameter, renameParameter, setBusAutomationBus, setBusAutomationCurve, setBusAutomationParameter,
  setBusAutomationTarget, setParameterDefaultLabel, setParameterLabelled, setParameterLabels, setParameterRange,
  setClipFormat, setClipMemory, setCodec, setLimiterLookahead, setSnapshotVolume, setSpatial, setVoices, voicesPreset,
} from "./audioSettingsModel";

const empty = () => readDraft({});
const bus = (d: ReturnType<typeof empty>, name: string) => audioOf(d).buses.find((b) => b.name === name)!;

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

describe("audio settings model, the core keys (ADR 0157 §2, K13)", () => {
  it("sets a bus's maxVoices rounded and clamped to 1..voices.logical, and unlimited with undefined", () => {
    let d = setBusMaxVoices(empty(), "SFX", 15.6);
    expect(bus(d, "SFX").maxVoices).toBe(16);
    d = setBusMaxVoices(d, "SFX", 0);
    expect(bus(d, "SFX").maxVoices).toBe(1);
    d = setBusMaxVoices(d, "SFX", 99999);
    expect(bus(d, "SFX").maxVoices).toBe(4096);
    d = setBusMaxVoices(d, "SFX", undefined);
    expect("maxVoices" in bus(d, "SFX")).toBe(false);
    const same = empty();
    expect(setBusMaxVoices(same, "Nope", 4)).toBe(same);
  });
  it("keeps maxVoices when a bus is renamed", () => {
    const d = renameBus(setBusMaxVoices(empty(), "SFX", 8), "SFX", "Effects");
    expect(bus(d, "Effects").maxVoices).toBe(8);
  });
  it("sets voices within range, keeps logical >= mixed and clamps bus limits to a lowered logical", () => {
    let d = setBusMaxVoices(empty(), "SFX", 2000);
    d = setVoices(d, { mixed: 1000, hrtf: 99 });
    expect(audioOf(d).voices).toEqual({ mixed: 512, logical: 4096, hrtf: 32 });
    d = setVoices(d, { logical: 600 });
    expect(audioOf(d).voices.logical).toBe(600);
    expect(bus(d, "SFX").maxVoices).toBe(600);
    d = setVoices(d, { mixed: 8, logical: 3 });
    expect(audioOf(d).voices).toMatchObject({ mixed: 8, logical: 8 });
    expect(audioOf(setVoices(d, { mixed: NaN })).voices).toEqual(audioOf(d).voices);
  });
  it("applies voice presets, names the matching one and falls back to custom", () => {
    expect(voicesPreset(audioOf(empty()))).toBe("default");
    const low = applyVoicesPreset(empty(), "low");
    expect(voicesPreset(audioOf(low))).toBe("low");
    expect(audioOf(low).clipMemoryMB).toBe(64);
    const back = applyVoicesPreset(low, "default");
    expect(audioOf(back).clipMemoryMB).toBeUndefined();
    expect(voicesPreset(audioOf(back))).toBe("default");
    expect(voicesPreset(audioOf(setVoices(low, { hrtf: 5 })))).toBe("custom");
  });
  it("sets background, clip memory, clip format, codec, spatial and backend; the result re-parses without problems", () => {
    let d = setBackground(empty(), "pause");
    d = setClipMemory(d, 5000);
    expect(audioOf(d).clipMemoryMB).toBe(1024);
    d = setClipMemory(d, 3);
    expect(audioOf(d).clipMemoryMB).toBe(16);
    d = setClipFormat(d, "f32");
    d = setCodec(d, "aac", true);
    d = setSpatial(d, "equalPower");
    d = setBackend(d, "core");
    d = setBusMaxVoices(d, "Music", 8);
    const text = withSettings("{}", d, {});
    const parsed = parseAudioSettings(JSON.parse(text).audio);
    expect(parsed.problems).toEqual([]);
    expect(parsed.settings).toMatchObject({ background: "pause", clipMemoryMB: 16, clipFormat: "f32", codecs: { aac: true }, spatial: "equalPower", backend: "core" });
    expect(audioOf(setClipMemory(d, undefined)).clipMemoryMB).toBeUndefined();
    const same = empty();
    expect(setSpatial(same, "hrtf")).toBe(same);
    expect(setCodec(same, "aac", false)).toBe(same);
    expect(setBackground(same, "mute")).toBe(same);
    expect(setClipFormat(same, "i16")).toBe(same);
  });
  it("sets the limiter look-ahead in ms, clamped to 0..5 and not rounded; non-finite is the 1.5 default; it re-parses", () => {
    const same = empty();
    expect(audioOf(same).limiterLookaheadMs).toBe(1.5);
    expect(setLimiterLookahead(same, 1.5)).toBe(same);
    let d = setLimiterLookahead(same, 2.25);
    expect(audioOf(d).limiterLookaheadMs).toBe(2.25);
    d = setLimiterLookahead(d, 9);
    expect(audioOf(d).limiterLookaheadMs).toBe(5);
    d = setLimiterLookahead(d, -3);
    expect(audioOf(d).limiterLookaheadMs).toBe(0);
    const parsed = parseAudioSettings(JSON.parse(withSettings("{}", d, {})).audio);
    expect(parsed.problems).toEqual([]);
    expect(parsed.settings.limiterLookaheadMs).toBe(0);
    expect(audioOf(setLimiterLookahead(d, Number.NaN)).limiterLookaheadMs).toBe(1.5);
  });
});

// Written by the coordinator (not a stub): the existing bus edits keep automation consistent.
describe("bus edits and automation (ADR 0158 §3)", () => {
  it("renames and removes buses in the automation too", () => {
    let d = readDraft({ audio: { parameters: [{ name: "P", min: 0, max: 1 }], automation: [{ bus: "Music", parameter: "P", target: "volume", curve: [[0, 1], [1, 0]] }] } });
    d = renameBus(d, "Music", "Score");
    expect(audioOf(d).automation[0].bus).toBe("Score");
    d = removeBus(d, "Score");
    expect(audioOf(d).automation).toEqual([]);
  });
});

describe("global parameters and bus automation (ADR 0158 §2, §3; L6.5a)", () => {
  it("adds numeric and labelled parameters with unique names, up to MAX_PARAMETERS", () => {
    let d = addParameter(empty());
    expect(audioOf(d).parameters).toEqual([{ name: "Parameter", min: 0, max: 1, default: 0, seekSpeed: 0 }]);
    d = addParameter(d);
    expect(audioOf(d).parameters.map((p) => p.name)).toEqual(["Parameter", "Parameter 2"]);
    d = addParameter(d, true);
    expect(audioOf(d).parameters[2]).toEqual({ name: "Parameter 3", labels: ["State 1", "State 2"], default: "State 1" });
    let full = empty();
    for (let i = 0; i < MAX_PARAMETERS; i++) full = addParameter(full);
    expect(audioOf(full).parameters).toHaveLength(MAX_PARAMETERS);
    expect(addParameter(full)).toBe(full);
    expect(addParameter(full, true)).toBe(full);
    expect(parseAudioSettings(JSON.parse(withSettings("{}", full, {})).audio).problems).toEqual([]);
  });
  it("removes a parameter and the automation that names it; unknown names change nothing", () => {
    let d = readDraft({ audio: {
      parameters: [{ name: "A", min: 0, max: 1, default: 0, seekSpeed: 0 }, { name: "B", labels: ["x", "y"], default: "x" }],
      automation: [
        { bus: "Music", parameter: "A", target: "volume", curve: [[0, 1], [1, 0]] },
        { bus: "SFX", parameter: "B", target: "lowpass", curve: [[0, 24000], [1, 800]] },
      ],
    } });
    d = removeParameter(d, "A");
    expect(audioOf(d).parameters.map((p) => p.name)).toEqual(["B"]);
    expect(audioOf(d).automation.map((r) => r.parameter)).toEqual(["B"]);
    expect(removeParameter(d, "Nope")).toBe(d);
  });
  it("renames a parameter and the automation that names it; rejects empty, taken and unknown names", () => {
    let d = readDraft({ audio: {
      parameters: [{ name: "A", min: 0, max: 1, default: 0, seekSpeed: 0 }, { name: "B", labels: ["x", "y"], default: "x" }],
      automation: [{ bus: "Music", parameter: "A", target: "volume", curve: [[0, 1], [1, 0]] }],
    } });
    d = renameParameter(d, "A", "  Intensity ");
    expect(audioOf(d).parameters.map((p) => p.name)).toEqual(["Intensity", "B"]);
    expect(audioOf(d).automation[0].parameter).toBe("Intensity");
    expect(renameParameter(d, "Intensity", "   ")).toBe(d);
    expect(renameParameter(d, "Intensity", "B")).toBe(d);
    expect(renameParameter(d, "Intensity", "Intensity")).toBe(d);
    expect(renameParameter(d, "Nope", "C")).toBe(d);
  });
  it("switches a parameter between numeric and labelled", () => {
    let d = addParameter(empty());
    d = setParameterLabelled(d, "Parameter", true);
    expect(audioOf(d).parameters[0]).toEqual({ name: "Parameter", labels: ["State 1", "State 2"], default: "State 1" });
    expect(setParameterLabelled(d, "Parameter", true)).toBe(d);
    let e = readDraft({ audio: { parameters: [{ name: "Area", labels: ["Outdoor", "Cave", "Hall"], default: "Hall" }] } });
    e = setParameterLabelled(e, "Area", false);
    expect(audioOf(e).parameters[0]).toEqual({ name: "Area", min: 0, max: 2, default: 2, seekSpeed: 0 });
    expect(setParameterLabelled(e, "Area", false)).toBe(e);
    expect(setParameterLabelled(e, "Nope", true)).toBe(e);
    expect(parseAudioSettings(JSON.parse(withSettings("{}", e, {})).audio).problems).toEqual([]);
  });
  it("sets a numeric range: swaps min above max, clamps the default, clamps seekSpeed to 0 or more, ignores non-finite, ignores labelled", () => {
    let d = readDraft({ audio: {
      parameters: [{ name: "I", min: 0, max: 1, default: 0.5, seekSpeed: 0 }, { name: "Area", labels: ["a", "b"], default: "a" }],
    } });
    d = setParameterRange(d, "I", { min: 2, max: -1 });
    expect(audioOf(d).parameters[0]).toEqual({ name: "I", min: -1, max: 2, default: 0.5, seekSpeed: 0 });
    d = setParameterRange(d, "I", { default: 10, seekSpeed: -3 });
    expect(audioOf(d).parameters[0]).toEqual({ name: "I", min: -1, max: 2, default: 2, seekSpeed: 0 });
    d = setParameterRange(d, "I", { min: NaN, max: Infinity, seekSpeed: 4 });
    expect(audioOf(d).parameters[0]).toEqual({ name: "I", min: -1, max: 2, default: 2, seekSpeed: 4 });
    d = setParameterRange(d, "I", { min: 5 });
    expect(audioOf(d).parameters[0]).toEqual({ name: "I", min: 2, max: 5, default: 2, seekSpeed: 4 });
    expect(setParameterRange(d, "Area", { min: 0, max: 3 })).toBe(d);
    expect(setParameterRange(d, "Nope", { min: 0 })).toBe(d);
    expect(parseAudioSettings(JSON.parse(withSettings("{}", d, {})).audio).problems).toEqual([]);
  });
  it("sets labels (trimmed, deduplicated, no empties), keeps or resets the default; refuses an empty list; sets the default label only to an existing label", () => {
    let d = readDraft({ audio: {
      parameters: [{ name: "Area", labels: ["Outdoor", "Cave"], default: "Cave" }, { name: "I", min: 0, max: 1, default: 0, seekSpeed: 0 }],
    } });
    d = setParameterLabels(d, "Area", [" Hall ", "", "Cave", "Hall", "Outdoor"]);
    expect(audioOf(d).parameters[0]).toEqual({ name: "Area", labels: ["Hall", "Cave", "Outdoor"], default: "Cave" });
    d = setParameterLabels(d, "Area", ["Cave ", "Field"]);
    expect(audioOf(d).parameters[0]).toEqual({ name: "Area", labels: ["Cave", "Field"], default: "Cave" });
    d = setParameterLabels(d, "Area", ["Field", "Hall"]);
    expect(audioOf(d).parameters[0]).toEqual({ name: "Area", labels: ["Field", "Hall"], default: "Field" });
    expect(setParameterLabels(d, "Area", ["", "  "])).toBe(d);
    expect(setParameterLabels(d, "I", ["x"])).toBe(d);
    d = setParameterDefaultLabel(d, "Area", "Hall");
    expect(audioOf(d).parameters[0]).toMatchObject({ default: "Hall" });
    expect(setParameterDefaultLabel(d, "Area", "Nope")).toBe(d);
    expect(setParameterDefaultLabel(d, "I", "x")).toBe(d);
    expect(parseAudioSettings(JSON.parse(withSettings("{}", d, {})).audio).problems).toEqual([]);
  });
  it("adds bus automation on the first parameter with a flat curve over its range; nothing without parameters or for an unknown bus", () => {
    let d = readDraft({ audio: {
      parameters: [{ name: "I", min: 0.5, max: 2, default: 1, seekSpeed: 0 }, { name: "Area", labels: ["a", "b", "c"], default: "a" }],
    } });
    d = addBusAutomation(d);
    expect(audioOf(d).automation).toEqual([{ bus: "Music", parameter: "I", target: "volume", curve: [[0.5, 1], [2, 1]] }]);
    d = addBusAutomation(d, "SFX");
    expect(audioOf(d).automation[1].bus).toBe("SFX");
    expect(addBusAutomation(d, "Nope")).toBe(d);
    const bare = empty();
    expect(addBusAutomation(bare)).toBe(bare);
    let noMusic = addParameter(removeBus(empty(), "Music"));
    noMusic = addBusAutomation(noMusic);
    expect(audioOf(noMusic).automation[0]).toEqual({ bus: "SFX", parameter: "Parameter", target: "volume", curve: [[0, 1], [1, 1]] });
    let z = readDraft({ audio: { parameters: [{ name: "Fixed", min: 3, max: 3, default: 3, seekSpeed: 0 }] } });
    z = addBusAutomation(z);
    expect(audioOf(z).automation[0].curve).toEqual([[3, 1], [4, 1]]);
    expect(parseAudioSettings(JSON.parse(withSettings("{}", d, {})).audio).problems).toEqual([]);
  });
  it("removes, retargets and re-buses automation entries; out-of-range indexes and unknown names change nothing", () => {
    let d = readDraft({ audio: {
      parameters: [{ name: "I", min: 0, max: 1, default: 0, seekSpeed: 0 }],
      automation: [
        { bus: "Music", parameter: "I", target: "volume", curve: [[0, 1], [1, 0.5]] },
        { bus: "SFX", parameter: "I", target: "lowpass", curve: [[0, 24000], [1, 800]] },
      ],
    } });
    expect(removeBusAutomation(d, 2)).toBe(d);
    expect(removeBusAutomation(d, -1)).toBe(d);
    expect(setBusAutomationBus(d, 5, "UI")).toBe(d);
    expect(setBusAutomationBus(d, 0, "Nope")).toBe(d);
    d = setBusAutomationBus(d, 0, "UI");
    expect(audioOf(d).automation[0].bus).toBe("UI");
    d = setBusAutomationTarget(d, 0, "lowpass");
    expect(audioOf(d).automation[0]).toMatchObject({ target: "lowpass" });
    d = removeBusAutomation(d, 0);
    expect(audioOf(d).automation.map((r) => r.bus)).toEqual(["SFX"]);
    expect(parseAudioSettings(JSON.parse(withSettings("{}", d, {})).audio).problems).toEqual([]);
  });
  it("re-pointing an entry at another parameter maps the curve's x range, keeping interpolation keys", () => {
    let d = readDraft({ audio: {
      parameters: [
        { name: "I", min: 0, max: 1, default: 0, seekSpeed: 0 },
        { name: "Area", labels: ["Outdoor", "Cave", "Hall"], default: "Outdoor" },
        { name: "Fixed", min: 3, max: 3, default: 3, seekSpeed: 0 },
      ],
      automation: [{ bus: "Music", parameter: "I", target: "volume", curve: [[0, 0.4], [0.5, 1, "smooth"], [1, 1]] }],
    } });
    d = setBusAutomationParameter(d, 0, "Area");
    expect(audioOf(d).automation[0]).toEqual({ bus: "Music", parameter: "Area", target: "volume", curve: [[0, 0.4], [1, 1, "smooth"], [2, 1]] });
    expect(setBusAutomationParameter(d, 0, "Area")).toBe(d);
    expect(setBusAutomationParameter(d, 0, "Nope")).toBe(d);
    expect(setBusAutomationParameter(d, 4, "I")).toBe(d);
    d = setBusAutomationParameter(d, 0, "Fixed");
    expect(audioOf(d).automation[0].curve).toEqual([[3, 0.4], [3, 1, "smooth"], [3, 1]]);
    d = setBusAutomationParameter(d, 0, "Area");
    expect(audioOf(d).automation[0].curve).toEqual([[0, 0.4], [0, 1, "smooth"], [0, 1]]);
    expect(parseAudioSettings(JSON.parse(withSettings("{}", d, {})).audio).problems).toEqual([]);
  });
  it("switching an entry's target resets the curve flat at 1 (volume) or 24000 (lowpass)", () => {
    let d = readDraft({ audio: {
      parameters: [{ name: "Area", labels: ["Outdoor", "Cave", "Hall"], default: "Outdoor" }],
      automation: [{ bus: "Music", parameter: "Area", target: "volume", curve: [[0, 0.4], [2, 1]] }],
    } });
    d = setBusAutomationTarget(d, 0, "lowpass");
    expect(audioOf(d).automation[0]).toEqual({ bus: "Music", parameter: "Area", target: "lowpass", curve: [[0, 24000], [2, 24000]] });
    d = setBusAutomationTarget(d, 0, "volume");
    expect(audioOf(d).automation[0]).toEqual({ bus: "Music", parameter: "Area", target: "volume", curve: [[0, 1], [2, 1]] });
    expect(setBusAutomationTarget(d, 0, "volume")).toBe(d);
    expect(setBusAutomationTarget(d, 3, "lowpass")).toBe(d);
    expect(parseAudioSettings(JSON.parse(withSettings("{}", d, {})).audio).problems).toEqual([]);
  });
  it("sets a curve (empty refused, over MAX_CURVE_KEYS cut) and the result survives the lenient parse with no problems", () => {
    let d = readDraft({ audio: {
      parameters: [{ name: "I", min: 0, max: 1, default: 0, seekSpeed: 0 }],
      automation: [{ bus: "Music", parameter: "I", target: "volume", curve: [[0, 1], [1, 0]] }],
    } });
    expect(setBusAutomationCurve(d, 0, [])).toBe(d);
    expect(setBusAutomationCurve(d, 4, [[0, 1]])).toBe(d);
    d = setBusAutomationCurve(d, 0, [[0, 0.2], [0.5, 1, "smooth"], [1, 0]]);
    expect(audioOf(d).automation[0].curve).toEqual([[0, 0.2], [0.5, 1, "smooth"], [1, 0]]);
    const many = Array.from({ length: 40 }, (_, i) => [i / 39, i % 2] as const);
    d = setBusAutomationCurve(d, 0, many);
    expect(audioOf(d).automation[0].curve).toHaveLength(32);
    const parsed = parseAudioSettings(JSON.parse(withSettings("{}", d, {})).audio);
    expect(parsed.problems).toEqual([]);
    expect(parsed.settings.automation[0].curve).toHaveLength(32);
  });
});

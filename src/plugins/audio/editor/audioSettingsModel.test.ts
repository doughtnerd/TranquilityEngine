import { describe, expect, it } from "vitest";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { MAX_PARAMETERS } from "../../../engine/audio/eventFormat";
import { readDraft, withSettings } from "../../../editor/projectSettingsModel";
import {
  addBus, addDucking, addEffect, addSnapshot, applyVoicesPreset, audioOf, audioProblems, VOICE_PRESETS, busTree, removeBus, renameBus, setBackend, setBackground, setBusMaxVoices, setBusParent, setBusValue,
  addBusAutomation, addParameter, removeBusAutomation, removeParameter, renameParameter, setBusAutomationBus, setBusAutomationCurve, setBusAutomationParameter,
  setBusAutomationTarget, setParameterDefaultLabel, setParameterLabelled, setParameterLabels, setParameterRange,
  setClipFormat, setClipMemory, setCodec, setLimiterLookahead, setSnapshotVolume, setSpatial, setVoices, voicesPreset, setMusicRings, setRhythmMode,
  addMaterial, bedPlan, lostBeds, materialIsModified, physicsLayerNames, removeMaterial, renameMaterial, resetMaterial, setBed, setBusBed, setBusBedPriority, setDoppler, setMaterial, setMaxClips, setOcclusion, setZones, toggleOcclusionLayer, zoneMemory, zoneWarnings,
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
  it("the presets carry ADR 0162's numbers: HRTF 4/8/8, maxBeds 0/2/4, maxClips 1/1/2, and the comparison reads them", () => {
    expect(VOICE_PRESETS.low).toMatchObject({ voices: { hrtf: 4 }, maxBeds: 0, maxClips: 1 });
    expect(VOICE_PRESETS.default).toMatchObject({ voices: { hrtf: 8 }, maxBeds: 2, maxClips: 1 });
    expect(VOICE_PRESETS.high).toMatchObject({ voices: { hrtf: 8 }, maxBeds: 4, maxClips: 2 });
    const high = audioOf(applyVoicesPreset(empty(), "high"));
    expect(high.bed.maxBeds).toBe(4);
    expect(high.ambisonic.maxClips).toBe(2);
    expect(voicesPreset(high)).toBe("high");
    expect(voicesPreset({ ...high, bed: { maxBeds: 3 } })).toBe("custom");
    expect(voicesPreset({ ...high, ambisonic: { maxClips: 1 } })).toBe("custom");
    const low = audioOf(applyVoicesPreset(empty(), "low"));
    expect(low.bed.maxBeds).toBe(0);
    expect(voicesPreset(audioOf(applyVoicesPreset(applyVoicesPreset(empty(), "high"), "default")))).toBe("default");
  });
  it("music rings: presets write 8/12/16, the comparison includes them, edits clamp, persist and re-parse", () => {
    expect(VOICE_PRESETS.low.musicRings).toBe(8);
    expect(VOICE_PRESETS.high.musicRings).toBe(16);
    expect(audioOf(applyVoicesPreset(empty(), "low")).music.rings).toBe(8);
    expect(audioOf(applyVoicesPreset(applyVoicesPreset(empty(), "high"), "default")).music.rings).toBe(12);
    const high = applyVoicesPreset(empty(), "high");
    const odd = setMusicRings(high, 10);
    expect(audioOf(odd).music.rings).toBe(10);
    expect(voicesPreset(audioOf(odd))).toBe("custom");
    expect(voicesPreset(audioOf(applyVoicesPreset(odd, "high")))).toBe("high");
    expect((odd.audio as { music: { rings: number } }).music.rings).toBe(10);
    expect(audioOf(setMusicRings(empty(), 99)).music.rings).toBe(16);
    expect(audioOf(setMusicRings(empty(), -3)).music.rings).toBe(0);
    expect(audioOf(setMusicRings(empty(), 6.6)).music.rings).toBe(7);
    const same = empty();
    expect(setMusicRings(same, NaN)).toBe(same);
    expect(setMusicRings(same, 12)).toBe(same);
    expect(audioProblems(odd)).toEqual([]);
  });
  it("rhythm mode persists and re-parses", () => {
    const on = setRhythmMode(empty(), true);
    expect(audioOf(on).rhythmMode).toBe(true);
    expect((on.audio as { rhythmMode: boolean }).rhythmMode).toBe(true);
    expect(audioProblems(on)).toEqual([]);
    expect(audioOf(setRhythmMode(on, false)).rhythmMode).toBe(false);
    expect(setRhythmMode(on, true)).toBe(on);
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

describe("ADR 0162 E3: beds, occlusion, materials, zones, Doppler", () => {
  const roundTrip = (d: ReturnType<typeof empty>) => parseAudioSettings(JSON.parse(withSettings("{}", d, {})).audio, { physicsLayers: physicsLayerNames(d) });
  const clean = (d: ReturnType<typeof empty>) => {
    const r = roundTrip(d);
    expect(r.problems).toEqual([]);
    return r.settings;
  };

  it("sets maxBeds and maxClips (rounded, clamped) and they persist", () => {
    let d = setBed(empty(), 3.6);
    d = setMaxClips(d, 9);
    expect(clean(d)).toMatchObject({ bed: { maxBeds: 4 }, ambisonic: { maxClips: 4 } });
    expect(clean(setBed(d, -2)).bed.maxBeds).toBe(0);
    expect(setBed(d, Number.NaN)).toBe(d);
    expect(setBed(d, 4)).toBe(d);
  });

  it("stores a bus's bed and priority only when they differ from the default, and round-trips them", () => {
    let d = setBusBed(empty(), "SFX", "own");
    d = setBusBedPriority(d, "SFX", 200.4);
    d = setBusBed(d, "Music", "none");
    expect(bus(d, "SFX")).toMatchObject({ bed: "own", bedPriority: 200 });
    const s = clean(d);
    expect(s.buses.find((b) => b.name === "SFX")).toMatchObject({ bed: "own", bedPriority: 200 });
    expect(s.buses.find((b) => b.name === "Music")!.bed).toBe("none");
    // back to the defaults removes the keys; the root's defaults are own and 255
    d = setBusBed(setBusBed(d, "SFX", "parent"), "Music", "parent");
    d = setBusBedPriority(d, "SFX", 128);
    expect(bus(d, "SFX")).not.toHaveProperty("bed");
    expect(bus(d, "SFX")).not.toHaveProperty("bedPriority");
    expect(bus(d, "Master")).not.toHaveProperty("bed");
    expect(setBusBed(d, "Master", "own")).toBe(d);
    expect(setBusBedPriority(d, "Master", 255)).toBe(d);
    expect(setBusBedPriority(d, "Master", 999)).toBe(d); // clamps to 255, the root's default
    expect(setBusBed(d, "Nope", "own")).toBe(d);
  });

  it("warns about a bus that asked for a bed and lost it to priority", () => {
    let d = setBed(empty(), 1); // one slot: Master (own, 255) hosts
    expect(lostBeds(audioOf(d))).toEqual([]);
    d = setBusBed(d, "Music", "own");
    d = setBusBedPriority(d, "Music", 200);
    const plan = bedPlan(audioOf(d));
    expect(plan.hosts).toEqual(["Master"]);
    expect(plan.lost).toEqual([{ bus: "Music", outrankedBy: ["Master"], sharesWith: "Master" }]);
    expect(plan.hostOf).toMatchObject({ Master: "Master", Music: "Master", SFX: "Master" });
    // a second slot and a higher priority: Music wins and Master... keeps its own slot
    expect(lostBeds(audioOf(setBed(d, 2)))).toEqual([]);
    expect(bedPlan(audioOf(setBusBedPriority(d, "Music", 255))).hosts).toEqual(["Master"]); // tie at 255: the shallower bus
    // two buses at the same depth fight for one slot; the lower priority loses
    d = setBusBedPriority(setBusBed(setBusBed(d, "Master", "none"), "SFX", "own"), "SFX", 150);
    const p2 = bedPlan(audioOf(d));
    expect(p2.hosts).toEqual(["Music"]);
    expect(p2.lost.map((l) => l.bus)).toEqual(["SFX"]);
    expect(p2.lost[0].sharesWith).toBeNull(); // Master is `none`: nothing to share, so SFX is flat
    // beds off: nothing is lost
    expect(lostBeds(audioOf(setBed(d, 0)))).toEqual([]);
  });

  it("edits occlusion keys and layers; they re-parse against the physics layers", () => {
    let d = setOcclusion({ ...empty(), physics: { layers: ["Default", "Walls", "Props"] } }, { budgetMs: 5, smoothingMs: 1, defaultMaterial: "wood" });
    expect(audioOf(d).occlusion).toMatchObject({ budgetMs: 2, smoothingMs: 10, defaultMaterial: "wood", layers: null });
    expect(setOcclusion(d, { defaultMaterial: "nope", budgetMs: Number.NaN })).toBe(d);
    const all = physicsLayerNames(d);
    expect(all.length).toBeGreaterThan(1);
    d = toggleOcclusionLayer(d, all[1], false, all);
    expect(audioOf(d).occlusion.layers).toEqual(all.filter((l) => l !== all[1]));
    expect(clean(d).occlusion.layers).toEqual(all.filter((l) => l !== all[1]));
    d = toggleOcclusionLayer(d, all[1], true, all);
    expect(audioOf(d).occlusion.layers).toBeNull(); // every layer ticked: back to "all"
    expect(clean(setOcclusion(d, { layers: [] })).occlusion.layers).toEqual([]); // occlusion off
    expect(clean(setOcclusion(d, { layers: ["Default", "Default", " "] })).occlusion.layers).toEqual(["Default"]);
  });

  it("adds, edits, renames, removes and resets material cards, and the table persists", () => {
    let d = addMaterial(empty());
    expect(audioOf(d).occlusion.materials.map((m) => m.name)).toEqual(["none", "cloth", "glass", "wood", "metal", "concrete", "Material"]);
    expect(audioOf(addMaterial(d)).occlusion.materials.at(-1)!.name).toBe("Material 2");
    d = setMaterial(d, "Material", { transmissionDb: -200, cutoffHz: 50, wetOcclusion: 0.25, attackMs: 40 });
    expect(audioOf(d).occlusion.materials.at(-1)).toEqual({ name: "Material", transmissionDb: -80, cutoffHz: 100, wetOcclusion: 0.25, attackMs: 40 });
    d = setMaterial(d, "Material", { attackMs: null, releaseMs: 5000 });
    expect(audioOf(d).occlusion.materials.at(-1)).toEqual({ name: "Material", transmissionDb: -80, cutoffHz: 100, wetOcclusion: 0.25, releaseMs: 2000 });
    d = renameMaterial(setOcclusion(d, { defaultMaterial: "Material" }), "Material", "  Curtain ");
    expect(audioOf(d).occlusion.defaultMaterial).toBe("Curtain");
    expect(renameMaterial(d, "wood", "Plank")).toBe(d); // built-ins keep their names
    expect(renameMaterial(d, "Curtain", "wood")).toBe(d);
    // a built-in is edited, flagged modified, persists, and resets
    d = setMaterial(d, "wood", { cutoffHz: 3000 });
    expect(materialIsModified(audioOf(d), "wood")).toBe(true);
    expect(materialIsModified(audioOf(d), "glass")).toBe(false);
    const s = clean(d);
    expect(s.occlusion.materials.find((m) => m.name === "wood")!.cutoffHz).toBe(3000);
    expect(s.occlusion.materials.find((m) => m.name === "Curtain")).toMatchObject({ transmissionDb: -80, releaseMs: 2000 });
    expect(s.occlusion.defaultMaterial).toBe("Curtain");
    // only differing rows are written
    expect((JSON.parse(withSettings("{}", d, {})).audio.occlusion.materials as { name: string }[]).map((m) => m.name)).toEqual(["wood", "Curtain"]);
    d = resetMaterial(d, "wood");
    expect(materialIsModified(audioOf(d), "wood")).toBe(false);
    expect(resetMaterial(d, "wood")).toBe(d);
    expect(resetMaterial(d, "Curtain")).toBe(d);
    // removing the default material falls back to concrete; built-ins can't be removed
    expect(removeMaterial(d, "glass")).toBe(d);
    d = removeMaterial(d, "Curtain");
    expect(audioOf(d).occlusion.materials.map((m) => m.name)).toEqual(["none", "cloth", "glass", "wood", "metal", "concrete"]);
    expect(audioOf(d).occlusion.defaultMaterial).toBe("concrete");
    expect(clean(d).occlusion.materials).toEqual(audioOf(d).occlusion.materials);
    expect(setMaterial(d, "ghost", { cutoffHz: 1000 })).toBe(d);
  });

  it("caps the table at 32 materials", () => {
    let d = empty();
    for (let i = 0; i < 40; i++) d = addMaterial(d);
    expect(audioOf(d).occlusion.materials).toHaveLength(32);
    expect(clean(d).occlusion.materials).toHaveLength(32);
  });

  it("edits zones (integers rounded and clamped, IR length 0.5..8) and Doppler, and they persist", () => {
    let d = setZones(empty(), { maxActive: 1.4, standby: 0, maxIrSeconds: 20 });
    expect(clean(d).zones).toEqual({ maxActive: 1, standby: 0, maxIrSeconds: 8 });
    expect(zoneWarnings(audioOf(d)).map((w) => w.code)).toEqual(["evictionFade"]);
    d = setZones(d, { maxActive: 0, maxIrSeconds: 0.1 });
    expect(clean(d).zones).toEqual({ maxActive: 0, standby: 0, maxIrSeconds: 0.5 });
    expect(zoneMemory(audioOf(d)).slots).toBe(0);
    expect(setZones(d, { maxActive: Number.NaN })).toBe(d);
    d = setDoppler(d, { maxSpeed: 200, speedOfSound: 5 });
    expect(clean(d)).toMatchObject({ doppler: { maxSpeed: 200 }, speedOfSound: 10 });
    expect(setDoppler(d, { maxSpeed: 0 })).toBe(d);
    expect(setDoppler(d, { maxSpeed: -3, speedOfSound: Number.NaN })).toBe(d);
  });
});

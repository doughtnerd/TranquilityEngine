import { describe, expect, it } from "vitest";
import { audioSection } from "../../../engine/audio/audioSection";
import { parseAudioSettings, type AudioSettings } from "../../../engine/audio/settings";
import type { SettingsDraft } from "../../../editor/sdk";
import { withSettings } from "../../../editor/projectSettingsModel";
import { readDraft } from "../../../editor/testing";
import { addBus, addEffect, addSnapshot, applyVoicesPreset, VOICE_PRESETS, busTree, removeBus, renameBus, setBusMaxVoices, setBusParent, setBusValue, addBusAutomation, removeBusAutomation, setBusAutomationBus, setBusAutomationCurve, setBusAutomationParameter, setBusAutomationTarget, setSnapshotVolume, voicesPreset, addMaterial, bedPlan, materialIsModified, physicsLayerNames, removeMaterial, renameMaterial, resetMaterial, setBusBed, setBusBedPriority, setMaterial, toggleOcclusionLayer, zoneMemory, zoneWarnings, type BedPlan, addDucking, globalParameterList } from "./audioSettingsModel";
import { audioSettings } from "./audioDraft";
import { refusalOf, type EditResult } from "./editResult";

/** The lost-bed warning's rows. */
const lostBedsOf = (a: AudioSettings): BedPlan["lost"] => bedPlan(a).lost;
/** The accepted draft of an edit (ADR 0307), or the test fails with its refusal. */
const nextOf = <T,>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};
/** Add a ducking rule as the section's button does. */
const addDuckingRule = (d: SettingsDraft): SettingsDraft => nextOf(addDucking(d));
/** Add a global parameter as the section's button does. */
const addParameter = (d: SettingsDraft): SettingsDraft => nextOf(globalParameterList.add(d));

const empty = () => readDraft({});
/** Set a scalar key by path, as the Audio settings views do (ADR 0306: the handle stores what the parse makes of it). */
const set = audioSettings.set;
const bus = (d: ReturnType<typeof empty>, name: string) => audioSettings.read(d).buses.find((b) => b.name === name)!;

describe("audio settings model (ADR 0097)", () => {
  it("adds buses with unique names under a parent and shows them as a tree", () => {
    let d = nextOf(addBus(empty()));
    d = nextOf(addBus(d, "Bus"));
    expect(busTree(audioSettings.read(d)).map((n) => `${"-".repeat(n.depth)}${n.bus.name}`)).toEqual(["Master", "-Music", "-SFX", "-UI", "-Voice", "-Bus", "--Bus 2"]);
  });
  it("renames everywhere, removes with descendants and scrubs references", () => {
    let d = nextOf(addBus(empty(), "Music"));
    d = nextOf(addSnapshot(d));
    d = nextOf(setSnapshotVolume(d, 0, "Bus", 0.5));
    d = addDuckingRule(d);
    d = nextOf(renameBus(d, "Music", "Score"));
    expect(audioSettings.read(d).buses.find((b) => b.name === "Bus")!.parent).toBe("Score");
    expect(audioSettings.read(d).ducking[0].target).toBe("Score");
    d = nextOf(removeBus(d, "Score"));
    const a = audioSettings.read(d);
    expect(a.buses.map((b) => b.name)).toEqual(["Master", "SFX", "UI", "Voice"]);
    expect(a.snapshots[0].volumes).toEqual({});
    expect(a.ducking).toEqual([]);
  });
  it("won't remove the root, create loops or duplicate names", () => {
    const d = empty();
    expect(refusalOf(removeBus(d, "Master"))).toBe("Master is the root bus and can't be removed.");
    expect(refusalOf(setBusParent(d, "Master", "Music"))).not.toBeNull();
    const nested = nextOf(addBus(d, "Music"));
    expect(refusalOf(setBusParent(nested, "Music", "Bus"))).not.toBeNull();
    expect(renameBus(d, "Music", "SFX")).toEqual({ refused: 'Another bus is already named "SFX".' });
    expect(renameBus(d, "Music", " Music ")).toEqual({ next: d });
  });
  it("edits values and effects, and writes the section into project.json text", () => {
    let d = nextOf(setBusValue(empty(), "Music", "volume", 0.6));
    d = nextOf(addEffect(d, "Music", "lowpass"));
    const text = withSettings("{}", d, {});
    const audio = JSON.parse(text).audio;
    expect(audio.buses.find((b: { name: string }) => b.name === "Music")).toMatchObject({ volume: 0.6, effects: [{ type: "lowpass", frequency: 20000 }] });
  });
});

describe("audio settings model, the core keys (ADR 0157 §2, K13)", () => {
  it("sets a bus's maxVoices rounded and clamped to 1..voices.logical, and unlimited with undefined", () => {
    let d = nextOf(setBusMaxVoices(empty(), "SFX", 15.6));
    expect(bus(d, "SFX").maxVoices).toBe(16);
    d = nextOf(setBusMaxVoices(d, "SFX", 0));
    expect(bus(d, "SFX").maxVoices).toBe(1);
    d = nextOf(setBusMaxVoices(d, "SFX", 99999));
    expect(bus(d, "SFX").maxVoices).toBe(4096);
    d = nextOf(setBusMaxVoices(d, "SFX", undefined));
    expect("maxVoices" in bus(d, "SFX")).toBe(false);
    const same = empty();
    expect(refusalOf(setBusMaxVoices(same, "Nope", 4))).toBe('No bus named "Nope".');
  });
  it("keeps maxVoices when a bus is renamed", () => {
    const d = nextOf(renameBus(nextOf(setBusMaxVoices(empty(), "SFX", 8)), "SFX", "Effects"));
    expect(bus(d, "Effects").maxVoices).toBe(8);
  });
  it("sets voices within range, keeps logical >= mixed and clamps bus limits to a lowered logical", () => {
    let d = nextOf(setBusMaxVoices(empty(), "SFX", 2000));
    d = set(set(d, "voices.mixed", 1000), "voices.hrtf", 99);
    expect(audioSettings.read(d).voices).toEqual({ mixed: 512, logical: 4096, hrtf: 32 });
    d = set(d, "voices.logical", 600);
    expect(audioSettings.read(d).voices.logical).toBe(600);
    expect(bus(d, "SFX").maxVoices).toBe(600);
    d = set(d, "voices.logical", 300); // under mixed: raised to it
    expect(audioSettings.read(d).voices).toMatchObject({ mixed: 512, logical: 512 });
    d = set(set(d, "voices.mixed", 8), "voices.logical", 3);
    expect(audioSettings.read(d).voices).toMatchObject({ mixed: 8, logical: 8 });
    expect(bus(d, "SFX").maxVoices).toBe(8);
    expect(audioSection(d.audio).problems).toEqual([]);
    expect(audioSettings.read(set(d, "voices.mixed", NaN)).voices.mixed).toBe(128); // rejected: the parse's default
  });
  it("applies voice presets, names the matching one and falls back to custom", () => {
    expect(voicesPreset(audioSettings.read(empty()))).toBe("default");
    const low = applyVoicesPreset(empty(), "low");
    expect(voicesPreset(audioSettings.read(low))).toBe("low");
    expect(audioSettings.read(low).clipMemoryMB).toBe(64);
    const back = applyVoicesPreset(low, "default");
    expect(audioSettings.read(back).clipMemoryMB).toBeUndefined();
    expect(voicesPreset(audioSettings.read(back))).toBe("default");
    expect(voicesPreset(audioSettings.read(set(low, "voices.hrtf", 5)))).toBe("custom");
    expect(applyVoicesPreset(low, "low")).toBe(low);
  });
  it("the presets carry ADR 0162's numbers: HRTF 4/8/8, maxBeds 0/2/4, maxClips 1/1/2, and the comparison reads them", () => {
    expect(VOICE_PRESETS.low).toMatchObject({ voices: { hrtf: 4 }, maxBeds: 0, maxClips: 1 });
    expect(VOICE_PRESETS.default).toMatchObject({ voices: { hrtf: 8 }, maxBeds: 2, maxClips: 1 });
    expect(VOICE_PRESETS.high).toMatchObject({ voices: { hrtf: 8 }, maxBeds: 4, maxClips: 2 });
    const high = audioSettings.read(applyVoicesPreset(empty(), "high"));
    expect(high.bed.maxBeds).toBe(4);
    expect(high.ambisonic.maxClips).toBe(2);
    expect(voicesPreset(high)).toBe("high");
    expect(voicesPreset({ ...high, bed: { maxBeds: 3 } })).toBe("custom");
    expect(voicesPreset({ ...high, ambisonic: { maxClips: 1 } })).toBe("custom");
    const low = audioSettings.read(applyVoicesPreset(empty(), "low"));
    expect(low.bed.maxBeds).toBe(0);
    expect(voicesPreset(audioSettings.read(applyVoicesPreset(applyVoicesPreset(empty(), "high"), "default")))).toBe("default");
  });
  it("music rings: presets write 8/12/16, the comparison includes them, edits clamp, persist and re-parse", () => {
    expect(VOICE_PRESETS.low.musicRings).toBe(8);
    expect(VOICE_PRESETS.high.musicRings).toBe(16);
    expect(audioSettings.read(applyVoicesPreset(empty(), "low")).music.rings).toBe(8);
    expect(audioSettings.read(applyVoicesPreset(applyVoicesPreset(empty(), "high"), "default")).music.rings).toBe(12);
    const high = applyVoicesPreset(empty(), "high");
    const odd = set(high, "music.rings", 10);
    expect(audioSettings.read(odd).music.rings).toBe(10);
    expect(voicesPreset(audioSettings.read(odd))).toBe("custom");
    expect(voicesPreset(audioSettings.read(applyVoicesPreset(odd, "high")))).toBe("high");
    expect((odd.audio as { music: { rings: number } }).music.rings).toBe(10);
    expect(audioSettings.read(set(empty(), "music.rings", 99)).music.rings).toBe(16);
    expect(audioSettings.read(set(empty(), "music.rings", -3)).music.rings).toBe(0);
    expect(audioSettings.read(set(empty(), "music.rings", 6.6)).music.rings).toBe(7);
    expect((set(empty(), "music.rings", 99).audio as { music: { rings: number } }).music.rings).toBe(16); // stored clamped
    const same = empty();
    expect(set(same, "music.rings", NaN)).toBe(same); // rejected: the default 12, which it already is
    expect(set(same, "music.rings", 12)).toBe(same);
    expect(audioSettings.read(set(odd, "music.rings", NaN)).music.rings).toBe(12);
    expect(audioSection(odd.audio).problems).toEqual([]);
  });
  it("rhythm mode persists and re-parses", () => {
    const on = set(empty(), "rhythmMode", true);
    expect(audioSettings.read(on).rhythmMode).toBe(true);
    expect((on.audio as { rhythmMode: boolean }).rhythmMode).toBe(true);
    expect(audioSection(on.audio).problems).toEqual([]);
    expect(audioSettings.read(set(on, "rhythmMode", false)).rhythmMode).toBe(false);
    expect(set(on, "rhythmMode", true)).toBe(on);
  });
  it("sets background, clip memory, clip format, codec, spatial and backend; the result re-parses without problems", () => {
    let d = set(empty(), "background", "pause");
    d = set(d, "clipMemoryMB", 5000);
    expect(audioSettings.read(d).clipMemoryMB).toBe(1024);
    d = set(d, "clipMemoryMB", 3);
    expect(audioSettings.read(d).clipMemoryMB).toBe(16);
    d = set(d, "clipFormat", "f32");
    d = set(d, "codecs.aac", true);
    d = set(d, "spatial", "equalPower");
    d = set(d, "backend", "babylon");
    expect(audioSettings.read(d).backend).toBe("babylon");
    expect(set(d, "backend", "babylon")).toBe(d);
    d = set(d, "backend", "core");
    d = nextOf(setBusMaxVoices(d, "Music", 8));
    const text = withSettings("{}", d, {});
    const parsed = parseAudioSettings(JSON.parse(text).audio);
    expect(parsed.problems).toEqual([]);
    expect(parsed.settings).toMatchObject({ background: "pause", clipMemoryMB: 16, clipFormat: "f32", codecs: { aac: true }, spatial: "equalPower", backend: "core" });
    expect(audioSettings.read(set(d, "clipMemoryMB", undefined)).clipMemoryMB).toBeUndefined();
    expect(audioSettings.read(set(d, "spatial", "stereo")).spatial).toBe("hrtf"); // rejected: the parse's default
    const same = empty();
    expect(set(same, "spatial", "hrtf")).toBe(same);
    expect(set(same, "codecs.aac", false)).toBe(same);
    expect(set(same, "background", "mute")).toBe(same);
    expect(set(same, "clipFormat", "i16")).toBe(same);
  });
  it("sets the limiter look-ahead in ms, clamped to 0..5 and not rounded; non-finite is the 1.5 default; it re-parses", () => {
    const same = empty();
    expect(audioSettings.read(same).limiterLookaheadMs).toBe(1.5);
    expect(set(same, "limiterLookaheadMs", 1.5)).toBe(same);
    let d = set(same, "limiterLookaheadMs", 2.25);
    expect(audioSettings.read(d).limiterLookaheadMs).toBe(2.25);
    d = set(d, "limiterLookaheadMs", 9);
    expect(audioSettings.read(d).limiterLookaheadMs).toBe(5);
    d = set(d, "limiterLookaheadMs", -3);
    expect(audioSettings.read(d).limiterLookaheadMs).toBe(0);
    const parsed = parseAudioSettings(JSON.parse(withSettings("{}", d, {})).audio);
    expect(parsed.problems).toEqual([]);
    expect(parsed.settings.limiterLookaheadMs).toBe(0);
    expect(audioSettings.read(set(d, "limiterLookaheadMs", Number.NaN)).limiterLookaheadMs).toBe(1.5);
  });
});

// Written by the coordinator (not a stub): the existing bus edits keep automation consistent.
describe("bus edits and automation (ADR 0158 §3)", () => {
  it("renames and removes buses in the automation too", () => {
    let d = readDraft({ audio: { parameters: [{ name: "P", min: 0, max: 1 }], automation: [{ bus: "Music", parameter: "P", target: "volume", curve: [[0, 1], [1, 0]] }] } });
    d = nextOf(renameBus(d, "Music", "Score"));
    expect(audioSettings.read(d).automation[0].bus).toBe("Score");
    d = nextOf(removeBus(d, "Score"));
    expect(audioSettings.read(d).automation).toEqual([]);
  });
});

describe("global parameters and bus automation (ADR 0158 §2, §3; L6.5a)", () => {
  it("adds bus automation on the first parameter with a flat curve over its range; nothing without parameters or for an unknown bus", () => {
    let d = readDraft({ audio: {
      parameters: [{ name: "I", min: 0.5, max: 2, default: 1, seekSpeed: 0 }, { name: "Area", labels: ["a", "b", "c"], default: "a" }],
    } });
    d = nextOf(addBusAutomation(d));
    expect(audioSettings.read(d).automation).toEqual([{ bus: "Music", parameter: "I", target: "volume", curve: [[0.5, 1], [2, 1]] }]);
    d = nextOf(addBusAutomation(d, "SFX"));
    expect(audioSettings.read(d).automation[1].bus).toBe("SFX");
    expect(refusalOf(addBusAutomation(d, "Nope"))).toBe('No bus named "Nope".');
    const bare = empty();
    expect(refusalOf(addBusAutomation(bare))).toMatch(/add one first/);
    let noMusic = addParameter(nextOf(removeBus(empty(), "Music")));
    noMusic = nextOf(addBusAutomation(noMusic));
    expect(audioSettings.read(noMusic).automation[0]).toEqual({ bus: "SFX", parameter: "Parameter", target: "volume", curve: [[0, 1], [1, 1]] });
    let z = readDraft({ audio: { parameters: [{ name: "Fixed", min: 3, max: 3, default: 3, seekSpeed: 0 }] } });
    z = nextOf(addBusAutomation(z));
    expect(audioSettings.read(z).automation[0].curve).toEqual([[3, 1], [4, 1]]);
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
    expect(refusalOf(removeBusAutomation(d, 2))).toBe("No automation 3.");
    expect(refusalOf(removeBusAutomation(d, -1))).toBe("No automation 0.");
    expect(refusalOf(setBusAutomationBus(d, 5, "UI"))).toBe("No automation 6.");
    expect(refusalOf(setBusAutomationBus(d, 0, "Nope"))).toBe('No bus named "Nope".');
    d = nextOf(setBusAutomationBus(d, 0, "UI"));
    expect(audioSettings.read(d).automation[0].bus).toBe("UI");
    d = nextOf(setBusAutomationTarget(d, 0, "lowpass"));
    expect(audioSettings.read(d).automation[0]).toMatchObject({ target: "lowpass" });
    d = nextOf(removeBusAutomation(d, 0));
    expect(audioSettings.read(d).automation.map((r) => r.bus)).toEqual(["SFX"]);
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
    d = nextOf(setBusAutomationParameter(d, 0, "Area"));
    expect(audioSettings.read(d).automation[0]).toEqual({ bus: "Music", parameter: "Area", target: "volume", curve: [[0, 0.4], [1, 1, "smooth"], [2, 1]] });
    expect(setBusAutomationParameter(d, 0, "Area")).toEqual({ next: d });
    expect(refusalOf(setBusAutomationParameter(d, 0, "Nope"))).toBe('No global parameter named "Nope".');
    expect(refusalOf(setBusAutomationParameter(d, 4, "I"))).toBe("No automation 5.");
    d = nextOf(setBusAutomationParameter(d, 0, "Fixed"));
    expect(audioSettings.read(d).automation[0].curve).toEqual([[3, 0.4], [3, 1, "smooth"], [3, 1]]);
    d = nextOf(setBusAutomationParameter(d, 0, "Area"));
    expect(audioSettings.read(d).automation[0].curve).toEqual([[0, 0.4], [0, 1, "smooth"], [0, 1]]);
    expect(parseAudioSettings(JSON.parse(withSettings("{}", d, {})).audio).problems).toEqual([]);
  });
  it("switching an entry's target resets the curve flat at 1 (volume) or 24000 (lowpass)", () => {
    let d = readDraft({ audio: {
      parameters: [{ name: "Area", labels: ["Outdoor", "Cave", "Hall"], default: "Outdoor" }],
      automation: [{ bus: "Music", parameter: "Area", target: "volume", curve: [[0, 0.4], [2, 1]] }],
    } });
    d = nextOf(setBusAutomationTarget(d, 0, "lowpass"));
    expect(audioSettings.read(d).automation[0]).toEqual({ bus: "Music", parameter: "Area", target: "lowpass", curve: [[0, 24000], [2, 24000]] });
    d = nextOf(setBusAutomationTarget(d, 0, "volume"));
    expect(audioSettings.read(d).automation[0]).toEqual({ bus: "Music", parameter: "Area", target: "volume", curve: [[0, 1], [2, 1]] });
    expect(setBusAutomationTarget(d, 0, "volume")).toEqual({ next: d });
    expect(refusalOf(setBusAutomationTarget(d, 3, "lowpass"))).toBe("No automation 4.");
    expect(parseAudioSettings(JSON.parse(withSettings("{}", d, {})).audio).problems).toEqual([]);
  });
  it("sets a curve (empty refused, over MAX_CURVE_KEYS cut) and the result survives the lenient parse with no problems", () => {
    let d = readDraft({ audio: {
      parameters: [{ name: "I", min: 0, max: 1, default: 0, seekSpeed: 0 }],
      automation: [{ bus: "Music", parameter: "I", target: "volume", curve: [[0, 1], [1, 0]] }],
    } });
    expect(refusalOf(setBusAutomationCurve(d, 0, []))).toBe("A curve needs at least one key.");
    expect(refusalOf(setBusAutomationCurve(d, 4, [[0, 1]]))).toBe("No automation 5.");
    d = nextOf(setBusAutomationCurve(d, 0, [[0, 0.2], [0.5, 1, "smooth"], [1, 0]]));
    expect(audioSettings.read(d).automation[0].curve).toEqual([[0, 0.2], [0.5, 1, "smooth"], [1, 0]]);
    const many = Array.from({ length: 40 }, (_, i) => [i / 39, i % 2] as const);
    d = nextOf(setBusAutomationCurve(d, 0, many));
    expect(audioSettings.read(d).automation[0].curve).toHaveLength(32);
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
    let d = set(empty(), "bed.maxBeds", 3.6);
    d = set(d, "ambisonic.maxClips", 9);
    expect(clean(d)).toMatchObject({ bed: { maxBeds: 4 }, ambisonic: { maxClips: 4 } });
    expect(clean(set(d, "bed.maxBeds", -2)).bed.maxBeds).toBe(0);
    expect(clean(set(d, "bed.maxBeds", Number.NaN)).bed.maxBeds).toBe(2); // rejected: the parse's default
    expect(set(d, "bed.maxBeds", 4)).toBe(d);
  });

  it("stores a bus's bed and priority only when they differ from the default, and round-trips them", () => {
    let d = nextOf(setBusBed(empty(), "SFX", "own"));
    d = nextOf(setBusBedPriority(d, "SFX", 200.4));
    d = nextOf(setBusBed(d, "Music", "none"));
    expect(bus(d, "SFX")).toMatchObject({ bed: "own", bedPriority: 200 });
    const s = clean(d);
    expect(s.buses.find((b) => b.name === "SFX")).toMatchObject({ bed: "own", bedPriority: 200 });
    expect(s.buses.find((b) => b.name === "Music")!.bed).toBe("none");
    // back to the defaults removes the keys; the root's defaults are own and 255
    d = nextOf(setBusBed(nextOf(setBusBed(d, "SFX", "parent")), "Music", "parent"));
    d = nextOf(setBusBedPriority(d, "SFX", 128));
    expect(bus(d, "SFX")).not.toHaveProperty("bed");
    expect(bus(d, "SFX")).not.toHaveProperty("bedPriority");
    expect(bus(d, "Master")).not.toHaveProperty("bed");
    expect(setBusBed(d, "Master", "own")).toEqual({ next: d });
    expect(setBusBedPriority(d, "Master", 255)).toEqual({ next: d });
    expect(setBusBedPriority(d, "Master", 999)).toEqual({ next: d }); // clamps to 255, the root's default
    expect(refusalOf(setBusBed(d, "Nope", "own"))).toBe('No bus named "Nope".');
  });

  it("warns about a bus that asked for a bed and lost it to priority", () => {
    let d = set(empty(), "bed.maxBeds", 1); // one slot: Master (own, 255) hosts
    expect(lostBedsOf(audioSettings.read(d))).toEqual([]);
    d = nextOf(setBusBed(d, "Music", "own"));
    d = nextOf(setBusBedPriority(d, "Music", 200));
    const plan = bedPlan(audioSettings.read(d));
    expect(plan.hosts).toEqual(["Master"]);
    expect(plan.lost).toEqual([{ bus: "Music", outrankedBy: ["Master"], sharesWith: "Master" }]);
    expect(plan.hostOf).toMatchObject({ Master: "Master", Music: "Master", SFX: "Master" });
    // a second slot and a higher priority: Music wins and Master... keeps its own slot
    expect(lostBedsOf(audioSettings.read(set(d, "bed.maxBeds", 2)))).toEqual([]);
    expect(bedPlan(audioSettings.read(nextOf(setBusBedPriority(d, "Music", 255)))).hosts).toEqual(["Master"]); // tie at 255: the shallower bus
    // two buses at the same depth fight for one slot; the lower priority loses
    d = nextOf(setBusBedPriority(nextOf(setBusBed(nextOf(setBusBed(d, "Master", "none")), "SFX", "own")), "SFX", 150));
    const p2 = bedPlan(audioSettings.read(d));
    expect(p2.hosts).toEqual(["Music"]);
    expect(p2.lost.map((l) => l.bus)).toEqual(["SFX"]);
    expect(p2.lost[0].sharesWith).toBeNull(); // Master is `none`: nothing to share, so SFX is flat
    // beds off: nothing is lost
    expect(lostBedsOf(audioSettings.read(set(d, "bed.maxBeds", 0)))).toEqual([]);
  });

  it("edits occlusion keys and layers; they re-parse against the physics layers", () => {
    let d = set(set(set({ ...empty(), physics: { layers: ["Default", "Walls", "Props"] } }, "occlusion.budgetMs", 5), "occlusion.smoothingMs", 1), "occlusion.defaultMaterial", "wood");
    expect(audioSettings.read(d).occlusion).toMatchObject({ budgetMs: 2, smoothingMs: 10, defaultMaterial: "wood", layers: null });
    expect(audioSettings.read(set(d, "occlusion.defaultMaterial", "nope")).occlusion.defaultMaterial).toBe("concrete"); // rejected: the parse's fallback
    expect(audioSettings.read(set(d, "occlusion.budgetMs", Number.NaN)).occlusion.budgetMs).toBe(0.25);
    const all = physicsLayerNames(d);
    expect(all.length).toBeGreaterThan(1);
    d = toggleOcclusionLayer(d, all[1], false, all);
    expect(audioSettings.read(d).occlusion.layers).toEqual(all.filter((l) => l !== all[1]));
    expect(clean(d).occlusion.layers).toEqual(all.filter((l) => l !== all[1]));
    d = toggleOcclusionLayer(d, all[1], true, all);
    expect(audioSettings.read(d).occlusion.layers).toBeNull(); // every layer ticked: back to "all"
    expect(clean(set(d, "occlusion.layers", [])).occlusion.layers).toEqual([]); // occlusion off
    expect(clean(set(d, "occlusion.layers", ["Default", "Default", ""])).occlusion.layers).toEqual(["Default"]); // the parse drops repeats and blanks
  });

  it("adds, edits, renames, removes and resets material cards, and the table persists", () => {
    let d = nextOf(addMaterial(empty()));
    expect(audioSettings.read(d).occlusion.materials.map((m) => m.name)).toEqual(["none", "cloth", "glass", "wood", "metal", "concrete", "Material"]);
    expect(audioSettings.read(nextOf(addMaterial(d))).occlusion.materials.at(-1)!.name).toBe("Material 2");
    d = nextOf(setMaterial(d, "Material", { transmissionDb: -200, cutoffHz: 50, wetOcclusion: 0.25, attackMs: 40 }));
    expect(audioSettings.read(d).occlusion.materials.at(-1)).toEqual({ name: "Material", transmissionDb: -80, cutoffHz: 100, wetOcclusion: 0.25, attackMs: 40 });
    d = nextOf(setMaterial(d, "Material", { attackMs: null, releaseMs: 5000 }));
    expect(audioSettings.read(d).occlusion.materials.at(-1)).toEqual({ name: "Material", transmissionDb: -80, cutoffHz: 100, wetOcclusion: 0.25, releaseMs: 2000 });
    d = nextOf(renameMaterial(set(d, "occlusion.defaultMaterial", "Material"), "Material", "  Curtain "));
    expect(audioSettings.read(d).occlusion.defaultMaterial).toBe("Curtain");
    expect(refusalOf(renameMaterial(d, "wood", "Plank"))).toBe('"wood" is built in and keeps its name.');
    expect(refusalOf(renameMaterial(d, "Curtain", "wood"))).toBe('Another material is already named "wood".');
    expect(refusalOf(renameMaterial(d, "Curtain", "  "))).toBe("A material needs a name.");
    expect(renameMaterial(d, "Curtain", " Curtain ")).toEqual({ next: d });
    // a built-in is edited, flagged modified, persists, and resets
    d = nextOf(setMaterial(d, "wood", { cutoffHz: 3000 }));
    expect(materialIsModified(audioSettings.read(d), "wood")).toBe(true);
    expect(materialIsModified(audioSettings.read(d), "glass")).toBe(false);
    const s = clean(d);
    expect(s.occlusion.materials.find((m) => m.name === "wood")!.cutoffHz).toBe(3000);
    expect(s.occlusion.materials.find((m) => m.name === "Curtain")).toMatchObject({ transmissionDb: -80, releaseMs: 2000 });
    expect(s.occlusion.defaultMaterial).toBe("Curtain");
    // only differing rows are written
    expect((JSON.parse(withSettings("{}", d, {})).audio.occlusion.materials as { name: string }[]).map((m) => m.name)).toEqual(["wood", "Curtain"]);
    d = nextOf(resetMaterial(d, "wood"));
    expect(materialIsModified(audioSettings.read(d), "wood")).toBe(false);
    expect(resetMaterial(d, "wood")).toEqual({ next: d });
    expect(refusalOf(resetMaterial(d, "Curtain"))).toBe('"Curtain" is not a built-in material.');
    // removing the default material falls back to concrete; built-ins can't be removed
    expect(refusalOf(removeMaterial(d, "glass"))).toBe('"glass" is built in: reset it instead.');
    d = nextOf(removeMaterial(d, "Curtain"));
    expect(audioSettings.read(d).occlusion.materials.map((m) => m.name)).toEqual(["none", "cloth", "glass", "wood", "metal", "concrete"]);
    expect(audioSettings.read(d).occlusion.defaultMaterial).toBe("concrete");
    expect(clean(d).occlusion.materials).toEqual(audioSettings.read(d).occlusion.materials);
    expect(refusalOf(setMaterial(d, "ghost", { cutoffHz: 1000 }))).toBe('No material named "ghost".');
  });

  it("caps the table at 32 materials", () => {
    let d = empty();
    while (audioSettings.read(d).occlusion.materials.length < 32) d = nextOf(addMaterial(d));
    expect(refusalOf(addMaterial(d))).toBe("A project holds at most 32 materials.");
    expect(audioSettings.read(d).occlusion.materials).toHaveLength(32);
    expect(clean(d).occlusion.materials).toHaveLength(32);
  });

  it("edits zones (integers rounded and clamped, IR length 0.5..8) and Doppler, and they persist", () => {
    let d = set(set(set(empty(), "zones.maxActive", 1.4), "zones.standby", 0), "zones.maxIrSeconds", 20);
    expect(clean(d).zones).toEqual({ maxActive: 1, standby: 0, maxIrSeconds: 8 });
    expect(zoneWarnings(audioSettings.read(d)).map((w) => w.code)).toEqual(["evictionFade"]);
    d = set(set(d, "zones.maxActive", 0), "zones.maxIrSeconds", 0.1);
    expect(clean(d).zones).toEqual({ maxActive: 0, standby: 0, maxIrSeconds: 0.5 });
    expect(zoneMemory(audioSettings.read(d)).slots).toBe(0);
    expect(set(d, "zones.maxActive", 0)).toBe(d);
    expect(clean(set(d, "zones.maxActive", Number.NaN)).zones.maxActive).toBe(2); // rejected: the parse's default
    d = set(set(d, "doppler.maxSpeed", 200), "speedOfSound", 5);
    expect(clean(d)).toMatchObject({ doppler: { maxSpeed: 200 }, speedOfSound: 10 });
    expect(set(d, "doppler.maxSpeed", 200)).toBe(d);
    expect(clean(set(d, "doppler.maxSpeed", 0)).doppler.maxSpeed).toBe(150); // must be above 0: the parse's default
    expect(clean(set(d, "speedOfSound", Number.NaN)).speedOfSound).toBe(343);
  });
});

import { describe, expect, it } from "vitest";
import { parseAudioSettings } from "../settings";
import { audioProjectToJson, defaultAudioProject, parseAudioProject, toRuntimeSettings } from "./format";
import { MAX_DB } from "./gain";
import { AUDIO_PROJECT_FORMAT } from "./types";

/** A project file exercising every part of the format. */
const FULL = {
  format: AUDIO_PROJECT_FORMAT,
  settings: { voices: { mixed: 64, logical: 1024, hrtf: 4 }, speedOfSound: 340, submixes: 16, bedBeyond: 40, dopplerAmount: 0.5 },
  parameters: [{ name: "threat", min: 0, max: 1, default: 0, seekSpeed: 0 }, { name: "depth", min: 0, max: 100, default: 0, seekSpeed: 0 }, { name: "Area", labels: ["Outdoor", "Cave"], default: "Outdoor" }],
  buses: [
    { name: "Master", parent: null, volumeDb: 0, mute: false, voiceLimit: null, bed: { own: true, priority: 255 }, meter: true, effects: [], sends: [] },
    { name: "Music", parent: "Master", volumeDb: -3, mute: false, voiceLimit: 8, bed: null, meter: true, effects: [{ id: "fx1", type: "lowpass", on: true, params: { cutoff: 20000, resonance: 0 } }], sends: [] },
    { name: "SFX", parent: "Master", volumeDb: -2, mute: false, voiceLimit: 48, bed: { own: true, priority: 80 }, meter: false, effects: [{ id: "fx1", type: "eq", on: true, params: { low: 3 } }], sends: [{ to: "Reverb", levelDb: -12 }] },
    { name: "Vehicles", parent: "SFX", volumeDb: 0, mute: true, voiceLimit: null, bed: null, meter: false, effects: [], sends: [] },
  ],
  returns: [{ name: "Reverb", output: "Master", volumeDb: -3, mute: false, effects: [{ id: "fx1", type: "reverb", on: true, params: {} }] }],
  vcas: [{ name: "Gameplay SFX", volumeDb: -6, members: ["SFX", "Vehicles"] }],
  automation: [
    { on: "Music", target: "volume", parameter: "threat", curve: [[0, 0], [1, -6, "easeOut"]], bypass: false },
    { on: "SFX", target: "send:Reverb", parameter: "depth", curve: [[0, -12], [100, 0]], bypass: false },
  ],
  ducking: [{ target: "Music", trigger: "SFX", mode: "presence", detector: "rms", thresholdDb: -30, amountDb: -6, attackMs: 80, releaseMs: 400, enabled: true }],
  snapshots: [{
    name: "Underwater", folder: "States", start: { kind: "conditions", match: "all", conditions: [{ parameter: "depth", op: "gt", value: 0 }, { parameter: "depth", op: "between", value: 1, value2: 9 }] },
    fadeInMs: 300, fadeOutMs: 500, holdMs: 0, priority: 20, combine: "override", buses: { Music: -6, Reverb: -3 }, effects: { Music: { fx1: { cutoff: 800 } } },
  }],
  loudness: { targets: [{ name: "pc", integrated: -16, tolerance: 1, truePeak: -1 }], resetOnPlay: false },
};

describe("parseAudioProject", () => {
  it("reads a full file without problems and writes it back unchanged", () => {
    const { project, problems } = parseAudioProject(FULL);
    expect(problems).toEqual([]);
    expect(project.settings.voices).toEqual({ mixed: 64, logical: 1024, hrtf: 4 });
    expect(project.settings).toMatchObject({ submixes: 16, bedBeyond: 40, dopplerAmount: 0.5, speedOfSound: 340 });
    expect(project.buses.map((b) => b.name)).toEqual(["Master", "Music", "SFX", "Vehicles"]);
    expect(project.snapshots[0].start).toEqual(FULL.snapshots[0].start);
    const written = audioProjectToJson(project);
    expect(parseAudioProject(written).project).toEqual(project);
    expect(written).toEqual(FULL);
  });

  it("gives the default mix for nothing, and a problem for a non-object", () => {
    expect(parseAudioProject(undefined)).toEqual({ project: defaultAudioProject(), problems: [], warnings: [] });
    const bad = parseAudioProject(3);
    expect(bad.project).toEqual(defaultAudioProject());
    expect(bad.problems).toHaveLength(1);
    expect(defaultAudioProject().buses.map((b) => b.name)).toEqual(["Master", "Music", "SFX", "UI", "Voice"]);
  });

  it("writes only engine settings that differ from the defaults", () => {
    const json = audioProjectToJson(parseAudioProject({ format: AUDIO_PROJECT_FORMAT, settings: { rhythmMode: true } }).project);
    expect(json.settings).toEqual({ rhythmMode: true });
    expect(audioProjectToJson(defaultAudioProject()).settings).toEqual({});
  });

  it("parses engine settings by the audio section's rules, limits included", () => {
    const { project, problems } = parseAudioProject({ format: AUDIO_PROJECT_FORMAT, settings: { voices: { mixed: 9999 }, music: { rings: 40 }, buses: [], submixes: -4, dopplerAmount: "x" } });
    expect(project.settings.voices.mixed).toBe(512);
    expect(project.settings.music.rings).toBe(16);
    expect(project.settings.submixes).toBe(0);
    expect(project.settings.dopplerAmount).toBe(1);
    expect(problems.some((p) => p.startsWith("settings.voices.mixed"))).toBe(true);
    expect(problems.some((p) => p.startsWith("settings.music.rings"))).toBe(true);
    expect(problems.some((p) => p.startsWith("settings.buses"))).toBe(true);
    expect(problems).toHaveLength(5);
  });

  it("puts Master first with no parent and hangs buses with a missing parent or a loop under it", () => {
    const { project, problems } = parseAudioProject({
      format: AUDIO_PROJECT_FORMAT,
      buses: [
        { name: "A", parent: "B" }, { name: "Master", parent: "A" }, { name: "B", parent: "A" }, { name: "C", parent: "Nope" }, { name: "D" },
      ],
    });
    expect(project.buses.map((b) => [b.name, b.parent])).toEqual([["Master", null], ["A", "Master"], ["B", "A"], ["C", "Master"], ["D", "Master"]]);
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });

  it("adds Master when the list has none", () => {
    const { project, problems } = parseAudioProject({ format: AUDIO_PROJECT_FORMAT, buses: [{ name: "Music", parent: "Master" }] });
    expect(project.buses.map((b) => b.name)).toEqual(["Master", "Music"]);
    expect(project.buses[0].bed).toEqual({ own: true, priority: 255 });
    expect(problems).toHaveLength(1);
  });

  it("keeps names unique across buses, returns and VCAs", () => {
    const { project, problems } = parseAudioProject({
      format: AUDIO_PROJECT_FORMAT,
      buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "Music", parent: "Master" }],
      returns: [{ name: "Music" }, { name: "Echo" }],
      vcas: [{ name: "Echo", members: [] }, { name: "All", members: ["Music", "Nope", "Music"] }],
    });
    expect(project.buses.map((b) => b.name)).toEqual(["Master", "Music"]);
    expect(project.returns.map((r) => r.name)).toEqual(["Echo"]);
    expect(project.vcas).toEqual([{ name: "All", volumeDb: 0, members: ["Music"] }]);
    expect(problems).toHaveLength(4);
  });

  it("sends only to returns, never from Master, once per return", () => {
    const { project, problems } = parseAudioProject({
      format: AUDIO_PROJECT_FORMAT,
      buses: [{ name: "Master", sends: [{ to: "Rev", levelDb: 0 }] }, { name: "SFX", parent: "Master", sends: [{ to: "Rev", levelDb: -6 }, { to: "Rev", levelDb: -3 }, { to: "Master", levelDb: 0 }] }],
      returns: [{ name: "Rev", output: "Nope" }],
    });
    expect(project.buses[0].sends).toEqual([]);
    expect(project.buses[1].sends).toEqual([{ to: "Rev", levelDb: -6 }]);
    expect(project.returns[0].output).toBe("Master");
    expect(problems).toHaveLength(4);
  });

  it("drops a ducking rule whose trigger is its target or above it", () => {
    const { project, problems } = parseAudioProject({
      format: AUDIO_PROJECT_FORMAT,
      buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }, { name: "Cars", parent: "SFX" }, { name: "Music", parent: "Master" }],
      ducking: [
        { target: "Cars", trigger: "SFX", mode: "presence" },
        { target: "Music", trigger: "Music", mode: "presence" },
        { target: "Music", trigger: "Cars", mode: "level", amountDb: 5, attackMs: -1 },
      ],
    });
    expect(project.ducking).toEqual([{ target: "Music", trigger: "Cars", mode: "level", detector: "rms", thresholdDb: -30, amountDb: 0, attackMs: 0, releaseMs: 500, enabled: true }]);
    expect(problems).toHaveLength(4);
  });

  it("clamps snapshot fields and drops references to unknown buses, effects and parameters", () => {
    const { project, problems } = parseAudioProject({
      format: AUDIO_PROJECT_FORMAT,
      parameters: [{ name: "p", min: 0, max: 1 }],
      buses: [{ name: "Master" }, { name: "Music", parent: "Master", effects: [{ id: "lp", type: "lowpass", params: { cutoff: 900 } }] }],
      snapshots: [
        { name: "S", fadeInMs: -5, fadeOutMs: 1e9, holdMs: 10, priority: 500.4, combine: "blend", buses: { Music: -100, Nope: 0 }, effects: { Music: { lp: { cutoff: 400 }, gone: { cutoff: 1 } } }, start: { kind: "conditions", conditions: [{ parameter: "q", op: "gt", value: 1 }, { parameter: "p", op: "between", value: 0 }] } },
        { name: "S" },
      ],
    });
    expect(project.snapshots).toEqual([{
      name: "S", folder: "", start: { kind: "conditions", match: "all", conditions: [] }, fadeInMs: 0, fadeOutMs: 60000, holdMs: 10, priority: 100,
      combine: "override", buses: { Music: -60 }, effects: { Music: { lp: { cutoff: 400 } } },
    }]);
    expect(problems.length).toBe(10);
  });

  it("drops unknown effect types and gives missing or taken ids new ones", () => {
    const { project, problems } = parseAudioProject({
      format: AUDIO_PROJECT_FORMAT,
      buses: [{ name: "Master", effects: [{ type: "wobble" }, { type: "lowpass" }, { id: "fx1", type: "highpass", on: "yes", params: { cutoff: 100, bad: "x" } }] }],
    });
    expect(project.buses[0].effects).toEqual([
      { id: "fx1", type: "lowpass", on: true, params: {} },
      { id: "fx2", type: "highpass", on: true, params: { cutoff: 100 } },
    ]);
    expect(problems).toHaveLength(4);
  });

  it("checks automation targets against the owner's sends and effects", () => {
    const { project, problems } = parseAudioProject({
      format: AUDIO_PROJECT_FORMAT,
      parameters: [{ name: "p", min: 0, max: 1 }],
      buses: [{ name: "Master" }, { name: "SFX", parent: "Master", sends: [{ to: "R", levelDb: 0 }], effects: [{ id: "fx1", type: "lowpass" }] }],
      returns: [{ name: "R" }],
      automation: [
        { on: "SFX", target: "send:R", parameter: "p", curve: [[0, 0]] },
        { on: "SFX", target: "fx:fx1:cutoff", parameter: "p", curve: [[0, 100]], bypass: true },
        { on: "SFX", target: "send:Other", parameter: "p", curve: [[0, 0]] },
        { on: "SFX", target: "fx:nope:cutoff", parameter: "p", curve: [[0, 0]] },
        { on: "SFX", target: "volume", parameter: "nope", curve: [[0, 0]] },
        { on: "R", target: "pan", parameter: "p", curve: [[0, 0]] },
      ],
    });
    expect(project.automation.map((a) => [a.target, a.bypass])).toEqual([["send:R", false], ["fx:fx1:cutoff", true]]);
    expect(problems).toHaveLength(4);
  });

  it("never throws on junk", () => {
    for (const junk of [null, [], "x", { buses: 3, returns: {}, vcas: "x", ducking: 1, snapshots: [1, null], automation: [{}], loudness: [], settings: 4 }]) {
      expect(() => parseAudioProject(junk)).not.toThrow();
    }
  });
});

describe("toRuntimeSettings", () => {
  const { project } = parseAudioProject(FULL);

  it("gives a section the runtime's parse reads without problems", () => {
    const warnings: string[] = [];
    const settings = toRuntimeSettings(project, warnings);
    expect(parseAudioSettings(settings).problems).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("folds VCA offsets into member levels, once per VCA down the tree", () => {
    const settings = toRuntimeSettings(project);
    const vol = (name: string) => settings.buses.find((b) => b.name === name)!.volume;
    expect(vol("Music")).toBeCloseTo(Math.pow(10, -3 / 20), 9);
    expect(vol("SFX")).toBeCloseTo(Math.pow(10, -8 / 20), 9); // -2 dB fader, -6 dB VCA
    expect(vol("Vehicles")).toBe(1); // the VCA lists its ancestor SFX: counted there
    expect(settings.buses.find((b) => b.name === "Vehicles")!.mute).toBe(true);
  });

  it("turns a send into a reverb return into the reverb send effect, the return's level folded in", () => {
    const sfx = toRuntimeSettings(project).buses.find((b) => b.name === "SFX")!;
    expect(sfx.effects).toEqual([{ type: "reverb", send: expect.closeTo(Math.pow(10, -15 / 20), 9) }]); // the eq is left out
  });

  it("maps snapshots, ducking, automation and the open low-pass carrier", () => {
    const settings = toRuntimeSettings(project);
    expect(settings.snapshots).toEqual([{ name: "Underwater", volumes: { Music: expect.closeTo(Math.pow(10, -6 / 20), 9) }, lowpass: { Music: 800 } }]);
    expect(settings.buses.find((b) => b.name === "Music")!.effects).toEqual([]); // the carrier is neutral and hidden
    expect(settings.ducking).toEqual([{ target: "Music", trigger: "SFX", mode: "presence", amount: expect.closeTo(Math.pow(10, -6 / 20), 9), attack: 0.08, release: 0.4 }]);
    expect(settings.automation).toEqual([{ bus: "Music", parameter: "threat", target: "volume", curve: [[0, 1], [1, expect.closeTo(Math.pow(10, -6 / 20), 9), "easeOut"]] }]);
    expect(settings.loudnessTargets).toEqual(FULL.loudness.targets);
    expect(settings.loudnessResetOnPlay).toBe(false);
    expect(settings.buses.find((b) => b.name === "Music")!.maxVoices).toBe(8);
    expect(settings.buses.find((b) => b.name === "SFX")).toMatchObject({ bed: "own", bedPriority: 80 });
    expect(settings.buses.find((b) => b.name === "Music")!.meter).toBe("loudness");
  });

  it("warns once per thing the runtime can't express and keeps it in the project", () => {
    const warnings: string[] = [];
    toRuntimeSettings(project, warnings);
    expect(warnings.join("\n")).toMatch(/eq effect "fx1"/);
    expect(warnings.join("\n")).toMatch(/send:Reverb on "SFX"/);
    expect(warnings.join("\n")).toMatch(/offset on "Reverb"/);
    expect(warnings.join("\n")).toMatch(/on conditions/);
    expect(warnings.join("\n")).toMatch(/bedBeyond/);
    expect(project.buses[2].effects).toHaveLength(1);
  });

  it("silences a level at the fader floor and caps it at the old model's top", () => {
    const p = parseAudioProject({ format: AUDIO_PROJECT_FORMAT, buses: [{ name: "Master", volumeDb: MAX_DB }, { name: "A", parent: "Master", volumeDb: -60 }] }).project;
    expect(toRuntimeSettings(p).buses.map((b) => b.volume)).toEqual([2, 0]);
  });

  it("leaves out disabled rules and bypassed automation without a warning", () => {
    const p = parseAudioProject({
      format: AUDIO_PROJECT_FORMAT,
      parameters: [{ name: "p", min: 0, max: 1 }],
      buses: [{ name: "Master" }, { name: "A", parent: "Master" }, { name: "B", parent: "Master" }],
      ducking: [{ target: "A", trigger: "B", mode: "presence", enabled: false }],
      automation: [{ on: "A", target: "volume", parameter: "p", curve: [[0, 0]], bypass: true }],
    }).project;
    const warnings: string[] = [];
    const s = toRuntimeSettings(p, warnings);
    expect([s.ducking, s.automation, warnings]).toEqual([[], [], []]);
  });
});

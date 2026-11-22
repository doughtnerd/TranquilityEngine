import { describe, expect, it } from "vitest";
import { parseAudioSettings, type AudioSettings } from "../settings";
import { audioProjectToJson, parseAudioProject } from "./format";
import { coreSectionOf as toRuntimeSettings } from "./runtimeView";
import { fromLegacySection, mergeLegacyIntoProject } from "./legacy";
import { AUDIO_PROJECT_FORMAT, type AudioProject } from "./types";

/** An old `audio` section using everything the old shape has. */
const LEGACY = {
  buses: [
    { name: "Master", bedPriority: 200 },
    { name: "Music", parent: "Master", volume: 0.8, effects: [{ type: "lowpass", frequency: 18000, q: 1 }], meter: "loudness" },
    { name: "SFX", parent: "Master", volume: 0.5, maxVoices: 48, bed: "own", bedPriority: 80, effects: [{ type: "compressor", threshold: -20, knee: 10, ratio: 4, attack: 0.07, release: 0.3 }, { type: "reverb", send: 0.25 }] },
    { name: "Voice", parent: "Master", mute: true, bed: "none" },
  ],
  snapshots: [{ name: "Paused", volumes: { Music: 0.3, SFX: 0 }, lowpass: { Music: 800 } }],
  ducking: [
    { target: "Music", trigger: "Voice", mode: "presence", amount: 0.4, attack: 0.1, release: 0.6 },
    { target: "SFX", trigger: "Voice", mode: "level", detector: "peak", threshold: -24, amount: 0.5, attack: 0.05, release: 0.5 },
  ],
  parameters: [{ name: "Intensity", min: 0, max: 1 }],
  automation: [
    { bus: "Music", parameter: "Intensity", target: "volume", curve: [[0, 0.4], [1, 1]] },
    { bus: "SFX", parameter: "Intensity", target: "lowpass", curve: [[0, 500], [1, 20000]] },
  ],
  voices: { mixed: 96, logical: 2048, hrtf: 8 },
  rhythmMode: true,
  loudnessResetOnPlay: false,
};

const runtime = (p: AudioProject): AudioSettings => toRuntimeSettings(p);
const busOf = (p: AudioProject, name: string) => p.buses.find((b) => b.name === name)!;
const view = (p: AudioProject) => structuredClone(runtime(p)) as AudioSettings;

describe("fromLegacySection (the migration)", () => {
  const problems: string[] = [];
  const project = fromLegacySection(LEGACY, problems);

  it("converts levels to dB and keeps the engine settings", () => {
    expect(problems).toEqual([]);
    expect(busOf(project, "Music").volumeDb).toBeCloseTo(20 * Math.log10(0.8), 6);
    expect(busOf(project, "Master").volumeDb).toBe(0);
    expect(project.settings).toMatchObject({ voices: { mixed: 96, logical: 2048, hrtf: 8 }, rhythmMode: true, submixes: 32, bedBeyond: null, dopplerAmount: 1 });
    expect(project.loudness.resetOnPlay).toBe(false);
  });

  it("turns the reverb send effect into a send to a created Reverb return", () => {
    expect(project.returns).toEqual([{ name: "Reverb", output: "Master", volumeDb: 0, mute: false, effects: [{ id: "fx1", type: "reverb", on: true, params: { size: 0.5, decay: 1.8, mix: 100 } }] }]);
    const sfx = busOf(project, "SFX");
    expect(sfx.sends).toEqual([{ to: "Reverb", levelDb: expect.closeTo(20 * Math.log10(0.25), 6) }]);
    expect(sfx.effects[0]).toEqual({ id: "fx1", type: "compressor", on: true, params: { threshold: -20, ratio: 4, attack: 70, release: 300, makeup: 0, knee: 10 } });
    expect(sfx.effects.slice(1).map((e) => [e.id, e.type, e.params.cutoff])).toEqual([["fx2", "lowpass", 20000]]); // the carrier of its low-pass automation
  });

  it("turns snapshot multipliers into dB offsets and a snapshot low-pass into an override of a created open low-pass", () => {
    const music = busOf(project, "Music");
    expect(music.effects.map((e) => [e.id, e.type, e.params.cutoff])).toEqual([["fx1", "lowpass", 18000], ["fx2", "lowpass", 20000]]);
    expect(project.snapshots).toEqual([{
      name: "Paused", folder: "", start: { kind: "code" }, fadeInMs: 300, fadeOutMs: 300, holdMs: 0, priority: 0, combine: "override",
      buses: { Music: expect.closeTo(20 * Math.log10(0.3), 6), SFX: -60 }, effects: { Music: { fx2: { cutoff: 800 } } },
    }]);
  });

  it("keeps bus automation as volume (in dB) and low-pass targets", () => {
    expect(project.automation).toEqual([
      { on: "Music", target: "volume", parameter: "Intensity", curve: [[0, expect.closeTo(20 * Math.log10(0.4), 6)], [1, 0]], bypass: false },
      { on: "SFX", target: "fx:fx2:cutoff", parameter: "Intensity", curve: [[0, 500], [1, 20000]], bypass: false },
    ]);
  });

  it("maps beds, voice limits, metering and ducking", () => {
    expect(busOf(project, "Master").bed).toEqual({ own: true, priority: 200 });
    expect(busOf(project, "SFX")).toMatchObject({ voiceLimit: 48, bed: { own: true, priority: 80 } });
    expect(busOf(project, "Voice")).toMatchObject({ mute: true, bed: { own: false, priority: 128 } });
    expect(busOf(project, "Music").bed).toBeNull();
    expect(busOf(project, "Music").meter).toBe(true);
    expect(project.ducking[1]).toEqual({ target: "SFX", trigger: "Voice", mode: "level", detector: "peak", thresholdDb: -24, amountDb: expect.closeTo(20 * Math.log10(0.5), 6), attackMs: 50, releaseMs: 500, enabled: true });
  });

  it("writes a file that parses back to itself", () => {
    const back = parseAudioProject(audioProjectToJson(project));
    expect(back.problems).toEqual([]);
    expect(back.project).toEqual(project);
  });

  it("plays as the old section did, its reverb send now a send into the Reverb return (a bus of the view, ADR 0330)", () => {
    const warnings: string[] = [];
    const reverb = { name: "Reverb", parent: "Master", volume: 1, mute: false, effects: [{ type: "fx", fx: "reverb", params: { size: 0.5, decay: 1.8, mix: 100 } }] };
    const expected = {
      ...LEGACY,
      buses: [...LEGACY.buses.map((b) => (b.name === "SFX" ? { ...b, effects: b.effects!.slice(0, 1), sends: [{ to: "Reverb", level: 0.25 }] } : b)), reverb],
    };
    expect(toRuntimeSettings(project, warnings)).toEqual(parseAudioSettings(expected).settings);
    expect(warnings).toEqual([]);
  });

  it("migrates nothing to the default mix, and drops a reverb on Master with a problem", () => {
    expect(runtime(fromLegacySection(undefined))).toEqual(parseAudioSettings(undefined).settings);
    const p: string[] = [];
    const m = fromLegacySection({ buses: [{ name: "Master", effects: [{ type: "reverb", send: 0.5 }] }] }, p);
    expect(m.returns).toEqual([]);
    expect(p).toHaveLength(1);
  });

  it("names the return around a bus already called Reverb", () => {
    const m = fromLegacySection({ buses: [{ name: "Master" }, { name: "Reverb", parent: "Master", effects: [{ type: "reverb", send: 0.5 }] }] });
    expect(m.returns.map((r) => r.name)).toEqual(["Reverb 2"]);
  });
});

/** A project with what the old shape can't express. */
const RICH = parseAudioProject({
  format: AUDIO_PROJECT_FORMAT,
  parameters: [{ name: "p", min: 0, max: 1 }],
  buses: [
    { name: "Master" },
    { name: "Music", parent: "Master", volumeDb: -3, effects: [{ id: "eq", type: "eq", params: { low: 2 } }, { id: "lp", type: "lowpass", params: { cutoff: 5000, resonance: 0.3, drive: 0 } }, { id: "off", type: "highpass", on: false }] },
    { name: "SFX", parent: "Master", volumeDb: -2, sends: [{ to: "Delay", levelDb: -6 }, { to: "Reverb", levelDb: -10 }] },
  ],
  returns: [{ name: "Delay", effects: [{ id: "fx1", type: "delay" }] }, { name: "Reverb", volumeDb: -2, effects: [{ id: "fx1", type: "reverb" }] }],
  vcas: [{ name: "All", volumeDb: -6, members: ["Music", "SFX"] }],
  automation: [{ on: "SFX", target: "send:Delay", parameter: "p", curve: [[0, -6]] }, { on: "Music", target: "volume", parameter: "p", curve: [[0, 0], [1, -6]] }],
  ducking: [{ target: "Music", trigger: "SFX", mode: "presence", enabled: false }, { target: "SFX", trigger: "Music", mode: "presence", amountDb: -4 }],
  snapshots: [{ name: "Calm", start: { kind: "base" }, priority: 30, buses: { Music: -4, Delay: -10 }, effects: { Music: { eq: { low: -3 } } } }],
}).project;

describe("mergeLegacyIntoProject (a live op of the old shape, lifted into the mix)", () => {
  it("is the identity on an unchanged view", () => {
    expect(mergeLegacyIntoProject(RICH, view(RICH))).toEqual(RICH);
    const migrated = fromLegacySection(LEGACY);
    expect(mergeLegacyIntoProject(migrated, view(migrated))).toEqual(migrated);
  });

  it("writes a changed level as the fader alone (the view has no VCAs) and keeps everything the view doesn't show", () => {
    const v = view(RICH);
    v.buses.find((b) => b.name === "Music")!.volume = 0.5;
    const out = mergeLegacyIntoProject(RICH, v);
    expect(busOf(out, "Music").volumeDb).toBeCloseTo(20 * Math.log10(0.5), 6);
    expect({ ...out, buses: out.buses.map((b) => (b.name === "Music" ? { ...b, volumeDb: -3 } : b)) }).toEqual(RICH);
  });

  it("updates a shown effect in place, keeping its id, its unmapped params and the hidden effects", () => {
    const v = view(RICH);
    // The view shows what the core runs (ADR 0331): the eq as a catalogue effect, then the low-pass in its legacy shape.
    const [eq, lp] = v.buses.find((b) => b.name === "Music")!.effects;
    expect(eq.type).toBe("fx");
    expect(lp.type).toBe("lowpass");
    if (lp.type === "lowpass") lp.frequency = 3000;
    const music = busOf(mergeLegacyIntoProject(RICH, v), "Music");
    expect(music.effects).toEqual([
      { id: "eq", type: "eq", on: true, params: { low: 2, mid: 0, high: 0 } },
      { id: "lp", type: "lowpass", on: true, params: { cutoff: 3000, resonance: 0.3, drive: 0 } },
      { id: "off", type: "highpass", on: false, params: { cutoff: 20, resonance: 0.1, drive: 0 } },
    ]);
  });

  it("updates a catalogue effect's changed param by name, keeping the others", () => {
    const v = view(RICH);
    const eq = v.buses.find((b) => b.name === "Music")!.effects[0];
    if (eq.type !== "fx") throw new Error("expected the eq as a catalogue effect");
    eq.params.mid = -4;
    const music = busOf(mergeLegacyIntoProject(RICH, v), "Music");
    expect(music.effects[0]).toEqual({ id: "eq", type: "eq", on: true, params: { low: 2, mid: -4, high: 0 } });
    expect(music.effects[1]).toEqual(busOf(RICH, "Music").effects[1]);
  });

  it("adds and removes shown effects where they stood, never reusing a removed id", () => {
    const v = view(RICH);
    v.buses.find((b) => b.name === "Music")!.effects = [{ type: "compressor", threshold: -10, knee: 5, ratio: 2, attack: 0.01, release: 0.2 }];
    const music = busOf(mergeLegacyIntoProject(RICH, v), "Music");
    // The eq is shown too now (the core runs it, ADR 0331), so replacing the list removes it; the bypassed high-pass stays.
    expect(music.effects.map((e) => [e.id, e.type])).toEqual([["fx1", "compressor"], ["off", "highpass"]]);
  });

  it("writes an old section's reverb send effect as the send to the reverb return, its level less the return's", () => {
    const v = view(RICH);
    const sfx = v.buses.find((b) => b.name === "SFX")!;
    sfx.effects = [{ type: "reverb", send: 0.5 }];
    expect(busOf(mergeLegacyIntoProject(RICH, v), "SFX").sends).toEqual([{ to: "Delay", levelDb: -6 }, { to: "Reverb", levelDb: expect.closeTo(20 * Math.log10(0.5) + 2, 6) }]);
  });

  it("writes the view's sends (linear) back in dB: a changed level, an unchanged one exact, a removed one gone", () => {
    const v = view(RICH);
    const sfx = v.buses.find((b) => b.name === "SFX")!;
    expect(sfx.sends).toEqual([{ to: "Delay", level: expect.closeTo(Math.pow(10, -6 / 20), 9) }, { to: "Reverb", level: expect.closeTo(Math.pow(10, -10 / 20), 9) }]);
    sfx.sends![1] = { to: "Reverb", level: 0.5 };
    expect(busOf(mergeLegacyIntoProject(RICH, v), "SFX").sends).toEqual([{ to: "Delay", levelDb: -6 }, { to: "Reverb", levelDb: expect.closeTo(20 * Math.log10(0.5), 6) }]);
    sfx.sends = [sfx.sends![0]!];
    expect(busOf(mergeLegacyIntoProject(RICH, v), "SFX").sends).toEqual([{ to: "Delay", levelDb: -6 }]);
  });

  it("writes a return edited as a bus of the view back to the return: level, mute, output and inserts", () => {
    const v = view(RICH);
    expect(v.buses.map((b) => b.name)).toEqual(["Master", "Music", "SFX", "Delay", "Reverb"]);
    const delay = v.buses.find((b) => b.name === "Delay")!;
    delay.volume = 0.5;
    delay.mute = true;
    delay.parent = "Music";
    const fx = delay.effects[0]!;
    if (fx.type !== "fx") throw new Error("expected the delay as a catalogue effect");
    fx.params.time = 400;
    const out = mergeLegacyIntoProject(RICH, v);
    const ret = out.returns.find((r) => r.name === "Delay")!;
    expect(ret).toMatchObject({ output: "Music", mute: true, volumeDb: expect.closeTo(20 * Math.log10(0.5), 6) });
    expect(ret.effects[0]).toMatchObject({ id: "fx1", type: "delay", params: expect.objectContaining({ time: 400 }) });
    expect(out.buses.map((b) => b.name)).toEqual(["Master", "Music", "SFX"]); // still a return, not a bus
    expect(out.returns.find((r) => r.name === "Reverb")).toEqual(RICH.returns[1]);
  });

  it("follows a return renamed in place into the sends, automation and snapshots; a return removed from the view goes with its sends", () => {
    const v = view(RICH);
    v.buses.find((b) => b.name === "Delay")!.name = "Echo";
    v.buses.find((b) => b.name === "SFX")!.sends![0]!.to = "Echo";
    v.snapshots[0].volumes = { ...v.snapshots[0].volumes, Echo: v.snapshots[0].volumes.Delay! };
    delete v.snapshots[0].volumes.Delay;
    v.automation.find((a) => a.target === "send")!.to = "Echo"; // ABI 4.8: the view shows send automation (a rename op renames its `to`)
    const out = mergeLegacyIntoProject(RICH, v);
    expect(out.returns.map((r) => r.name)).toEqual(["Echo", "Reverb"]);
    expect(busOf(out, "SFX").sends).toEqual([{ to: "Echo", levelDb: -6 }, { to: "Reverb", levelDb: -10 }]);
    expect(out.automation[0]!.target).toBe("send:Echo");
    expect(out.snapshots[0]!.buses).toEqual({ Music: -4, Echo: -10 });
    const gone = view(RICH);
    gone.buses = gone.buses.filter((b) => b.name !== "Delay");
    gone.buses.find((b) => b.name === "SFX")!.sends = gone.buses.find((b) => b.name === "SFX")!.sends!.filter((s) => s.to !== "Delay");
    gone.snapshots[0].volumes = { Music: gone.snapshots[0].volumes.Music! };
    const removed = mergeLegacyIntoProject(RICH, gone);
    expect(removed.returns.map((r) => r.name)).toEqual(["Reverb"]);
    expect(busOf(removed, "SFX").sends).toEqual([{ to: "Reverb", levelDb: -10 }]);
  });

  it("creates a Reverb return for a reverb added where there was none", () => {
    const p = parseAudioProject({ format: AUDIO_PROJECT_FORMAT }).project;
    const v = view(p);
    v.buses.find((b) => b.name === "SFX")!.effects.push({ type: "reverb", send: 1 });
    const out = mergeLegacyIntoProject(p, v);
    expect(out.returns.map((r) => r.name)).toEqual(["Reverb"]);
    expect(busOf(out, "SFX").sends).toEqual([{ to: "Reverb", levelDb: 0 }]);
  });

  it("keeps a snapshot's trigger, return offsets and effect overrides when its levels change", () => {
    const v = view(RICH);
    v.snapshots[0].volumes.Music = 1;
    const snap = mergeLegacyIntoProject(RICH, v).snapshots[0];
    expect(snap).toEqual({ ...RICH.snapshots[0], buses: { Delay: -10, Music: 0 } });
  });

  it("writes a snapshot low-pass to a carrier on the bus and removes the carrier with the last override", () => {
    const v = view(RICH);
    v.snapshots[0].lowpass.SFX = 600;
    const withLp = mergeLegacyIntoProject(RICH, v);
    expect(busOf(withLp, "SFX").effects).toEqual([{ id: "fx1", type: "lowpass", on: true, params: expect.objectContaining({ cutoff: 20000 }) }]);
    expect(withLp.snapshots[0].effects.SFX).toEqual({ fx1: { cutoff: 600 } });
    expect(runtime(withLp).snapshots[0].lowpass).toEqual({ SFX: 600 });
    expect(runtime(withLp).buses.find((b) => b.name === "SFX")!.effects).toEqual([]); // the carrier is hidden; sends aren't effects
    const v2 = view(withLp);
    v2.snapshots[0].lowpass = {};
    expect(mergeLegacyIntoProject(withLp, v2)).toEqual(RICH);
  });

  it("pairs ducking rules among the shown ones, keeping the disabled one", () => {
    const v = view(RICH);
    v.ducking[0].amount = 1;
    const out = mergeLegacyIntoProject(RICH, v);
    expect(out.ducking).toEqual([RICH.ducking[0], { ...RICH.ducking[1], amountDb: 0 }]);
    v.ducking = [];
    expect(mergeLegacyIntoProject(RICH, v).ducking).toEqual([RICH.ducking[0]]);
  });

  it("pairs automation among the shown ones (ABI 4.8: send and effect automation are shown too), keeping one the view can't show", () => {
    const v = view(RICH);
    v.automation.find((a) => a.target === "volume")!.curve = [[0, 1], [1, 1]];
    const out = mergeLegacyIntoProject(RICH, v);
    expect(out.automation).toEqual([RICH.automation[0], { ...RICH.automation[1], curve: [[0, 0], [1, 0]] }]);
    v.automation.find((a) => a.target === "send")!.curve = [[0, -3]];
    expect(mergeLegacyIntoProject(RICH, v).automation[0]).toEqual({ ...RICH.automation[0], curve: [[0, -3]] });
    // An automation of an effect the core doesn't run (switched off) isn't shown, and stays.
    const hidden = { ...structuredClone(RICH), automation: [...structuredClone(RICH.automation), { on: "Music", target: "fx:off:cutoff" as const, parameter: "p", curve: [[0, 500]] as [number, number][], bypass: false }] };
    const hv = view(hidden);
    hv.automation.find((a) => a.target === "volume")!.curve = [[0, 1], [1, 1]];
    expect(mergeLegacyIntoProject(hidden, hv).automation[2]).toEqual(hidden.automation[2]);
  });

  it("follows a bus renamed in place into VCAs, sends, hidden effects and snapshots", () => {
    const v = view(RICH);
    v.buses.find((b) => b.name === "Music")!.name = "Score";
    v.snapshots[0].volumes = { Score: v.snapshots[0].volumes.Music };
    v.automation[0].bus = "Score";
    v.ducking[0].trigger = "Score";
    const out = mergeLegacyIntoProject(RICH, v);
    expect(busOf(out, "Score").effects.map((e) => e.id)).toEqual(["eq", "lp", "off"]);
    expect(out.vcas[0].members).toEqual(["Score", "SFX"]);
    expect(out.snapshots[0].effects).toEqual({ Score: { eq: { low: -3 } } });
    expect(out.ducking[1].trigger).toBe("Score");
  });

  it("drops what named a removed bus, as the file's parse would", () => {
    const v = view(RICH);
    v.buses = v.buses.filter((b) => b.name !== "Music");
    v.snapshots[0].volumes = {};
    v.automation = [];
    v.ducking = [];
    const out = mergeLegacyIntoProject(RICH, v);
    expect(out.buses.map((b) => b.name)).toEqual(["Master", "SFX"]);
    expect(out.vcas[0].members).toEqual(["SFX"]);
    expect(out.snapshots[0].effects).toEqual({});
  });

  it("writes engine settings the view changed, and only those", () => {
    const v = view(RICH);
    v.spatial = "equalPower";
    const out = mergeLegacyIntoProject(RICH, v);
    expect(out.settings).toEqual({ ...RICH.settings, spatial: "equalPower" });
  });
});

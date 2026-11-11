import { describe, expect, it } from "vitest";
import {
  AUDIO_EVENT_FORMAT, MAX_EVENT_DEPTH, eventClips, formatAudioEvent, isAudioEventPath, parameterDefault, parameterRange,
  parseAudioEvent, parseParameters, type BlendNode, type ClipNode, type RandomNode, type SustainNode, type SwitchNode,
} from "../audio/eventFormat";

const clip = (path: string, extra: object = {}) => ({ type: "clip", clip: path, ...extra });

describe("parseAudioEvent", () => {
  it("reads a full event with no problems", () => {
    const { value, problems } = parseAudioEvent({
      format: AUDIO_EVENT_FORMAT, bus: "SFX", volume: 0.8, pitchRandom: [-1, 1], priority: 200,
      spatial: { minDistance: 2, maxDistance: 40, rolloff: "linear" }, limit: { maxInstances: 4, steal: "quietest" }, cooldown: 0.05,
      parameters: [{ name: "Speed", min: 0, max: 10, default: 2, seekSpeed: 20 }, { name: "Surface", labels: ["Grass", "Gravel"] }],
      automation: [{ parameter: "Speed", target: "volume", curve: [[0, 0.5], [10, 1]] }],
      root: { type: "switch", parameter: "Surface", children: [
        { type: "random", value: "Grass", avoidRepeat: 1, children: [clip("sfx/g1.ogg"), clip("asset:sfx/g2.ogg", { weight: 2 })] },
        { ...clip("sfx/gravel.ogg"), value: "Gravel" },
      ] },
    });
    expect(problems).toEqual([]);
    expect(value.bus).toBe("SFX");
    expect(value.spatial).toEqual({ minDistance: 2, maxDistance: 40, rolloff: "linear" });
    expect(value.limit).toEqual({ maxInstances: 4, steal: "quietest" });
    const sw = value.root as SwitchNode;
    expect(sw.type).toBe("switch");
    expect(sw.onChange).toBe("keep");
    const rnd = sw.children[0] as RandomNode;
    expect(rnd.avoidRepeat).toBe(1);
    expect((rnd.children[1] as ClipNode).clip).toBe("sfx/g2.ogg");
    expect(rnd.children[1].weight).toBe(2);
    expect(eventClips(value)).toEqual(["sfx/g1.ogg", "sfx/g2.ogg", "sfx/gravel.ogg"]);
  });

  it("never throws and falls back to an empty layer", () => {
    for (const raw of [null, 3, "x", [], { root: 5 }]) {
      const { value, problems } = parseAudioEvent(raw);
      expect(value.root.type).toBe("layer");
      expect(problems.length).toBeGreaterThan(0);
    }
  });

  it("reports a wrong format but still reads the rest", () => {
    const { value, problems } = parseAudioEvent({ format: "myco.audioevent@9", root: clip("a.ogg") });
    expect(problems[0]).toMatch(/format/);
    expect(value.root.type).toBe("clip");
  });

  it("clamps numbers, swaps ranges and drops bad nodes", () => {
    const { value, problems } = parseAudioEvent({
      format: AUDIO_EVENT_FORMAT, volume: 9, priority: 300, volumeRandom: [3, -6],
      root: { type: "layer", children: [clip("a.ogg"), { type: "wobble" }, 7] },
    });
    expect(value.volume).toBe(4);
    expect(value.priority).toBe(255);
    expect(value.volumeRandom).toEqual([-6, 3]);
    expect((value.root as { children: unknown[] }).children).toHaveLength(1);
    expect(problems.length).toBe(5);
  });

  it("caps avoidRepeat at children - 1 and nesting depth", () => {
    const { value } = parseAudioEvent({ format: AUDIO_EVENT_FORMAT, root: { type: "random", avoidRepeat: 5, children: [clip("a.ogg"), clip("b.ogg")] } });
    expect((value.root as RandomNode).avoidRepeat).toBe(1);
    let deep: object = clip("x.ogg");
    for (let i = 0; i < MAX_EVENT_DEPTH + 2; i++) deep = { type: "layer", children: [deep] };
    const r = parseAudioEvent({ format: AUDIO_EVENT_FORMAT, root: deep });
    expect(r.problems.some((p) => p.includes("nested deeper"))).toBe(true);
    expect(eventClips(r.value)).toEqual([]);
  });

  it("reads sustain clips and sustain containers", () => {
    const { value, problems } = parseAudioEvent({
      format: AUDIO_EVENT_FORMAT,
      root: { type: "layer", children: [
        clip("engine.wav", { sustain: true, loopRegion: [0.5, 2.5] }),
        { type: "sustain", start: clip("on.ogg"), loop: clip("hum.ogg", { loop: true }), end: clip("off.ogg"), release: "now", fade: 0.2 },
        { type: "sustain" },
        clip("bad.ogg", { loopRegion: [2, 2] }),
      ] },
    });
    const kids = (value.root as { children: unknown[] }).children;
    expect(kids).toHaveLength(3);
    expect(kids[0]).toMatchObject({ sustain: true, loopRegion: [0.5, 2.5] });
    const s = kids[1] as SustainNode;
    expect(s.release).toBe("now");
    expect(s.fade).toBe(0.2);
    expect((s.start as ClipNode).clip).toBe("on.ogg");
    expect((kids[2] as ClipNode).loopRegion).toBeUndefined();
    expect(problems.some((p) => p.includes("needs a loop node"))).toBe(true);
    expect(problems.some((p) => p.includes("loopRegion"))).toBe(true);
    expect(eventClips(value)).toEqual(["engine.wav", "on.ogg", "hum.ogg", "off.ogg", "bad.ogg"]);
  });

  it("warns about blend children without ranges and switches on numeric parameters", () => {
    const { value, problems } = parseAudioEvent({
      format: AUDIO_EVENT_FORMAT, parameters: [{ name: "RPM", min: 0, max: 8000 }],
      root: { type: "layer", children: [
        { type: "blend", parameter: "RPM", children: [clip("low.ogg", { range: [0, 3000], fade: 1000 }), clip("high.ogg")] },
        { type: "switch", parameter: "RPM", children: [clip("a.ogg", { value: "x" })] },
      ] },
    });
    const blend = (value.root as { children: BlendNode[] }).children[0];
    expect(blend.children[0].range).toEqual([0, 3000]);
    expect(blend.children[0].fade).toBe(1000);
    expect(problems.some((p) => p.includes("needs a range"))).toBe(true);
    expect(problems.some((p) => p.includes("needs a labelled parameter"))).toBe(true);
  });

  it("drops automation with unknown targets or empty curves", () => {
    const { value, problems } = parseAudioEvent({
      format: AUDIO_EVENT_FORMAT, root: clip("a.ogg"),
      automation: [{ parameter: "P", target: "pan", curve: [[0, 0]] }, { parameter: "P", target: "pitch", curve: [] }, { parameter: "P", target: "lowpass", curve: [[0, 200], [1, 20000]] }],
    });
    expect(value.automation).toEqual([{ parameter: "P", target: "lowpass", curve: [[0, 200], [1, 20000]] }]);
    expect(problems).toHaveLength(2);
  });

  it("round-trips through formatAudioEvent", () => {
    const { value } = parseAudioEvent({ format: AUDIO_EVENT_FORMAT, bus: "SFX", root: { type: "sequence", mode: "continuous", loop: true, children: [clip("a.ogg"), clip("b.ogg")] } });
    const text = formatAudioEvent(value);
    expect(text.startsWith('{\n  "format": "myco.audioevent@1"')).toBe(true);
    const again = parseAudioEvent(JSON.parse(text));
    expect(again.problems).toEqual([]);
    expect(again.value).toEqual(value);
  });
});

describe("parseParameters", () => {
  it("reads numeric and labelled parameters and reports bad ones", () => {
    const problems: string[] = [];
    const ps = parseParameters([
      { name: "A", min: 10, max: 0, default: 20 },
      { name: "Area", labels: ["Out", "Cave", "Cave", 3], default: "Hall" },
      { name: "A" }, { name: "" }, { name: "L", labels: [] },
    ], "p", problems);
    expect(ps).toEqual([{ name: "A", min: 0, max: 10, default: 10, seekSpeed: 0 }, { name: "Area", labels: ["Out", "Cave"], default: "Out" }]);
    expect(problems).toHaveLength(6);
    expect(parameterRange(ps[1])).toEqual([0, 1]);
    expect(parameterDefault(ps[1])).toBe(0);
    expect(parameterDefault(ps[0])).toBe(10);
  });
});

describe("isAudioEventPath", () => {
  it("matches the suffix case-insensitively", () => {
    expect(isAudioEventPath("sfx/Step.AudioEvent.json")).toBe(true);
    expect(isAudioEventPath("sfx/step.ogg")).toBe(false);
  });
});

describe("releaseFade (m2-decisions entry 10)", () => {
  it("parses an optional releaseFade on a sustain node and falls back to fade without it", async () => {
    const { parseAudioEvent, sustainReleaseFade } = await import("../audio/eventFormat");
    const loop = { type: "clip", clip: "a.wav", loop: true };
    const withKey = parseAudioEvent({ format: "myco.audioevent@1", root: { type: "sustain", loop, fade: 0.3, releaseFade: 0.05 } });
    expect(withKey.problems).toEqual([]);
    const root = withKey.value.root as import("../audio/eventFormat").SustainNode;
    expect(root.releaseFade).toBe(0.05);
    expect(sustainReleaseFade(root)).toBe(0.05);
    const without = parseAudioEvent({ format: "myco.audioevent@1", root: { type: "sustain", loop, fade: 0.3 } }).value.root as import("../audio/eventFormat").SustainNode;
    expect(without.releaseFade).toBeUndefined();
    expect(sustainReleaseFade(without)).toBe(0.3);
  });
});


describe("ADR 0162 §2.5 additions", () => {
  const base = { format: AUDIO_EVENT_FORMAT, root: clip("a.ogg") };

  it("reads filter, sends and the spatial keys with no problems", () => {
    const { value, problems } = parseAudioEvent({
      ...base, filter: { lowpass: 9000, highpass: 80 }, sends: { reverb: 0.5, Cave: 0.3 },
      spatial: { minDistance: 1, maxDistance: 30, rolloff: "inverse", occlusion: false, dopplerLevel: 2, reverbSendCurve: [[0, 1], [1, 0.5]] },
    });
    expect(problems).toEqual([]);
    expect(value.filter).toEqual({ lowpass: 9000, highpass: 80 });
    expect(value.sends).toEqual({ reverb: 0.5, Cave: 0.3 });
    expect(value.spatial).toEqual({ minDistance: 1, maxDistance: 30, rolloff: "inverse", occlusion: false, dopplerLevel: 2, reverbSendCurve: [[0, 1], [1, 0.5]] });
  });

  it("leaves the keys absent when the file doesn't set them, and the writer emits none", () => {
    const { value } = parseAudioEvent({ ...base, spatial: { minDistance: 1 } });
    expect(value.filter).toBeUndefined();
    expect(value.sends).toBeUndefined();
    expect(Object.keys(value.spatial!)).toEqual(["minDistance", "maxDistance", "rolloff"]);
    const text = formatAudioEvent(value);
    for (const k of ["filter", "sends", "occlusion", "dopplerLevel", "reverbSendCurve"]) expect(text).not.toContain(k);
  });

  it("clamps filter Hz, send levels and dopplerLevel with problems", () => {
    const { value, problems } = parseAudioEvent({
      ...base, filter: { lowpass: 99999, highpass: 1 }, sends: { reverb: 5, Cave: -1 },
      spatial: { dopplerLevel: 9 },
    });
    expect(value.filter).toEqual({ lowpass: 24000, highpass: 10 });
    expect(value.sends).toEqual({ reverb: 2, Cave: 0 });
    expect(value.spatial!.dopplerLevel).toBe(5);
    expect(problems).toHaveLength(5);
  });

  it("keeps the first aux send and reports the rest", () => {
    const { value, problems } = parseAudioEvent({ ...base, sends: { A: 0.1, reverb: 1, B: 0.2, C: 0.3 } });
    expect(value.sends).toEqual({ A: 0.1, reverb: 1 });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/sends\.B.*one aux send/);
  });

  it("reports bad shapes without throwing", () => {
    const { value, problems } = parseAudioEvent({
      ...base, filter: 3, sends: { reverb: "x", Cave: "y" }, spatial: { occlusion: 1, reverbSendCurve: [] },
    });
    expect(value.filter).toBeUndefined();
    expect(value.sends).toEqual({ reverb: 1 });
    expect(value.spatial!.occlusion).toBe(true);
    expect(value.spatial!.reverbSendCurve).toBeUndefined();
    expect(problems.length).toBeGreaterThanOrEqual(5);
  });

  it("round-trips, writing filter and sends before root", () => {
    const { value } = parseAudioEvent({
      ...base, filter: { highpass: 120 }, sends: { Cave: 0.3 },
      spatial: { minDistance: 2, maxDistance: 9, rolloff: "linear", occlusion: true, dopplerLevel: 1, reverbSendCurve: [[0, 1], [1, 0, "smooth"]] },
    });
    const text = formatAudioEvent(value);
    const keys = Object.keys(JSON.parse(text));
    expect(keys.slice(-3)).toEqual(["filter", "sends", "root"]);
    const again = parseAudioEvent(JSON.parse(text));
    expect(again.problems).toEqual([]);
    expect(again.value).toEqual(value);
  });
});

// ADR 0336: blend regions and weight curves, fade shapes, post-exit and loop tails, bridge fades, pre-entry and
// beat-quantised automation, through `Audio.play` on the fake backend's one heard clock. Gains are read from what the
// backend was asked to do (voice volumes, stamped fades and gain ramps), evaluated on the audio clock.
import { describe, expect, it } from "vitest";
import { Audio } from "../Audio";
import { eventKit, pla, sample } from "./testKit";
import type { FakeVoice, FakeVoiceEvent } from "../testing";

const kit = eventKit();
const fake = kit.fake;

const meta = (sampleBlock: Record<string, unknown>) => ({ format: "myco.import@1", sample: sampleBlock });
const voicesOf = (path: string): FakeVoice[] => fake.voices.filter((v) => v.request.path === path);
const voiceOf = (path: string, nth = 0): FakeVoice => voicesOf(path)[nth]!;
const at = (t: number): void => { kit.setTime(t); kit.frame(); };
const playsOf = (path: string) => fake.plays.filter((p) => p.path === path).map((p) => (p.at === undefined ? undefined : Math.round(p.at * 1e6) / 1e6));
type Fade = Extract<FakeVoiceEvent, { kind: "fadeShaped" }>;
const fadesOf = (v: FakeVoice): Fade[] => v.events.filter((e): e is Fade => e.kind === "fadeShaped");

/** The core's four fade laws (`audio_dsp::curve_laws::value`), from a to b at phase u. */
function law(name: Fade["law"], a: number, b: number, u: number): number {
  const h = Math.PI / 2;
  switch (name) {
    case "linear": return a + (b - a) * u;
    case "sCurve": return a + (b - a) * u * u * (3 - 2 * u);
    case "equalPowerIn": return a + (b - a) * Math.sin(u * h);
    case "equalPowerOut": return b + (a - b) * Math.cos(u * h);
  }
}

/** The fade ramp's level at heard `t` from the voice's stamped fades (each takes over from where the last one is). */
function fadeLevelAt(v: FakeVoice, t: number, start: number): number {
  let level = start;
  for (const f of fadesOf(v).filter((e) => e.at !== undefined).sort((a, b) => a.at! - b.at!)) {
    if (t <= f.at!) break;
    const u = f.seconds > 0 ? Math.min(1, (t - f.at!) / f.seconds) : 1;
    const from = level;
    level = law(f.law, from, f.to, u);
    if (u < 1) return level;
    level = f.to;
  }
  return level;
}

const SURFACE = [{ name: "Surface", labels: ["Grass", "Stone"], default: "Grass" }];
const SWITCH = (entries: unknown[], sw: Record<string, unknown>) => pla("switch", entries, {
  parameters: SURFACE,
  switch: { parameter: "Surface", map: { Grass: 0, Stone: 1 }, ...sw },
});

// --- 1. Blend regions and weight curves --------------------------------------------------------------------------------

const SPEED = [{ name: "Speed", min: 0, max: 10, default: 0 }];
const BLEND = (entries: unknown[], blend: Record<string, unknown> = {}) => pla("blend", entries, {
  parameters: SPEED,
  blend: { axes: [{ parameter: "Speed" }], fade: "crossfade", curve: "linear", follow: { glideMs: 0 }, ...blend },
});

describe("Blend regions (1D)", () => {
  it("an explicit region: 0 outside, ramps over its fades, 1 between; neighbours overlap where their regions do", async () => {
    await kit.boot({
      "b.playlist.json": BLEND([
        sample("a.wav", { x: 1, atZeroWeight: "continue", region: { start: 0, end: 6, fadeIn: 0, fadeOut: 4 } }),
        sample("b.wav", { x: 8, atZeroWeight: "continue", region: { start: 3, end: 10, fadeIn: 4, fadeOut: 0 } }),
      ]),
    });
    const h = Audio.play("b.playlist.json", { parameters: { Speed: 1 } });
    const gains = (): [number, number] => [voiceOf("a.wav").volume, voiceOf("b.wav").volume];
    expect(gains()).toEqual([1, 0]);
    h.setParameter("Speed", 2.5); kit.frame(); // a's fade out starts at 2; b's fade in at 3
    expect(gains()[0]).toBeCloseTo(0.875, 6);
    expect(gains()[1]).toBeCloseTo(0, 6);
    h.setParameter("Speed", 4); kit.frame(); // the overlap [3, 6]: both play
    expect(gains()[0]).toBeCloseTo(0.5, 6);
    expect(gains()[1]).toBeCloseTo(0.25, 6);
    h.setParameter("Speed", 9); kit.frame();
    expect(gains()).toEqual([0, 1]);
  });

  it("region shapes default to the blend's curve and can be set per fade", async () => {
    await kit.boot({
      "b.playlist.json": BLEND([
        sample("a.wav", { x: 0, region: { start: 0, end: 10, fadeIn: 0, fadeOut: 10 } }),
        sample("b.wav", { x: 10, region: { start: 0, end: 10, fadeIn: 10, fadeOut: 0, shapeIn: "sCurve" } }),
      ], { curve: "equalPower" }),
    });
    Audio.play("b.playlist.json", { parameters: { Speed: 2.5 } });
    expect(voiceOf("a.wav").volume).toBeCloseTo(Math.cos(0.25 * Math.PI / 2), 6);
    expect(voiceOf("b.wav").volume).toBeCloseTo(0.25 * 0.25 * (3 - 0.5), 6);
  });

  it("layer mode: a layer with a region ends; entries without one keep ADR 0329's weights", async () => {
    await kit.boot({
      "b.playlist.json": BLEND([
        sample("a.wav", { x: 0 }),
        sample("b.wav", { x: 5, atZeroWeight: "continue", region: { start: 2, end: 6, fadeIn: 2, fadeOut: 2 } }),
        sample("c.wav", { x: 10 }),
      ], { fade: "layer" }),
    });
    const h = Audio.play("b.playlist.json", { parameters: { Speed: 7.5 } });
    expect([voiceOf("a.wav").volume, voiceOf("b.wav").volume, voiceOf("c.wav").volume]).toEqual([1, 0, 0.5]);
    h.setParameter("Speed", 5); kit.frame();
    expect(voiceOf("b.wav").volume).toBeCloseTo(0.5, 6);
  });
});

describe("Blend weight curves", () => {
  it("1D: a curve after the region shapes the weight (0 until the raw weight reaches 0.5)", async () => {
    await kit.boot({
      "b.playlist.json": BLEND([
        sample("a.wav", { x: 0 }),
        sample("b.wav", { x: 10, atZeroWeight: "continue", weightCurve: [[0, 0], [0.5, 0], [1, 1]] }),
      ]),
    });
    const h = Audio.play("b.playlist.json", { parameters: { Speed: 4 } });
    expect(voiceOf("b.wav").volume).toBeCloseTo(0, 6);
    expect(voiceOf("a.wav").volume).toBeCloseTo(0.6, 6);
    h.setParameter("Speed", 7.5); kit.frame();
    expect(voiceOf("b.wav").volume).toBeCloseTo(0.5, 6);
  });

  it("2D equal power: shaped weights are normalised to constant power", async () => {
    await kit.boot({
      "b.playlist.json": pla("blend", [
        sample("a.wav", { x: 0, y: 0 }),
        sample("b.wav", { x: 10, y: 0, weightCurve: [[0, 0], [1, 1, "easeIn"]] }),
      ], {
        parameters: [...SPEED, { name: "Y", min: 0, max: 10, default: 0 }],
        blend: { axes: [{ parameter: "Speed" }, { parameter: "Y" }], fade: "crossfade", curve: "equalPower", follow: { glideMs: 0 } },
      }),
    });
    Audio.play("b.playlist.json", { parameters: { Speed: 5 } });
    const a = voiceOf("a.wav").volume, b = voiceOf("b.wav").volume;
    expect(a * a + b * b).toBeCloseTo(1, 6);
    expect(b).toBeLessThan(a);
  });
});

// --- 3. Fade shapes ------------------------------------------------------------------------------------------------

describe("Transition fade shapes", () => {
  const MID: [string, number, number][] = [
    // shape, fade-out level at mid-fade, fade-in level at mid-fade
    ["linear", 0.5, 0.5],
    ["equalPower", Math.SQRT1_2, Math.SQRT1_2],
    ["sCurve", 0.5, 0.5],
    ["invSCurve", 0.5, 0.5],
    ["log2", 0.25, 0.75],
    ["exp2", 0.75, 0.25],
    ["log3", 0.125, 0.875],
    ["exp1", 1 - Math.pow(0.5, 1.41), Math.pow(0.5, 1.41)],
  ];
  it.each(MID)("%s: the levels at mid-fade on the audio clock", async (shape, outMid, inMid) => {
    await kit.boot({ "a.wav.meta.json": meta({ tempo: { bpm: 120, meter: "4/4" } }), "s.playlist.json": SWITCH([sample("a.wav"), sample("b.wav")], { onChange: { when: "beat", how: "crossfade", length: { ms: 400 }, shapeOut: shape, shapeIn: shape } }) });
    fake.durations.set("a.wav", 8);
    fake.durations.set("b.wav", 8);
    const h = Audio.play("s.playlist.json");
    at(1.1);
    h.setParameter("Surface", "Stone");
    at(1.4); // the next beat is at 1.5
    expect(playsOf("b.wav")).toEqual([1.5]);
    const start = 1.5;
    expect(fadeLevelAt(voiceOf("a.wav"), start + 0.2, 1)).toBeCloseTo(outMid, 6);
    expect(fadeLevelAt(voiceOf("b.wav"), start + 0.2, 0)).toBeCloseTo(inMid, 6);
    expect(fadeLevelAt(voiceOf("a.wav"), start + 0.4, 1)).toBeCloseTo(0, 9);
    expect(fadeLevelAt(voiceOf("b.wav"), start + 0.4, 0)).toBeCloseTo(1, 9);
  });

  it("a continuous Queue's overlap uses its shape", async () => {
    await kit.boot({ "q.playlist.json": pla("queue", [sample("a.wav"), sample("b.wav")], { queue: { pick: "roundRobin", avoidRepeat: 0, continuous: { gapMs: -500, shape: "linear" } } }) });
    fake.durations.set("a.wav", 2);
    fake.durations.set("b.wav", 2);
    Audio.play("q.playlist.json");
    at(1.3);
    expect(fadesOf(voiceOf("a.wav"))).toContainEqual({ kind: "fadeShaped", to: 0, seconds: 0.5, law: "linear", at: 1.5, stopAtEnd: true });
    expect(fadesOf(voiceOf("b.wav"))).toContainEqual({ kind: "fadeShaped", to: 1, seconds: 0.5, law: "linear", at: 1.5 });
  });
});

// --- 4. Bridge fades -----------------------------------------------------------------------------------------------

describe("Transition playlist fades", () => {
  it("the bridge fades in and out by its own fades; the sections by the rule's", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ markers: [{ id: "x", type: "exit", name: "Out", at: 0.75 }] }),
      "c.wav.meta.json": meta({ markers: [{ id: "x", type: "exit", name: "In", at: 0.4 }] }),
      "s.playlist.json": SWITCH([sample("a.wav"), sample("b.wav")], {
        rules: [{
          from: "*", to: "Stone", when: "exit", how: "transition", length: { ms: 100 }, transition: { sample: "c.wav" },
          transitionIn: { length: { ms: 0 }, shape: "linear" }, transitionOut: { length: { ms: 300 }, shape: "sCurve" },
        }],
      }),
    });
    fake.durations.set("a.wav", 2);
    fake.durations.set("c.wav", 1);
    const h = Audio.play("s.playlist.json");
    at(0.1);
    h.setParameter("Surface", "Stone");
    at(0.5);
    expect(playsOf("c.wav")).toEqual([0.75]);
    expect(fadesOf(voiceOf("c.wav"))).toEqual([]); // fade in 0: it enters at full level
    expect(fadesOf(voiceOf("a.wav"))).toContainEqual({ kind: "fadeShaped", to: 0, seconds: 0.1, law: "equalPowerOut", stopAtEnd: true, at: 0.75 });
    at(0.9);
    expect(playsOf("b.wav")).toEqual([1.15]);
    expect(fadesOf(voiceOf("c.wav"))).toContainEqual({ kind: "fadeShaped", to: 0, seconds: 0.3, law: "sCurve", stopAtEnd: true, at: 1.15 });
    expect(fadesOf(voiceOf("b.wav"))).toContainEqual({ kind: "fadeShaped", to: 1, seconds: 0.1, law: "equalPowerIn", at: 1.15 });
  });
});

// --- 2. Tails ------------------------------------------------------------------------------------------------------

/** A tempo-120 sequence over `clip` (`len` s) with markers. */
const SEQ = (clip: string, len: number, markers: unknown[], loops: unknown[] = [], length = len) => ({
  type: "sequence", entries: [],
  sequence: { length, tempo: { bpm: 120, meter: "4/4" }, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", sample: clip, at: 0, length: len, sync: true }] }], markers, loops },
});

describe("Post-exit tails", () => {
  it("a cut at the section's Exit marker lets the audio after it ring on while the next section starts", async () => {
    // The section's music ends at its Exit marker (4 s); its last 2 s are the tail (a cymbal ringing out).
    const explore = SEQ("a.wav", 6, [{ id: "x", name: "exit", at: 4, type: "exit" }], [], 6);
    await kit.boot({ "s.playlist.json": SWITCH([{ embedded: explore }, sample("b.wav")], { onChange: { when: "exit", how: "cut", length: { ms: 0 } } }) });
    fake.durations.set("a.wav", 6);
    fake.durations.set("b.wav", 8);
    const h = Audio.play("s.playlist.json");
    at(1);
    h.setParameter("Surface", "Stone");
    at(3.9);
    expect(playsOf("b.wav")).toEqual([4]);
    const a = voiceOf("a.wav");
    // Not cut at the hand-over: no fade or stop lands at 4; the voice is still sounding after the next section starts.
    expect(fadesOf(a).filter((f) => f.at !== undefined && f.at <= 4.0001)).toEqual([]);
    at(5);
    expect(a.playing).toBe(true);
    expect(h.playing).toBe(true);
  });

  it("tail: false cuts at the hand-over as before", async () => {
    const explore = SEQ("a.wav", 6, [{ id: "x", name: "exit", at: 4, type: "exit" }], [], 6);
    await kit.boot({ "s.playlist.json": SWITCH([{ embedded: explore }, sample("b.wav")], { onChange: { when: "exit", how: "cut", length: { ms: 0 }, tail: false } }) });
    fake.durations.set("a.wav", 6);
    const h = Audio.play("s.playlist.json");
    at(1);
    h.setParameter("Surface", "Stone");
    at(3.9);
    expect(fadesOf(voiceOf("a.wav"))).toContainEqual({ kind: "fadeShaped", to: 0, seconds: 0.005, law: "linear", at: 4, stopAtEnd: true });
  });

  it("a sample section rings out past its Exit marker; its held loop is let go into the tail", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ tempo: { bpm: 120, meter: "4/4" }, markers: [{ id: "x", type: "exit", name: "Out", at: 2 }], loops: [{ id: "l", start: 0, end: 2, active: "held" }] }),
      "s.playlist.json": SWITCH([sample("a.wav"), sample("b.wav")], { onChange: { when: "exit", how: "cut", length: { ms: 0 } } }),
    });
    fake.durations.set("a.wav", 3);
    const h = Audio.play("s.playlist.json");
    at(0.5);
    h.setParameter("Surface", "Stone");
    at(1.9);
    expect(playsOf("b.wav")).toEqual([2]);
    const a = voiceOf("a.wav");
    expect(a.stopped).toBe(false);
    expect(a.events).toContainEqual({ kind: "loop", start: 0, end: 2, looping: false }); // key-off: the held loop exits
  });

  it("a loop's wrap rings the audio from the loop's end to the next Exit marker over the next pass", async () => {
    // music-loop's shape: a 6 s body, the loop over 0..4, an Exit marker at 6: 2 s of tail at each wrap.
    await kit.boot({ "m.playlist.json": pla("sequence", [], SEQ("a.wav", 6, [{ id: "x", name: "exit", at: 6, type: "exit" }], [{ id: "l", start: 0, end: 4, tail: true }]) as never) });
    fake.durations.set("a.wav", 6);
    Audio.play("m.playlist.json");
    at(3.9);
    expect(playsOf("a.wav")).toEqual([0, 4]);
    const first = voiceOf("a.wav", 0);
    // The first pass isn't spliced off at the wrap: it rings to 6 (4 + the 2 s tail) while the second pass plays.
    expect(fadesOf(first)).toEqual([{ kind: "fadeShaped", to: 0, seconds: 0.005, law: "linear", at: 6, stopAtEnd: true }]);
  });

  it("a loop without tail splices at the wrap as before", async () => {
    await kit.boot({ "m.playlist.json": pla("sequence", [], SEQ("a.wav", 6, [{ id: "x", name: "exit", at: 6, type: "exit" }], [{ id: "l", start: 0, end: 4 }]) as never) });
    fake.durations.set("a.wav", 6);
    Audio.play("m.playlist.json");
    at(3.9);
    expect(fadesOf(voiceOf("a.wav", 0))).toEqual([{ kind: "fadeShaped", to: 0, seconds: 0.002, law: "linear", at: 4, stopAtEnd: true }]);
  });

  it("pre-entry: an Entry marker lands on the boundary, the audio before it starting early", async () => {
    const combat = SEQ("b.wav", 4, [{ id: "e", name: "entry", at: 0.5, type: "entry" }]);
    const explore = SEQ("a.wav", 8, []);
    await kit.boot({ "s.playlist.json": SWITCH([{ embedded: explore }, { embedded: combat }], { onChange: { when: "bar", how: "cut", length: { ms: 0 } } }) });
    fake.durations.set("a.wav", 8);
    fake.durations.set("b.wav", 4);
    const h = Audio.play("s.playlist.json");
    at(0.3);
    h.setParameter("Surface", "Stone");
    at(1.5);
    expect(playsOf("b.wav")).toEqual([1.5]); // the bar is at 2: the half-second pickup starts at 1.5
    expect(fadesOf(voiceOf("a.wav"))).toContainEqual({ kind: "fadeShaped", to: 0, seconds: 0.005, law: "linear", at: 2, stopAtEnd: true });
  });
});

// --- 5. Beat-quantised automation ----------------------------------------------------------------------------------

describe("Beat-quantised automation", () => {
  const INTENSITY = [{ name: "Intensity", min: 0, max: 1, default: 0 }];
  const song = (quantize: unknown) => pla("sequence", [], {
    parameters: INTENSITY,
    sequence: {
      length: 16, tempo: { bpm: 120, meter: "4/4" },
      tracks: [{
        id: "t", kind: "audio",
        automation: [{ id: "a", target: "volume", input: { parameter: "Intensity" }, curve: [[0, -20], [1, 0]], quantize }],
        clips: [{ id: "c", sample: "a.wav", at: 0, length: 16, sync: true }],
      }],
    },
  });
  const ramps = (v: FakeVoice) => v.events.filter((e) => e.kind === "paramsShaped");

  it.each([["beat", 0.5], ["bar", 2], [{ beats: 2 }, 1]] as const)("%j: a change takes effect exactly on the next boundary, not before", async (quantize, boundary) => {
    await kit.boot({ "m.playlist.json": song(quantize) });
    fake.durations.set("a.wav", 16);
    const h = Audio.play("m.playlist.json");
    at(0.05);
    const v = voiceOf("a.wav");
    expect(ramps(v)).toEqual([{ kind: "paramsShaped", gain: 0.1, seconds: 0, at: 0 }]);
    at(0.1);
    h.setParameter("Intensity", 1);
    at(0.12);
    // Nothing moves yet unless that boundary is already within the scheduling lookahead; when it moves, it is stamped there.
    for (let t = 0.15; t < boundary; t += 0.05) at(t);
    const moved = ramps(v).slice(1);
    expect(moved).toEqual([{ kind: "paramsShaped", gain: 1, seconds: 0.02, at: boundary }]);
  });

  it("without quantize the lane follows the parameter continuously (a core binding, no stamped ramp)", async () => {
    await kit.boot({ "m.playlist.json": song(undefined) });
    fake.durations.set("a.wav", 16);
    const h = Audio.play("m.playlist.json");
    at(0.1);
    h.setParameter("Intensity", 1);
    at(0.2);
    expect(ramps(voiceOf("a.wav"))).toEqual([]);
  });

  it("the latest change before the boundary's ramp is stamped wins", async () => {
    await kit.boot({ "m.playlist.json": song("bar") });
    fake.durations.set("a.wav", 16);
    const h = Audio.play("m.playlist.json");
    at(0.1);
    h.setParameter("Intensity", 1);
    at(0.5);
    h.setParameter("Intensity", 0.5);
    for (let t = 0.6; t < 2; t += 0.1) at(t);
    expect(ramps(voiceOf("a.wav")).slice(1)).toEqual([{ kind: "paramsShaped", gain: expect.closeTo(0.316228, 5), seconds: 0.02, at: 2 }]);
  });
});

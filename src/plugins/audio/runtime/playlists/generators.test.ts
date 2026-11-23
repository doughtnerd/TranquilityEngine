// ADR 0346 (G3): generator entries and sequence generator clips in the playlist runtime, through `Audio.play` on the fake
// backend: the request carries the resolved generator (kind, wire-order values, noise seed), drawn from the World's
// seeded generator in pick order; `vary` and silence lengths are drawn; endless and `untilStopped` generators key off on
// release; sequence clips start at their times and key off at their end; a take's reseed replays the same values; a
// backend without generators plays nothing, with one warning per kind.
import { describe, expect, it } from "vitest";
import { Audio } from "../Audio";
import type { GeneratorSource, PlayRequest } from "../backend";
import { generatorParamIndex, generatorSpec, generatorWireValues } from "../../../../engine/audio/generators/catalogue";
import { blipPreset } from "../../../../engine/audio/generators/blipPresets";
import { activeWorldRandomState, reseedActiveWorld } from "../capture/takeSeed";
import { eventKit, pla, pl, embed } from "./testKit";

const kit = eventKit();

/** A generator entry (embedded): `gen({ kind: "oscillator", params: { frequency: 300 } })`. */
const gen = (generator: unknown, extra: Record<string, unknown> = {}) => ({ generator, ...extra });

/** The generator plays recorded since `from`. */
function genPlays(from = 0): (PlayRequest & { generator: GeneratorSource })[] {
  return kit.fake.plays.slice(from).filter((p): p is PlayRequest & { generator: GeneratorSource } => p.generator !== undefined);
}

/** The value of parameter `name` in a recorded generator play. */
const valueOf = (g: GeneratorSource, name: string): number => g.values[generatorParamIndex(g.kind, name)]!;

describe("generator entries (ADR 0346 §5)", () => {
  it("a Clip with a generator entry plays one generator voice with the resolved parameters", async () => {
    await kit.boot({ "g.playlist.json": pla("clip", [gen({ kind: "oscillator", params: { frequency: 300, waveform: "saw" }, seed: 99 })]) });
    Audio.play("g.playlist.json");
    const plays = genPlays();
    expect(plays).toHaveLength(1);
    const g = plays[0]!.generator;
    expect(g.kind).toBe("oscillator");
    expect(g.seed).toBe(99);
    expect(g.values).toEqual(generatorWireValues("oscillator", { frequency: 300, waveform: 2 }));
    expect(g.values).toHaveLength(generatorSpec("oscillator").params.length);
  });

  it("plays a *.generator.json through Audio.play and as a linked generator entry", async () => {
    const coin = { format: "myco.generator@1", kind: "blip", preset: "coin", seed: 5, params: blipPreset("coin", 5) };
    await kit.boot({ "ui/coin.generator.json": coin, "l.playlist.json": pla("clip", [gen("ui/coin.generator.json")]) });
    Audio.play("ui/coin.generator.json");
    Audio.play("l.playlist.json");
    const plays = genPlays();
    expect(plays).toHaveLength(2);
    for (const p of plays) {
      expect(p.path).toBe("ui/coin.generator.json");
      expect(p.generator.kind).toBe("blip");
      expect(p.generator.values).toEqual(generatorWireValues("blip", blipPreset("coin", 5)));
    }
  });

  it("draws the noise seed from the World's seeded generator, the same for the same project seed", async () => {
    const assets = { "n.playlist.json": pla("clip", [gen({ kind: "oscillator", params: { waveform: "noise" } })]) };
    const run = async (seed: number): Promise<number[]> => {
      await kit.boot(assets, { seed });
      const from = kit.fake.plays.length;
      for (let i = 0; i < 4; i++) Audio.play("n.playlist.json");
      return genPlays(from).map((p) => p.generator.seed);
    };
    const a = await run(7);
    const b = await run(7);
    const c = await run(8);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(4);
    expect(c).not.toEqual(a);
    for (const s of a) expect(s).not.toBe(0);
  });

  it("applies vary within ±vary × 5 % of each numeric parameter's range, leaving choices", async () => {
    const params = { waveform: "triangle", frequency: 1000, level: -20, attack: 100, sustain: 50 };
    await kit.boot({ "v.playlist.json": pla("clip", [gen({ kind: "oscillator", params, seed: 1, vary: 1 })]) });
    for (let i = 0; i < 40; i++) Audio.play("v.playlist.json");
    const base = generatorWireValues("oscillator", { ...params, waveform: 3 });
    const spec = generatorSpec("oscillator").params;
    let moved = 0;
    for (const p of genPlays()) {
      spec.forEach((q, k) => {
        const v = p.generator.values[k]!;
        if (q.choices || q.name === "length") { expect(v).toBe(base[k]); return; }
        if (q.scale === "log") {
          const span = Math.log(q.max / q.min) * 0.05;
          expect(Math.abs(Math.log(v / base[k]!))).toBeLessThanOrEqual(span + 1e-9);
        } else expect(Math.abs(v - base[k]!)).toBeLessThanOrEqual((q.max - q.min) * 0.05 + 1e-9);
        if (v !== base[k]) moved++;
      });
    }
    expect(moved).toBeGreaterThan(40);
  });

  it("draws a silence's length within ± lengthRandom and sends lengthRandom as 0", async () => {
    await kit.boot({ "s.playlist.json": pla("clip", [gen({ kind: "silence", params: { length: 2, lengthRandom: 0.5 } })]) });
    for (let i = 0; i < 12; i++) Audio.play("s.playlist.json");
    const lengths = genPlays().map((p) => {
      expect(valueOf(p.generator, "lengthRandom")).toBe(0);
      return valueOf(p.generator, "length");
    });
    for (const l of lengths) {
      expect(l).toBeGreaterThanOrEqual(1.5);
      expect(l).toBeLessThanOrEqual(2.5);
    }
    expect(new Set(lengths).size).toBeGreaterThan(6);
  });

  it("an untilStopped playlist plays its generator endless (the loop flag) and its release keys it off", async () => {
    await kit.boot({ "u.playlist.json": pla("clip", [gen({ kind: "blip", params: {}, seed: 3 })], { playback: { plays: "untilStopped" } }) });
    const h = Audio.play("u.playlist.json");
    const v = kit.fake.voices.at(-1)!;
    expect(v.request.loop).toBe(true);
    expect(v.events.some((e) => e.kind === "loop")).toBe(false);
    h.release();
    expect(v.events.filter((e) => e.kind === "loop")).toEqual([{ kind: "loop", start: 0, end: 0, looping: false }]);
  });

  it("an endless oscillator (length 0) in a one-shot playlist sounds until released; one with a length doesn't loop", async () => {
    await kit.boot({
      "e.playlist.json": pla("clip", [gen({ kind: "oscillator", params: { length: 0 } })]),
      "f.playlist.json": pla("clip", [gen({ kind: "oscillator", params: { length: 1.5 } })]),
    });
    const e = Audio.play("e.playlist.json");
    const ev = kit.fake.voices.at(-1)!;
    expect(ev.request.loop).toBe(false);
    expect(e.playing).toBe(true);
    e.release();
    expect(ev.events.filter((x) => x.kind === "loop")).toEqual([{ kind: "loop", start: 0, end: 0, looping: false }]);
    const f = Audio.play("f.playlist.json");
    const fv = kit.fake.voices.at(-1)!;
    expect(fv.request.loop).toBe(false);
    expect(valueOf(fv.request.generator!, "length")).toBe(1.5);
    f.release();
    expect(fv.events.some((x) => x.kind === "loop")).toBe(false);
  });

  it("a continuous Queue of blips starts the next one where the blip's envelope ends", async () => {
    // sfxr: each stage lasts p² × 100,000 + 1 ticks at 44.1 kHz.
    const params = { attack: 0.1, sustain: 0.2, decay: 0.3 };
    const seconds = (0.1 ** 2 * 1e5 + 1 + Math.floor(0.2 ** 2 * 1e5) + 1 + Math.floor(0.3 ** 2 * 1e5) + 1) / 44_100;
    await kit.boot({ "q.playlist.json": pla("queue", [embed(pl("clip", [gen({ kind: "blip", params, seed: 1 })]))], { queue: { pick: "sequential", continuous: { gapMs: 0 } } }) });
    kit.fake.lookahead = 0.05;
    Audio.play("q.playlist.json");
    for (let i = 0; i < 60; i++) {
      kit.fake.advance(1 / 60);
      kit.frame();
    }
    const plays = genPlays();
    expect(plays.length).toBeGreaterThanOrEqual(2);
    const first = plays[0]!.at ?? 0.05;
    expect(plays[1]!.at).toBeCloseTo(first + seconds, 6);
  });

  it("a backend without generators plays nothing, with one warning per kind", async () => {
    await kit.boot({
      "a.playlist.json": pla("clip", [gen({ kind: "oscillator", params: {} })]),
      "b.playlist.json": pla("clip", [gen({ kind: "synth", params: {} })]),
    });
    const fake = kit.fake as { generators?: unknown };
    const had = fake.generators;
    fake.generators = undefined;
    try {
      const warn = console.warn as unknown as { mock: { calls: unknown[][] } };
      const before = warn.mock.calls.length;
      for (let i = 0; i < 3; i++) { Audio.play("a.playlist.json"); Audio.play("b.playlist.json"); }
      expect(genPlays()).toHaveLength(0);
      const said = warn.mock.calls.slice(before).map((c) => String(c[0])).filter((m) => m.includes("generators need the audio core"));
      expect(said).toHaveLength(2);
      expect(said.some((m) => m.includes("oscillator"))).toBe(true);
      expect(said.some((m) => m.includes("synth"))).toBe(true);
    } finally {
      fake.generators = had;
    }
  });
});

describe("sequence generator clips (ADR 0346 §3 'Release')", () => {
  it("start at their times and key off at the clip's end through the generator's length", async () => {
    const seq = {
      length: 4, tempo: null, loops: [], markers: [],
      tracks: [{
        id: "t1", name: "Tones", kind: "audio", clips: [
          { id: "c1", at: 0.5, length: 1, generator: { kind: "oscillator", params: { frequency: 220, length: 0 } } },
          { id: "c2", at: 2, length: 0.25, generator: { kind: "synth", params: { frequency: 110, length: 10 } } },
        ],
      }],
    };
    await kit.boot({ "s.playlist.json": pla("sequence", [], { sequence: seq }) });
    kit.fake.lookahead = 0.05;
    Audio.play("s.playlist.json");
    for (let i = 0; i < 200; i++) {
      kit.fake.advance(1 / 60);
      kit.frame();
    }
    const plays = genPlays();
    expect(plays.map((p) => p.generator.kind)).toEqual(["oscillator", "synth"]);
    const start = plays[0]!.at! - 0.5;
    expect(plays[1]!.at! - start).toBeCloseTo(2, 6);
    expect(valueOf(plays[0]!.generator, "frequency")).toBe(220);
    expect(valueOf(plays[0]!.generator, "length")).toBeCloseTo(1, 6);
    expect(valueOf(plays[1]!.generator, "length")).toBeCloseTo(0.25, 6);
    // Not cut at the clip's end: the release rings past it.
    for (const v of kit.fake.voices) expect(v.events.some((e) => e.kind === "stop" || e.kind === "fadeShaped")).toBe(false);
  });
});

describe("takes (ADR 0334, 0346 §7)", () => {
  it("a reseed from the take's recorded state replays the same generator values", async () => {
    const body = { kind: "blip", params: blipPreset("laser", 11), seed: null, vary: 0.6 };
    await kit.boot({
      "t.playlist.json": pla("queue", [embed(pl("clip", [gen(body)])), embed(pl("clip", [gen({ kind: "silence", params: { length: 1, lengthRandom: 0.8 } })]))], { queue: { pick: "random", avoidRepeat: 0 } }),
    });
    const run = (n: number): GeneratorSource[] => {
      const from = kit.fake.plays.length;
      for (let i = 0; i < n; i++) Audio.play("t.playlist.json");
      return genPlays(from).map((p) => p.generator);
    };
    run(3); // the game ran a while before the take began
    const state = activeWorldRandomState()!;
    const recorded = run(10);
    run(4);
    expect(reseedActiveWorld(state)).toBe(true);
    expect(run(10)).toEqual(recorded);
  });
});

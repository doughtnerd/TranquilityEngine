// ADR 0346 (G3) end to end on the real wasm (the loopback host, the production assembly on the page mixer): a generator
// playlist sounds at its frequency (and a playlist's pitch transposes it), what reaches the core is a PLAY of the kind's
// reserved clip id with a GEN of every value behind it and a `gen:` curve as an AUTOMATE target-5 binding in log2, a
// silence stays virtual while a tone is mixed and `Audio.debug()` names their kinds, and a blip preset lasts as long as
// sfxr's envelope says.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { setAudioBackend } from "../backend";
import { Audio } from "../index";
import { closeLoopbackAudio, endAudioSession, loopbackAudio } from "../testing";
import { GEN_CLIP_ID_FIRST, Op, PLAY_FLAGS_MIXED, readAutomate, readGen, readPlay } from "../wire.generated";
import { generatorTarget } from "../core/commandWriter";
import { blipPreset } from "../../../../engine/audio/generators/blipPresets";
import { generatorKindIndex, generatorParamIndex, generatorWireValues } from "../../../../engine/audio/generators/catalogue";

const RATE = 48_000;

afterEach(async () => {
  await closeLoopbackAudio();
  endAudioSession();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

/** An Engine on `assets` with the core on the loopback (page mixer); null when the wasm can't run here. */
async function rig(assets: Record<string, unknown>) {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, ...assets }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }], seed: 7 } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  endAudioSession();
  const loop = await loopbackAudio({ mixer: "page", preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 } });
  if (!loop) return null;
  const out: number[] = [];
  const step = async (frames: number) => {
    const o = await loop.step(frames);
    for (const s of o.left) out.push(s);
  };
  return { loop, out, step };
}

/** The frequency of `x` by its rising zero crossings (linearly interpolated), Hz. */
function frequencyOf(x: readonly number[]): number {
  const at: number[] = [];
  for (let k = 1; k < x.length; k++) if (x[k - 1]! < 0 && x[k]! >= 0) at.push(k - 1 + -x[k - 1]! / (x[k]! - x[k - 1]!));
  return ((at.length - 1) * RATE) / (at.at(-1)! - at[0]!);
}

/** The first and last sample index of `x` above `floor` in magnitude, or null when all are below. */
function span(x: readonly number[], floor: number): [number, number] | null {
  let first = -1, last = -1;
  for (let k = 0; k < x.length; k++) if (Math.abs(x[k]!) > floor) { if (first < 0) first = k; last = k; }
  return first < 0 ? null : [first, last];
}

describe("generator voices in the core (ADR 0346, loopback)", () => {
  it("a generator playlist sounds at its frequency, and the playlist's pitch transposes it", { timeout: 30_000 }, async (ctx) => {
    const sine = { kind: "oscillator", params: { waveform: "sine", frequency: 440, level: -6 } };
    const r = await rig({
      "a.playlist.json": { format: "myco.playlist@1", type: "clip", playback: { plays: "untilStopped" }, entries: [{ generator: sine }] },
      "b.playlist.json": { format: "myco.playlist@1", type: "clip", pitch: 12, playback: { plays: "untilStopped" }, entries: [{ generator: sine }] },
    });
    if (!r) return ctx.skip();
    const a = Audio.play("a.playlist.json");
    expect(a.playing).toBe(true);
    await r.step(60);
    const tone = r.out.slice(-RATE / 2);
    expect(Math.max(...tone.map(Math.abs))).toBeGreaterThan(0.1);
    expect(frequencyOf(tone)).toBeCloseTo(440, 0);
    a.stop(0);
    await r.step(10);
    const b = Audio.play("b.playlist.json");
    await r.step(60);
    expect(frequencyOf(r.out.slice(-RATE / 2))).toBeCloseTo(880, 0);
    // Released: the amp envelope's 10 ms release, then the voice ends and the instance with it.
    b.release();
    await r.step(20);
    expect(Math.max(...r.out.slice(-RATE / 10).map(Math.abs))).toBeLessThan(1e-4);
    expect(b.playing).toBe(false);
  });

  it("sends PLAY of the reserved id, GEN of every value and a gen: curve as a log2 target-5 binding; a silence stays virtual", { timeout: 30_000 }, async (ctx) => {
    const r = await rig({
      "t.playlist.json": {
        format: "myco.playlist@1", type: "layer", playback: { plays: "untilStopped" }, parameters: [{ name: "Charge", min: 0, max: 1, default: 0.5, seekSpeed: 0 }],
        entries: [
          { embedded: { type: "clip", entries: [{ generator: { kind: "synth", params: { cutoff: 800 }, seed: 42 } }] }, curves: { "gen:cutoff": { input: { parameter: "Charge" }, curve: [[0, 200], [1, 3200]] } } },
          { embedded: { type: "clip", entries: [{ generator: { kind: "silence", params: { length: 30 } } }] } },
        ],
      },
    });
    if (!r) return ctx.skip();
    const watch = r.loop.watch();
    Audio.play("t.playlist.json");
    await r.step(4);
    const records = watch.takeRecords();
    const plays = records.filter((x) => x.opcode === Op.PLAY).map((x) => ({ x, p: readPlay(x.view, x.off) }));
    const synth = plays.find(({ p }) => p.clip === GEN_CLIP_ID_FIRST + generatorKindIndex("synth"))!;
    const silence = plays.find(({ p }) => p.clip === GEN_CLIP_ID_FIRST + generatorKindIndex("silence"))!;
    expect(synth).toBeDefined();
    expect(silence).toBeDefined();
    expect(synth.p.flags & PLAY_FLAGS_MIXED).not.toBe(0);
    expect(silence.p.flags & PLAY_FLAGS_MIXED).toBe(0);
    // The GEN right behind each PLAY, at its frame: every value of the kind, and a non-zero seed.
    const gens = records.filter((x) => x.opcode === Op.GEN);
    const synthGen = gens.find((g) => g.voiceId === synth.x.voiceId)!;
    const g = readGen(synthGen.view, synthGen.off);
    expect(synthGen.frame).toBe(synth.x.frame);
    expect(records.indexOf(synthGen)).toBeGreaterThan(records.indexOf(synth.x));
    expect(g.seed).toBe(42);
    expect(Array.from(g.values)).toEqual(generatorWireValues("synth", { cutoff: 800 }).map(Math.fround));
    const silenceGen = readGen(gens.find((x) => x.voiceId === silence.x.voiceId)!.view, gens.find((x) => x.voiceId === silence.x.voiceId)!.off);
    expect(silenceGen.seed).not.toBe(0);
    // The gen:cutoff curve: an AUTOMATE binding of target 5, the cutoff's index, in log2 (the cutoff is a log parameter).
    const automates = records.filter((x) => x.opcode === Op.AUTOMATE && x.voiceId === synth.x.voiceId).map((x) => readAutomate(x.view, x.off));
    const targets = automates.flatMap((a) => a.bindings.map((b) => b.target));
    expect(targets).toContain(generatorTarget(generatorParamIndex("synth", "cutoff"), true));
    // Audio.debug(): the voices named and their kinds shown; the silence virtual, the synth mixed.
    const rows = Audio.debug().voices;
    const synthRow = rows.find((v) => v.generator === "synth")!;
    const silenceRow = rows.find((v) => v.generator === "silence")!;
    expect(synthRow.state).toBe("playing");
    expect(silenceRow.state).toBe("virtual");
    expect(synthRow.clip).toContain("#synth");
    await r.step(30);
    expect(Audio.debug().voices.find((v) => v.generator === "silence")!.state).toBe("virtual");
  });

  it("a blip preset lasts as long as sfxr's envelope (its catalogue length) and then ends its playlist", { timeout: 30_000 }, async (ctx) => {
    const params = blipPreset("blip", 3);
    const r = await rig({ "ui/blip.generator.json": { format: "myco.generator@1", kind: "blip", preset: "blip", seed: 3, params } });
    if (!r) return ctx.skip();
    // sfxr: attack, sustain and decay each last p² × 100,000 + 1 ticks at 44.1 kHz.
    const ticks = (p: number) => Math.floor(Math.fround(Math.fround(p * p) * 100_000)) + 1;
    const seconds = (ticks(params.attack!) + ticks(params.sustain!) + ticks(params.decay!)) / 44_100;
    expect(seconds).toBeGreaterThan(0.03);
    const h = Audio.play("ui/blip.generator.json");
    expect(h.playing).toBe(true);
    await r.step(Math.ceil((seconds + 0.3) / 0.0107) + 10);
    const s = span(r.out, 1e-4)!;
    expect(s).not.toBeNull();
    const heard = (s[1] - s[0]) / RATE;
    // The decay falls linearly to 0 (its last samples sit under the floor) and the phaser adds up to 2.9 ms.
    expect(Math.abs(heard - seconds)).toBeLessThan(0.01);
    expect(h.playing).toBe(false);
  });
});

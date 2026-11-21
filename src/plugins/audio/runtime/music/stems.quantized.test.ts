// ADR 0166 R6: quantised automation on stems. Fake backend (the stamp and level asserted) and the loopback host (the
// real core: a stem enters on the bar line, sample-exact). 120 bpm 4/4: a beat is 0.5 s, a bar 2 s.
import { afterEach, describe, expect, it } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeVoice, endAudioSession, loopbackAudio, closeLoopbackAudio, musicFrameAt } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { AutoTarget, continuousBindings, evaluateQuantized, QUANTIZED_RAMP_SECONDS, TsAutomation, type Binding } from "../events/automation";
import { parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import { createMusicPlayer, type MusicFrame } from "./musicSystem";
import type { SegmentRun, StemRun } from "./segmentRun";
import { serveMusicClips } from "./testing/clips";
import { quantizedRamp, setAudibleStems, tickStems, type StampedRamp } from "./stems";
import { commitStart } from "./musicPlayer";

const RATE = 48_000;
const QUANTUM_SAMPLES = 128;

function setup() {
  const b = makeFakeBackend();
  setAudioBackend(b);
  serveMusicClips(b, () => ({ frames: 120 * RATE, rate: RATE, channels: 2, gapless: true }), { stream: true });
  const node = parseSegmentNode({ type: "segment", id: "s", tracks: [{ name: "drums", clip: "a.ogg" }, { name: "bass", clip: "b.ogg" }] }, "test", { problems: [], ids: new Set() }) as SegmentNode;
  const inst = { group: 7, world: 1, path: "m.audioevent", asset: { bus: "Music", priority: 200, volume: 1 } } as unknown as EventInstance;
  const player = createMusicPlayer(inst, node);
  const ramps: { track: string; r: StampedRamp }[] = [];
  const stems: StemRun[] = node.tracks.map((t, k) => {
    const voice = b.play({ path: t.clip, url: t.clip, loop: false, stream: true, bus: "Music" }) as FakeVoice;
    // The fake voice records `paramsShaped` in its own events; this test wants every stem's ramps in one list.
    voice.paramsShaped = (r) => ramps.push({ track: t.name, r: r as StampedRamp });
    return { track: t.name, alternative: 0, clip: t.clip, streamed: true, voice, primed: true, k } as unknown as StemRun;
  });
  const run = { node, player, state: "playing", group: 1, stems, startAt: 1, startFrame: 0, loopsDone: 0, prime: null } as unknown as SegmentRun;
  commitStart(player, run, 1);
  const frame = (now: number) => musicFrameAt(b, now);
  return { b, player, run, stems, ramps, frame };
}

afterEach(() => {
  endAudioSession();
  setAudioBackend(null);
});

afterEach(closeLoopbackAudio);

describe("quantizedRamp (ADR 0166 R6)", () => {
  it("stamps an in-voice ramp at the next bar or beat line, on that stem only", () => {
    const { player, ramps, frame } = setup();
    // Group heard from 1.0 s at file 0: bars at 1, 3, 5; beats every 0.5 s.
    expect(quantizedRamp(player, "bass", 1, "bar", QUANTIZED_RAMP_SECONDS, frame(1.3))).toBeCloseTo(3, 9);
    expect(quantizedRamp(player, "drums", 0.5, "beat", 0.02, frame(1.3))).toBeCloseTo(1.5, 9);
    expect(ramps).toEqual([
      { track: "bass", r: { gain: 1, seconds: 0.02, law: "linear", at: 3 } },
      { track: "drums", r: { gain: 0.5, seconds: 0.02, law: "linear", at: 1.5 } },
    ]);
  });

  it("a point nearer than Audio.horizon is skipped for the next one", () => {
    const { b, player, frame } = setup();
    b.lookahead = 1.65; // the horizon at 2.95 in the frame at 1.3
    expect(quantizedRamp(player, "bass", 1, "bar", 0.02, frame(1.3))).toBeCloseTo(3, 9);
    b.lookahead = 1.71; // at 3.01: past the bar line at 3
    expect(quantizedRamp(player, "bass", 1, "bar", 0.02, frame(1.3))).toBeCloseTo(5, 9);
  });

  it("is NaN when the stem or the playing run is missing", () => {
    const { player, run, frame } = setup();
    expect(quantizedRamp(player, "nope", 1, "bar", 0.02, frame(1.3))).toBeNaN();
    run.state = "ending";
    expect(quantizedRamp(player, "bass", 1, "bar", 0.02, frame(1.3))).toBeNaN();
  });

  it("a ramp to 0 sets silentAt so the ring is released after the ramp and the voice's end", () => {
    const { player, run, stems, frame } = setup();
    const at = quantizedRamp(player, "bass", 0, "bar", 0.02, frame(1.3));
    (stems[1]!.voice as FakeVoice).end();
    tickStems(player, frame(at - 0.01));
    expect(run.stems[1]!.voice).not.toBeNull();
    tickStems(player, frame(at + 0.03));
    expect(run.stems[1]!.voice).toBeNull();
  });

  it("solo composes with a waiting ramp: both land on auto x solo, nothing on fade", () => {
    const { player, ramps, frame, stems } = setup();
    tickStems(player, frame(1.3));
    quantizedRamp(player, "bass", 0.5, "bar", 0.02, frame(1.3));
    ramps.length = 0;
    setAudibleStems(player, ["drums"], null, 0.1);
    // bass: now 1 x 0 = 0 (asap), then the waiting ramp re-stamped at 0.5 x 0 = 0; drums: 1 asap, 1 x 1 waiting none.
    expect(ramps.filter((x) => x.track === "bass").map((x) => [x.r.gain, x.r.at])).toEqual([[0, undefined], [0, 3]]);
    expect(ramps.filter((x) => x.track === "drums").map((x) => [x.r.gain, x.r.at])).toEqual([[1, undefined]]);
    expect((stems[1]!.voice as FakeVoice).events.some((e) => e.kind === "fade")).toBe(false);
  });

  it("the ramp is stamped once when asked; the line only makes it the stem's level (nothing is re-sent)", () => {
    const { player, stems, ramps, frame } = setup();
    const at = quantizedRamp(player, "bass", 0.25, "bar", 0.02, frame(1.3));
    expect(ramps).toEqual([{ track: "bass", r: { gain: 0.25, seconds: 0.02, law: "linear", at } }]);
    tickStems(player, frame(at - 0.016));
    tickStems(player, frame(at + 0.001));
    tickStems(player, frame(at + 0.02));
    expect(ramps).toHaveLength(1);
    expect((stems[1]!.voice as FakeVoice).events.some((e) => e.kind === "fade")).toBe(false);
  });
});

describe("quantised bindings (events/automation.ts)", () => {
  const curve: [number, number][] = [[0, 0], [1, 1]];
  const q: Binding = { param: { global: true, slot: 0 }, curve: 1, target: AutoTarget.Volume, quantize: "bar" };
  const c: Binding = { param: { global: true, slot: 0 }, curve: 1, target: AutoTarget.Volume };

  it("evaluateQuantized reads only quantised bindings and names the coarsest grid", () => {
    const curves = new Map([[1, curve]]);
    expect(evaluateQuantized([c], curves, () => 0.5)).toEqual({ gain: 1, lowpass: 24000, grid: null });
    expect(evaluateQuantized([c, q, { ...q, quantize: "beat" }], curves, () => 0.5)).toMatchObject({ gain: 0.25, grid: "bar" });
    expect(continuousBindings([c, q])).toEqual([c]);
  });

  it("TsAutomation does not follow a quantised binding between grid points", () => {
    const b = makeFakeBackend();
    const v = b.play({ path: "a", url: "a", loop: false, stream: false, bus: "Music" }) as FakeVoice;
    const a = new TsAutomation();
    a.defineCurve(1, curve);
    a.setParam(0, 0, 0.5, 0);
    a.bindVoice(v, 1, [q], { volume: 1, pitch: 1 });
    a.update(0.016);
    expect(v.events.filter((e) => e.kind === "volume")).toEqual([]);
  });
});

// --- the real core: a stem enters on the bar line, sample-exact -----------------------------------------------------

describe("a quantised stem on the loopback host (ADR 0166 R6)", () => {
  it("enters on the bar line: silent through the sample before it, audible from it", async (ctx) => {
    const FRAMES = 4 * RATE;
    const dc = new Float32Array(FRAMES).fill(0.25);
    // ADR 0221: the production assembly on the loopback, with its own mixer; no limiter look-ahead (output frames are core frames).
    const loop = await loopbackAudio({ mixer: "own", preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 }, decode: () => ({ channelData: [dc] }) });
    if (!loop) return ctx.skip();
    const mixer = loop.mixer;
    const backend = loop.backend;
    // The core's frames before the rig rendered silence: `out` holds them as zeros, so an index is a frame.
    const out: number[] = new Array<number>(loop.frame).fill(0);
    const step = async (n: number) => {
      for (let i = 0; i < n; i++) {
        mixer.update(0.003);
        loop.tick(0.003);
        for (const s of loop.render(4).left) out.push(s);
        await Promise.resolve();
      }
    };
    serveMusicClips(null);
    // Load the clip with a silent voice, let the clock settle.
    backend.play({ path: "dc.wav", url: "dc.wav", loop: false, stream: false, bus: "Music", volume: 0 });
    await step(20);
    // The stem: playing, with its dry gain at 0 (the bound parameter is 0) from the start.
    const voice = backend.play({ path: "dc.wav", url: "dc.wav", loop: false, stream: false, bus: "Music", volume: 1 })!;
    // The core voice's own `paramsShaped` (G-1): a stamped gain SET_PARAMS through `musicOps`.
    expect(typeof voice.paramsShaped).toBe("function");
    voice.paramsShaped({ gain: 0, seconds: 0 });
    await step(10);

    const node = parseSegmentNode({ type: "segment", id: "s", tracks: [{ name: "bass", clip: "dc.wav" }] }, "test", { problems: [], ids: new Set() }) as SegmentNode;
    const inst = { group: 7, world: 1, path: "m.audioevent", asset: { bus: "Music", priority: 200, volume: 1 } } as unknown as EventInstance;
    const player = createMusicPlayer(inst, node);
    // Heard clock: the group began at `t0` (file 0), so bars fall at t0 + 2k seconds. Pick t0 so the next bar is ~0.15 s ahead.
    const now = backend.time;
    const t0 = now + 0.15 - 2;
    commitStart(player, { node, player, state: "playing", group: 1, stems: [{ track: "bass", alternative: 0, clip: "dc.wav", streamed: false, voice: voice as never, primed: true }], startAt: t0, startFrame: 0, loopsDone: 0, prime: null } as unknown as SegmentRun, t0);
    const f: MusicFrame = { backend, music: backend.music, now, dt: 0.003, hidden: false };
    const at = quantizedRamp(player, "bass", 1, "bar", QUANTIZED_RAMP_SECONDS, f);
    expect(at).toBeCloseTo(t0 + 2, 9);
    const planned = backend.clockMap.frameOfTime(at);
    expect(backend.clockMap.stampFor(planned)).toBe(planned);
    const before = out.length;
    expect(out.slice(-QUANTUM_SAMPLES).every((s) => s === 0)).toBe(true);
    await step(40);
    expect(before).toBeGreaterThan(0);
    // Silent up to the sample before the bar line, then the ramp rises from that very sample.
    for (let i = before; i < planned; i++) expect(out[i]).toBe(0);
    expect(out[planned + 1]!).toBeGreaterThan(0);
    expect(out[planned + 3 * 48]!).toBeGreaterThan(out[planned + 1]!);
    // After the ramp (20 ms) the stem is at its full level (bus and master at unity).
    expect(out[planned + 0.03 * RATE]).toBeCloseTo(0.25, 5);
    backend.dispose();
  });
});

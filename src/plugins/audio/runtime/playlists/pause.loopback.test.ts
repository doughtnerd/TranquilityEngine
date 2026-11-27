// ADR 0362 §1 end to end on the real wasm core (the loopback host): a sequence plays a ramp clip (sample k is
// floor(k / STEP) / 32767, so the output says which clip frame plays). `handle.pause()` holds it at one heard time: the
// voice fades out over the core's 5 ms so that the fade ends exactly at the hold, then silence. `handle.resume()`
// continues it at one heard time from exactly the frame it held (sample-exact), heard from the promote's 5 ms fade-in.
// The hold and the resume times are read through the public musical clock (`handle.music.time`, which holds with it).
import { afterEach, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { setAudioBackend } from "../backend";
import { Audio } from "../index";
import { playlistHost } from "./host";
import { endAudioSession, loopbackAudio, closeLoopbackAudio } from "../testing";

const RATE = 48_000;
const STEP = 6;
const CLIP_FRAMES = 2 * RATE;
/** The core's promote, demote and pause fade: 5 ms. */
const FADE = 240;
const TOL = 1e-6;
const ramp = Float32Array.from({ length: CLIP_FRAMES }, (_, k) => Math.floor(k / STEP) / 32767);
/** The clip's value at frame `k`, through the int16 clip the worker makes. */
const clipAt = (k: number): number => Math.floor(k / STEP) / 32768;
/** The core's ramp at frame `k` of an `n`-frame ramp from `a` to `b`. */
const rampAt = (a: number, b: number, n: number, k: number): number => (k + 1 >= n ? b : a + ((b - a) * (k + 1)) / n);

afterEach(async () => {
  await closeLoopbackAudio();
  vi.restoreAllMocks();
});

function expectFrames(out: readonly number[], from: number, n: number, want: (k: number) => number, what: string): void {
  for (let k = 0; k < n; k++) {
    const got = out[from + k]!;
    if (Math.abs(got - want(k)) > TOL) expect.fail(`${what}: frame ${k} (output ${from + k}): ${got}, expected ${want(k)}`);
  }
}

it("pause holds a playback at one frame and resume continues it from exactly there (loopback)", { timeout: 30_000 }, async (ctx) => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "s.json": { format: "myco.scene@1", nodes: [] },
    "ramp.wav": "data:,",
    "m.playlist.json": {
      format: "myco.playlist@1", type: "sequence", entries: [],
      sequence: { length: 2, tempo: { bpm: 120, meter: "4/4" }, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", sample: "ramp.wav", at: 0, length: 2, sync: true }] }] },
    },
  }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }], seed: 7 } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  endAudioSession();
  const loop = await loopbackAudio({
    mixer: "page", preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 },
    decode: () => ({ channelData: [ramp] }), recovery: { now: () => 0, warn: () => {} },
  });
  if (!loop) return ctx.skip();
  const out: number[] = [];
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      loop.mainFrame(0.0107);
      for (const s of loop.render(4).left) out.push(s);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  };
  try {
    // A first play loads the clip onto the core; then silence.
    const warm = Audio.play("m.playlist.json");
    await vi.waitFor(async () => {
      await step(1);
      expect(out.some((s) => s !== 0)).toBe(true);
    });
    warm.stop(0);
    await step(20);
    const mark = out.length;
    const at = playlistHost().clock() + 0.2;
    const h = Audio.play("m.playlist.json", { at });
    await step(40);
    const first = out.findIndex((s, k) => k >= mark && s !== 0); // clip frame STEP, the first nonzero sample
    const start = first - STEP;
    // The bus's gain on the clip (its pan law), read where it plays.
    const g = out[first + 1000]! / clipAt(1000 + STEP);
    expectFrames(out, first, out.length - first, (k) => g * clipAt(STEP + k), "playing");

    h.pause();
    await step(30);
    const held = h.music!.time; // the heard time it holds at
    expect(h.paused).toBe(true);
    const hold = start + Math.round((held - at) * RATE);
    expect(hold).toBeGreaterThan(first);
    expect(hold).toBeLessThan(out.length - 5000);
    // Up to the hold it plays, the last 5 ms fading out, then silence.
    expectFrames(out, first, hold - FADE - first, (k) => g * clipAt(STEP + k), "before the hold");
    expectFrames(out, hold - FADE, FADE, (k) => g * clipAt(hold - FADE - start + k) * rampAt(1, 0, FADE, k), "fading into the hold");
    expectFrames(out, hold, out.length - hold, () => 0, "held");

    h.resume();
    const resumed = h.music!.time; // the heard time it continues at
    expect(resumed).toBeGreaterThan(held);
    const from = hold + Math.round((resumed - held) * RATE);
    await step(30);
    expectFrames(out, hold, from - hold, () => 0, "held until it continues");
    // It continues at `from` from the frame it held at (keeping time silently until the promote), heard from the
    // promote's 5 ms fade-in.
    const onset = out.findIndex((s, k) => k >= from && s !== 0);
    expect(onset).toBeGreaterThanOrEqual(from);
    expect(onset - from).toBeLessThan(RATE / 20);
    const pos = (j: number): number => hold - start + (j - from);
    expectFrames(out, from, onset - from, () => 0, "continuing silently");
    expectFrames(out, onset, FADE, (k) => g * clipAt(pos(onset + k)) * rampAt(0, 1, FADE, k), "fading in");
    expectFrames(out, onset + FADE, 4000, (k) => g * clipAt(pos(onset + FADE + k)), "continued");
    expect(h.paused).toBe(false);
    h.stop(0);
  } finally {
    endAudioSession();
    setAudioBackend(null);
    engine.dispose?.();
  }
});

it("stop ends a paused playback on the core (loopback)", { timeout: 30_000 }, async (ctx) => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "s.json": { format: "myco.scene@1", nodes: [] },
    "ramp.wav": "data:,",
    "c.playlist.json": { format: "myco.playlist@1", type: "clip", entries: [{ sample: "ramp.wav" }] },
  }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }], seed: 7 } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  endAudioSession();
  const loop = await loopbackAudio({
    mixer: "page", preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 },
    decode: () => ({ channelData: [ramp] }), recovery: { now: () => 0, warn: () => {} },
  });
  if (!loop) return ctx.skip();
  const { link } = loop;
  const out: number[] = [];
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      loop.mainFrame(0.0107);
      for (const s of loop.render(4).left) out.push(s);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  };
  try {
    const h = Audio.play("c.playlist.json");
    await vi.waitFor(async () => {
      await step(1);
      expect(out.some((s) => s !== 0)).toBe(true);
    });
    h.pause();
    await step(20);
    expect(link.lastStatus!.liveVoices).toBe(1);
    h.stop();
    await step(10);
    expect(h.playing).toBe(false);
    expect(link.lastStatus!.liveVoices).toBe(0);
  } finally {
    endAudioSession();
    setAudioBackend(null);
    engine.dispose?.();
  }
});

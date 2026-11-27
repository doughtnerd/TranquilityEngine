// ADR 0362 §1 on the real wasm core (the loopback host): a pause is heard at once, at the earliest stampable time, even
// when the sequence already sent stamps for later (it plans ahead of the heard clock); what was stamped past the hold
// waits with the voices and lands as much later as the playback was held. A ramp clip (sample k is floor(k / STEP) /
// 32767) says which clip frame plays. The hold and resume times are read through the public musical clock.
import { afterEach, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { setAudioBackend } from "../backend";
import { Audio } from "../index";
import { playlistHost } from "./host";
import { endAudioSession, loopbackAudio, closeLoopbackAudio } from "../testing";

const RATE = 48_000;
const STEP = 6;
const CLIP_FRAMES = 2 * RATE;
/** The core's promote, demote and pause fade, and the sequence's cut fade at a clip's end: 5 ms. */
const FADE = 240;
const TOL = 1e-6;
const ramp = Float32Array.from({ length: CLIP_FRAMES }, (_, k) => Math.floor(k / STEP) / 32767);
const clipAt = (k: number): number => Math.floor(k / STEP) / 32768;
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

it("pause holds at once, before the cut already stamped at the clip's end, which lands as much later (loopback)", { timeout: 30_000 }, async (ctx) => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "s.json": { format: "myco.scene@1", nodes: [] },
    "ramp.wav": "data:,",
    // One sync clip of 1 s over a 2 s sample: the sequence cuts it at 1 s with a stamped 5 ms fade, sent ahead.
    "m.playlist.json": {
      format: "myco.playlist@1", type: "sequence", entries: [],
      sequence: { length: 2, tempo: { bpm: 120, meter: "4/4" }, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", sample: "ramp.wav", at: 0, length: 1, sync: true }] }] },
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
    // Up to 0.06 s before the clip's end: the cut at 1 s is stamped and sent by now (the sequence plans ahead).
    while (playlistHost().clock() < at + 0.94) await step(1);
    const first = out.findIndex((s, k) => k >= mark && s !== 0);
    const start = first - STEP;
    const g = out[first + 1000]! / clipAt(1000 + STEP);

    const asked = Audio.horizon;
    h.pause();
    await step(30);
    const held = h.music!.time; // the heard time it holds at
    // Heard at once: at the earliest stampable time, before the cut (not after it).
    expect(held).toBeCloseTo(asked, 6);
    expect(held).toBeLessThan(at + 1 - 0.01);
    const hold = start + Math.round((held - at) * RATE);
    expectFrames(out, hold - FADE, FADE, (k) => g * clipAt(hold - FADE - start + k) * rampAt(1, 0, FADE, k), "fading into the hold");
    expectFrames(out, hold, out.length - hold, () => 0, "held");

    h.resume();
    const resumed = h.music!.time;
    const from = hold + Math.round((resumed - held) * RATE);
    await step(30);
    const onset = out.findIndex((s, k) => k >= from && s !== 0);
    expect(onset - from).toBeLessThan(RATE / 20);
    const pos = (j: number): number => hold - start + (j - from);
    // The clip plays on from where it held up to its end (1 s of clip), then its 5 ms cut: as much later as it was held.
    const end = from + (start + RATE - hold);
    expectFrames(out, onset + FADE, end - onset - FADE, (k) => g * clipAt(pos(onset + FADE + k)), "continued up to the cut");
    expectFrames(out, end, FADE, (k) => g * clipAt(pos(end + k)) * rampAt(1, 0, FADE, k), "the cut, as much later");
    expectFrames(out, end + FADE, 2000, () => 0, "after the cut");
    h.stop(0);
  } finally {
    endAudioSession();
    setAudioBackend(null);
    engine.dispose?.();
  }
});

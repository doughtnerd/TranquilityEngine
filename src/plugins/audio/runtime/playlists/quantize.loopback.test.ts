// ADR 0336 (beat-quantised automation) end to end on the real wasm core (the loopback host): a sequence at 120 bpm with
// a volume lane on a parameter quantised to the beat; the parameter changes early in the first beat and the rendered
// output keeps its old level up to the beat's sample, then ramps to the new one over the 20 ms stamped ramp.
import { afterEach, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { setAudioBackend } from "../backend";
import { Audio } from "../index";
import { playlistHost } from "./host";
import { endAudioSession, loopbackAudio, closeLoopbackAudio } from "../testing";

const RATE = 48_000;
const DC = 0.5;
const dc = new Float32Array(2 * RATE).fill(DC);

afterEach(async () => {
  await closeLoopbackAudio();
  vi.restoreAllMocks();
});

function level(out: readonly number[], from: number, to: number): number {
  let s = 0;
  for (let k = from; k < to; k++) s += Math.abs(out[k]!);
  return s / Math.max(1, to - from);
}

it("a quantised volume lane moves on the beat's sample, not before (loopback)", { timeout: 30_000 }, async (ctx) => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "s.json": { format: "myco.scene@1", nodes: [] },
    "dc.wav": "data:,",
    "m.playlist.json": {
      format: "myco.playlist@1", type: "sequence", entries: [],
      parameters: [{ name: "Intensity", min: 0, max: 1, default: 0 }],
      sequence: {
        length: 2, tempo: { bpm: 120, meter: "4/4" },
        tracks: [{
          id: "t", kind: "audio",
          automation: [{ id: "a", target: "volume", input: { parameter: "Intensity" }, curve: [[0, -20], [1, 0]], quantize: "beat" }],
          clips: [{ id: "c", sample: "dc.wav", at: 0, length: 2, sync: true }],
        }],
      },
    },
  }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }], seed: 7 } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  endAudioSession();
  const loop = await loopbackAudio({
    mixer: "page", preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 },
    decode: () => ({ channelData: [dc] }), recovery: { now: () => 0, warn: () => {} },
  });
  if (!loop) return ctx.skip();
  const { mixer } = loop;
  const out: number[] = [];
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      playlistHost().update(0.0107);
      mixer.update(0.0107);
      loop.tick(0.0107);
      for (const s of loop.render(4).left) out.push(s);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  };
  try {
    // A first play loads the clip onto the core (a voice whose clip is still loading starts late); then silence.
    const warm = Audio.play("m.playlist.json");
    await vi.waitFor(async () => {
      await step(1);
      expect(out.some((s) => s !== 0)).toBe(true);
    });
    warm.stop(0);
    await step(20);
    const mark = out.length;
    // Stamped well ahead, so the voice starts exactly on its stamp and the playhead's beats are the output's.
    const h = Audio.play("m.playlist.json", { at: playlistHost().clock() + 0.2 });
    await step(24);
    h.setParameter("Intensity", 1);
    await step(60); // past the first beat (0.5 s = 24,000 frames after the start) and its 20 ms ramp
    const start = out.findIndex((s, k) => k >= mark && s !== 0);
    const beat = start + RATE / 2;
    expect(out.length).toBeGreaterThan(beat + 4000);
    const before = level(out, beat - 4000, beat - 2);
    const after = level(out, beat + 2000, beat + 4000);
    // −20 dB until the beat, then full level.
    expect(after / before).toBeCloseTo(10, 1);
    // Not a sample early: the old level holds right up to the boundary; the ramp is under way 10 ms after it.
    expect(level(out, beat - 64, beat) / before).toBeCloseTo(1, 2);
    const mid = level(out, beat + 470, beat + 490) / before;
    expect(mid).toBeGreaterThan(3);
    expect(mid).toBeLessThan(8);
    h.stop();
  } finally {
    endAudioSession();
    setAudioBackend(null);
    engine.dispose?.();
  }
});

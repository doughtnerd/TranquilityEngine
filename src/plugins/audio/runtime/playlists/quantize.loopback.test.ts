// ADR 0350 (beat-quantised automation) end to end on the real wasm core (the loopback host): a sequence at 120 bpm with
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
  const out: number[] = [];
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      loop.mainFrame(0.0107);
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

it("a quantised pan lane moves on the beat, within one quantum (loopback)", { timeout: 30_000 }, async (ctx) => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "s.json": { format: "myco.scene@1", nodes: [] },
    "dc.wav": "data:,",
    "m.playlist.json": {
      format: "myco.playlist@1", type: "sequence", entries: [],
      parameters: [{ name: "Side", min: 0, max: 1, default: 0 }],
      sequence: {
        length: 2, tempo: { bpm: 120, meter: "4/4" },
        tracks: [{
          id: "t", kind: "audio",
          automation: [{ id: "a", target: "pan", input: { parameter: "Side" }, curve: [[0, 0], [1, 1]], quantize: "beat" }],
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
  const left: number[] = [];
  const right: number[] = [];
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      loop.mainFrame(0.0107);
      const o = loop.render(4);
      for (const s of o.left) left.push(s);
      for (const s of o.right) right.push(s);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  };
  try {
    const warm = Audio.play("m.playlist.json");
    await vi.waitFor(async () => {
      await step(1);
      expect(left.some((s) => s !== 0)).toBe(true);
    });
    warm.stop(0);
    await step(20);
    const mark = left.length;
    const h = Audio.play("m.playlist.json", { at: playlistHost().clock() + 0.2 });
    await step(24);
    h.setParameter("Side", 1);
    await step(60);
    const start = left.findIndex((s, k) => k >= mark && s !== 0);
    const beat = start + RATE / 2;
    const Q = 128;
    expect(left.length).toBeGreaterThan(beat + 4000);
    // Centred (equal on both sides) up to a quantum before the beat, then hard right once the 20 ms ramp is done.
    const lBefore = level(left, beat - 4000, beat - Q), rBefore = level(right, beat - 4000, beat - Q);
    expect(lBefore).toBeGreaterThan(0.1);
    expect(lBefore / rBefore).toBeCloseTo(1, 3);
    expect(level(left, beat + 960 + Q, beat + 4000)).toBeLessThan(lBefore * 1e-3);
    expect(level(right, beat + 960 + Q, beat + 4000)).toBeGreaterThan(rBefore * 1.3);
    // Not early: the left side holds its level up to the quantum before the beat.
    expect(level(left, beat - 2 * Q, beat - Q) / lBefore).toBeCloseTo(1, 3);
    // Under way halfway through the ramp (10 ms after the beat).
    const mid = level(left, beat + 470, beat + 490) / lBefore;
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.95);
    h.stop();
  } finally {
    endAudioSession();
    setAudioBackend(null);
    engine.dispose?.();
  }
});

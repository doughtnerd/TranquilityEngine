// ADR 0345 levels and ADR 0346's time origin (ABI 4.9) end to end on the real wasm core (the loopback host), through
// `Audio.play` and `Audio.debug()`:
// - a sequence clip with a delay is heard echoing after the clip's voice has ended (its chain runs on a submix of its
//   own, kept running for the tail);
// - a nested playlist's EQ applies to its own voices only (a sibling entry's voice passes untouched);
// - a long instance whose voices read an instance-level pan lane keyed on time doesn't grow the core's curve table.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { Audio } from "../index";
import { endAudioSession, loopbackAudio, closeLoopbackAudio } from "../testing";
import { embed, pl, pla, sample } from "./testKit";

const RATE = 48_000;
const LEVEL = 0.25;
/** 0.1 s of a constant level, then the file ends. */
const burst = new Float32Array(RATE / 10).fill(LEVEL);
/** 2 s of a constant level (DC). */
const dc = new Float32Array(2 * RATE).fill(LEVEL);
/** 2 s at Nyquist (+L, −L, …). */
const nyquist = Float32Array.from({ length: 2 * RATE }, (_, k) => (k % 2 === 0 ? LEVEL : -LEVEL));
/** 50 ms of a constant level (a continuous Queue's short entry). */
const tick = new Float32Array(RATE / 20).fill(LEVEL);
const CLIPS: Record<string, Float32Array> = { "burst.wav": burst, "dc.wav": dc, "nyq.wav": nyquist, "tick.wav": tick };
const FRAME = 0.0107;

afterEach(async () => {
  await closeLoopbackAudio();
  endAudioSession();
  vi.restoreAllMocks();
});

/** An engine over `files` (plus the clips) on the loopback host; null when the core can't load here. */
async function rig(files: Record<string, unknown>) {
  Assets.clearSources();
  const clipFiles = Object.fromEntries(Object.keys(CLIPS).map((p) => [p, "data:,"]));
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, ...clipFiles, ...files }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }], seed: 7 } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  endAudioSession();
  const loop = await loopbackAudio({
    mixer: "page", preset: { maxLogical: 32, maxMixed: 16, limiterLookaheadMs: 0 },
    decode: (path) => ({ channelData: [CLIPS[path.replace(/^.*\//, "")] ?? dc] }), recovery: { now: () => 0, warn: () => {} },
  });
  if (!loop) {
    engine.dispose();
    return null;
  }
  const out: number[] = [];
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      loop.mainFrame(FRAME);
      for (const s of loop.render(4).left) out.push(s);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  };
  /** Plays `path` once to load its clips onto the core (a voice whose clip is still loading starts late), then silence. */
  const warm = async (path: string) => {
    const h = Audio.play(path);
    await vi.waitFor(async () => {
      await step(1);
      expect(out.some((s) => s !== 0)).toBe(true);
    });
    h.stop(0);
    await step(40);
  };
  return { out, step, warm, dispose: () => engine.dispose() };
}

/** The mean absolute level of `out[from..to)`. */
function level(out: readonly number[], from: number, to: number): number {
  let s = 0;
  for (let k = from; k < to; k++) s += Math.abs(out[k]!);
  return s / Math.max(1, to - from);
}

describe("per-level submixes on the core (ADR 0345, ABI 4.9)", () => {
  it("a sequence clip's delay is heard echoing after the clip has ended", { timeout: 30_000 }, async (ctx) => {
    const delay = { id: "d", type: "delay", on: true, params: { time: 150, feedback: 50, mix: 50 } };
    const r = await rig({
      "echo.playlist.json": {
        format: "myco.playlist@1", type: "sequence", entries: [],
        sequence: { length: 1, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", sample: "burst.wav", at: 0, length: 0, effects: [delay] }] }] },
      },
    });
    if (!r) return ctx.skip();
    try {
      await r.warm("echo.playlist.json");
      const mark = r.out.length;
      Audio.play("echo.playlist.json");
      await r.step(80); // 0.86 s
      const onset = r.out.findIndex((s, k) => k >= mark && Math.abs(s) > 1e-4);
      expect(onset).toBeGreaterThan(0);
      const at = (s: number) => onset + Math.round(s * RATE);
      // The clip itself (0.1 s): dry half (mix 50 %).
      expect(level(r.out, at(0.02), at(0.08))).toBeCloseTo(LEVEL / 2, 2);
      // Between the clip's end and its first echo: silence.
      expect(level(r.out, at(0.11), at(0.14))).toBeLessThan(1e-3);
      // The first echo, 150 ms after the burst (its voice ended 50 ms before): the wet half; then the second, half again.
      const first = level(r.out, at(0.17), at(0.23));
      const second = level(r.out, at(0.32), at(0.38));
      console.info(`[levels] clip delay: echoes ${first.toFixed(4)}, ${second.toFixed(4)} after the clip's 0.1 s`);
      expect(first).toBeCloseTo(LEVEL / 2, 2);
      expect(second).toBeCloseTo(LEVEL / 4, 2);
    } finally {
      r.dispose();
    }
  });

  it("a loading clip with a delay, played unstamped, still runs its chain once it starts", { timeout: 30_000 }, async (ctx) => {
    // The clip isn't on the core yet: the sequence restarts each frame while it loads (D44), so the voice that sounds
    // is a restarted one, stamped; its ROUTE into the clip's submix must still follow its PLAY.
    const delay = { id: "d", type: "delay", on: true, params: { time: 150, feedback: 50, mix: 50 } };
    const r = await rig({
      "cold.playlist.json": {
        format: "myco.playlist@1", type: "sequence", entries: [],
        sequence: { length: 1, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", sample: "burst.wav", at: 0, length: 0, effects: [delay] }] }] },
      },
    });
    if (!r) return ctx.skip();
    try {
      const mark = r.out.length;
      Audio.play("cold.playlist.json");
      await vi.waitFor(async () => {
        await r.step(1);
        expect(r.out.some((s, k) => k >= mark && Math.abs(s) > 1e-4)).toBe(true);
      });
      await r.step(60);
      const onset = r.out.findIndex((s, k) => k >= mark && Math.abs(s) > 1e-4);
      const at = (s: number) => onset + Math.round(s * RATE);
      expect(level(r.out, at(0.02), at(0.08))).toBeCloseTo(LEVEL / 2, 2);
      expect(level(r.out, at(0.17), at(0.23))).toBeCloseTo(LEVEL / 2, 2);
    } finally {
      r.dispose();
    }
  });

  it("a nested playlist's EQ applies to its own voices only",{ timeout: 30_000 }, async (ctx) => {
    // Low and high shelves at −18 dB: DC and Nyquist both fall 18 dB through it.
    const eq = { id: "e", type: "eq", on: true, params: { low: -18, mid: 0, high: -18 } };
    const r = await rig({
      "nest.playlist.json": pla("layer", [embed(pl("clip", [sample("dc.wav")], { effects: [eq] })), sample("nyq.wav")]),
    });
    if (!r) return ctx.skip();
    try {
      await r.warm("nest.playlist.json");
      const mark = r.out.length;
      Audio.play("nest.playlist.json");
      await r.step(40);
      const from = r.out.length - 4800;
      // Split the output into its DC part (the nested playlist's voice) and its Nyquist part (the sibling's).
      let d = 0, n = 0;
      for (let k = from; k < r.out.length - 1; k += 2) {
        d += (r.out[k]! + r.out[k + 1]!) / 2;
        n += (r.out[k]! - r.out[k + 1]!) / 2;
      }
      const pairs = Math.floor((r.out.length - 1 - from) / 2);
      d = Math.abs(d / pairs);
      n = Math.abs(n / pairs);
      console.info(`[levels] nested EQ: its own voice ${d.toFixed(4)} (of ${LEVEL}), the sibling ${n.toFixed(4)}`);
      expect(mark).toBeGreaterThan(0);
      expect(d).toBeCloseTo(LEVEL * Math.pow(10, -18 / 20), 2);
      expect(n).toBeCloseTo(LEVEL, 2);
    } finally {
      r.dispose();
    }
  });
});

describe("time-keyed lanes read through a binding's time origin (ADR 0346, ABI 4.9)", () => {
  it("a long instance whose voices read a time-keyed pan lane doesn't grow the core's curve table", { timeout: 30_000 }, async (ctx) => {
    // A 2 s sequence whose track pans along sequence time, with a clip every 60 ms: each clip's voice reads the lane from
    // a different point (its start on the sequence's clock). Before ABI 4.9 each voice uploaded a shifted copy of the
    // curve (measured on the base: 3 curves, then 11 after ~9 clips, 29 after ~27).
    const clips = Array.from({ length: 32 }, (_, k) => ({ id: `c${k}`, sample: "tick.wav", at: k * 0.06, length: 0 }));
    const r = await rig({
      "pan.playlist.json": {
        format: "myco.playlist@1", type: "sequence", entries: [],
        sequence: { length: 2, tracks: [{ id: "t", kind: "audio", automation: [{ id: "p", target: "pan", input: "sequenceTime", curve: [[0, -1], [2, 1]] }], clips }] },
      },
    });
    if (!r) return ctx.skip();
    try {
      const curves = () => (Audio.debug().core as { automationCurves?: number }).automationCurves ?? 0;
      await r.warm("pan.playlist.json");
      const before = curves();
      const h = Audio.play("pan.playlist.json");
      await r.step(50); // ~0.5 s: about 9 clips
      const early = curves();
      await r.step(100); // ~1.1 s more: about 18 more clips, each starting later on the lane
      const late = curves();
      console.info(`[levels] curve table: ${before} curves before, ${early} after ~9 clips, ${late} after ~27`);
      expect(early).toBeGreaterThan(0);
      expect(late).toBe(early);
      h.stop(0);
    } finally {
      r.dispose();
    }
  });
});

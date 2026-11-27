// ADR 0362 items 2 and 3 end to end on the real wasm core (the loopback host, ABI 6.1), through `Audio.play`:
// - a reversed sequence clip is heard backwards: a rising ramp sample comes out falling, sample for sample (the core
//   voice reads the decoded PCM backwards), and a streamed sample is decoded whole for it;
// - a clip's Amp envelope shapes what is heard per sample: silent at the clip's start, half way up half way through
//   the attack, at the sustain level after the decay, and down to silence by the clip's end.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { Audio } from "../index";
import { endAudioSession, loopbackAudio, closeLoopbackAudio } from "../testing";
import { pla } from "./testKit";

const RATE = 48_000;
/** 0.5 s rising from 0 to 0.4 (sample k is k × 0.4 / 24000). */
const ramp = Float32Array.from({ length: RATE / 2 }, (_, k) => (k * 0.4) / (RATE / 2));
/** 2 s of a constant level. */
const LEVEL = 0.25;
const dc = new Float32Array(2 * RATE).fill(LEVEL);
const CLIPS: Record<string, Float32Array> = { "ramp.wav": ramp, "dc.wav": dc };
const FRAME = 0.0107;

afterEach(async () => {
  await closeLoopbackAudio();
  endAudioSession();
  vi.restoreAllMocks();
});

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
  /** Plays `path` once so its clips are on the core, then silence; returns where the output is from then on. */
  const warm = async (path: string) => {
    const h = Audio.play(path);
    await vi.waitFor(async () => {
      await step(1);
      expect(out.some((s) => s !== 0)).toBe(true);
    });
    h.stop(0);
    await step(40);
    return out.length;
  };
  return { out, step, warm, dispose: () => engine.dispose() };
}

const seq = (clip: Record<string, unknown>, length: number) => pla("sequence", [], { sequence: { length, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", at: 0, ...clip }] }] } });

describe("ADR 0362 on the audio core", () => {
  it("a reversed clip is heard backwards, sample for sample, and a streamed sample is decoded whole for it", async () => {
    const r = await rig({ "ramp.wav.meta.json": { format: "myco.import@1", stream: true }, "r.playlist.json": seq({ sample: "ramp.wav", length: 0, reverse: true }, 0.6) });
    if (!r) return;
    const from = await r.warm("r.playlist.json");
    Audio.play("r.playlist.json");
    await r.step(80);
    const heard = r.out.slice(from);
    const first = heard.findIndex((s) => s !== 0);
    expect(first).toBeGreaterThanOrEqual(0);
    // The ramp's last frame first, then down by one frame each sample (the clip is held as int16 on the core).
    const q = (v: number) => Math.round(v * 32767) / 32768;
    for (let k = 0; k < 2000; k++) expect(heard[first + k]).toBeCloseTo(q(ramp[ramp.length - 1 - k]!), 7);
    expect(heard[first + 20_000]).toBeCloseTo(q(ramp[ramp.length - 1 - 20_000]!), 7);
    r.dispose();
  });

  it("an async reversed clip's held loop runs backwards inside its region (the core mirrors it)", async () => {
    // ramp.wav loops 0.1..0.2 s, held: reversed it reads 0.5 s down to 0.2 s, then 0.2 → 0.1 again and again.
    const r = await rig({
      "ramp.wav.meta.json": { format: "myco.import@1", sample: { loops: [{ id: "l", start: 0.1, end: 0.2, active: "held" }] } },
      "l.playlist.json": seq({ sample: "ramp.wav", length: 2, reverse: true }, 2),
    });
    if (!r) return;
    const from = await r.warm("l.playlist.json");
    Audio.play("l.playlist.json");
    await r.step(100);
    const heard = r.out.slice(from);
    const first = heard.findIndex((s) => s !== 0);
    const lo = ramp[Math.round(0.1 * RATE)]!, hi = ramp[Math.round(0.2 * RATE)]!;
    // Past the first 0.3 s (the tail, read down) every sample is inside the region, falling but for the wraps up to its top.
    const looped = heard.slice(first + Math.round(0.31 * RATE), first + Math.round(1.2 * RATE));
    expect(looped.every((s) => s >= lo - 1e-3 && s <= hi + 1e-3)).toBe(true);
    let wraps = 0;
    for (let k = 1; k < looped.length; k++) if (looped[k]! > looped[k - 1]! + 1e-3) wraps++;
    // About 9 passes; the seam's crossfade smooths some wraps below the jump this counts.
    expect(wraps).toBeGreaterThanOrEqual(4);
    r.dispose();
  });

  it("a clip's Amp envelope shapes its voice per sample over the clip's time", async () => {
    // A 1 s clip: attack 100 ms, hold 50 ms, decay 100 ms to 50 %, release 200 ms ending on the clip's end.
    const envelope = { id: "e", type: "envelope", params: { attack: 100, hold: 50, decay: 100, sustain: 50, release: 200 } };
    const r = await rig({ "e.playlist.json": seq({ sample: "dc.wav", length: 1, effects: [envelope] }, 1.2) });
    if (!r) return;
    const from = await r.warm("e.playlist.json");
    Audio.play("e.playlist.json");
    await r.step(130);
    const heard = r.out.slice(from);
    // Frame 0 of the envelope is silent: the voice's first frame is the one before the first non-zero sample.
    const start = heard.findIndex((s) => s !== 0) - 1;
    expect(start).toBeGreaterThanOrEqual(0);
    const at = (seconds: number) => heard[start + Math.round(seconds * RATE)]!;
    expect(at(0.05)).toBeCloseTo(LEVEL * 0.5, 5);
    expect(at(0.12)).toBeCloseTo(LEVEL, 5);
    expect(at(0.2)).toBeCloseTo(LEVEL * 0.75, 5);
    expect(at(0.5)).toBeCloseTo(LEVEL * 0.5, 5);
    expect(at(0.9)).toBeCloseTo(LEVEL * 0.25, 4);
    expect(Math.abs(at(1.001))).toBeLessThan(1e-6);
    r.dispose();
  });
});

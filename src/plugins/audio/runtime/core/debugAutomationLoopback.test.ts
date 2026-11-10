// ADR 0158 §5 (E3.9) on the real wasm (the loopback host): `Audio.debug()` on the core shows automation. An event
// voice's `gain` and `pitch` carry main's estimate of its automated gain and pitch (following the parameter's seek), it
// has a `playheadSeconds` (the tracker's estimate, moving at the automated pitch), a bus's `gain`/`effectiveGain`
// carry the bus automation a global parameter drives, and an instance's `events` row goes with its last listed voice,
// never a poll before it (a stop with a fade, and a natural end).
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { mixer as globalMixer } from "../../../../engine/audio/mixer";
import { setAudioBackend } from "../backend";
import { Audio } from "../index";
import { events } from "../events/eventRuntime";
import { _resetHandleWarningsForTests } from "./handle";
import { fakeDecoder, type PlanarClip } from "./fakeDecoder";
import { createClipRegistry } from "./clipRegistry";
import type { AudioHost, CoreLink } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";

const RATE = 48_000;
const LONG = 96_000;
const SHORT = 4_800; // 0.1 s
const F = "myco.audioevent@1";
const decode = fakeDecoder(async (bytes): Promise<PlanarClip> => {
  const frames = bytes.byteLength === 8 ? SHORT : LONG;
  return { frames, channels: 1, sampleRate: RATE, channelData: [new Float32Array(frames).fill(0.25)] };
});
const fetchBytes = async (path: string) => new ArrayBuffer(path.startsWith("short") ? 8 : 16);

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  events()._reset();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

async function rig() {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "s.json": { format: "myco.scene@1", nodes: [] },
    "long.wav": "data:,",
    "short.wav": "data:,",
    "auto.audioevent.json": {
      format: F,
      bus: "Music",
      parameters: [{ name: "Speed", min: 0, max: 1, default: 1, seekSpeed: 5 }],
      automation: [
        { parameter: "Speed", target: "volume", curve: [[0, 0], [1, 1]] },
        { parameter: "Speed", target: "pitch", curve: [[0, 0.5], [1, 1.5]] },
      ],
      root: { type: "clip", clip: "long.wav", loop: true },
    },
    "plain.audioevent.json": { format: F, root: { type: "clip", clip: "long.wav", loop: true } },
    "short.audioevent.json": { format: F, root: { type: "clip", clip: "short.wav" } },
  }));
  const engine = await Engine.create({
    headless: true,
    project: {
      audio: {
        buses: [{ name: "Master" }, { name: "Music", parent: "Master", volume: 0.6 }],
        seed: 7,
        parameters: [{ name: "Intensity", min: 0, max: 1, default: 1 }],
        automation: [{ bus: "Music", parameter: "Intensity", target: "volume", curve: [[0, 0.45], [1, 1]] }],
      },
    },
  });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  _resetHandleWarningsForTests();
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } })) as typeof loop;
  } catch {
    return null;
  }
  const link = loop.link;
  const clips = createClipRegistry({ send: (m) => link.post(m), nextSeq: () => link.nextSeq(), fetchBytes, decodeWorker: decode, nextFrame: (cb) => cb(), nextQuantum: (cb) => cb() });
  const host: CoreBackendHost = { link, status: "running", preset: { maxLogical: 16, maxMixed: 8 }, worldCount: 1, sampleRate: RATE, addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"] };
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer: globalMixer });
  closers.push(() => backend.dispose());
  events()._reset();
  setAudioBackend(backend);
  /** `n` frames of 4 quanta (about 10.7 ms each), as the engine's audio step runs them. */
  const step = async (n: number, each?: () => void) => {
    for (let f = 0; f < n; f++) {
      globalMixer.update(0.0107);
      backend.update(0.0107);
      events().update(0.0107);
      loop.renderQuanta(4);
      for (let k = 0; k < 4; k++) await Promise.resolve();
      each?.();
    }
  };
  return { backend, step };
}

const eventVoices = (id: number) => Audio.debug().voices.filter((v) => v.event === id && v.state !== "stolen");

describe("Audio.debug() on the core shows automation (E3.9, loopback)", () => {
  it("an event voice's gain and pitch follow its automation (through the seek), and it has a moving playhead", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const h = Audio.play("auto.audioevent.json");
    const id = Audio.debug().events[0]!.id;
    await vi.waitFor(async () => {
      await r.step(1);
      expect(eventVoices(id)[0]?.playheadSeconds ?? 0).toBeGreaterThan(0);
    });
    const [v0] = eventVoices(id);
    // Speed 1: volume curve 1, pitch curve 1.5 (the voice's own gain and pitch are 1).
    expect(v0!.gain).toBeCloseTo(1, 5);
    expect(v0!.pitch).toBeCloseTo(1.5, 5);
    // The playhead moves at the automated pitch: 20 frames (0.214 s) of context time is about 0.32 s of clip.
    const p0 = v0!.playheadSeconds!;
    await r.step(20);
    const p1 = eventVoices(id)[0]!.playheadSeconds!;
    expect(p1 - p0).toBeGreaterThan(0.214 * 1.5 * 0.9);
    expect(p1 - p0).toBeLessThan(0.214 * 1.5 * 1.1);
    // Speed 1 → 0.2 at 5 units/s: 0.16 s of smoothing. Partway, the estimate is between; after, at the curves' 0.2.
    h.setParameter("Speed", 0.2);
    await r.step(6); // about 0.064 s: Speed about 0.68
    const mid = eventVoices(id)[0]!;
    expect(mid.gain).toBeGreaterThan(0.25);
    expect(mid.gain).toBeLessThan(0.95);
    expect(mid.pitch).toBeCloseTo(0.5 + mid.gain, 5); // both curves read the same smoothed value
    await r.step(20);
    const done = eventVoices(id)[0]!;
    expect(done.gain).toBeCloseTo(0.2, 5);
    expect(done.pitch).toBeCloseTo(0.7, 5);
    // A voice without automation reads its own gain and pitch, as before.
    Audio.play("plain.audioevent.json", { volume: 0.5 });
    await r.step(4);
    const plainId = Audio.debug().events.find((e) => e.asset === "plain.audioevent.json")!.id;
    const plain = eventVoices(plainId)[0]!;
    expect(plain.gain).toBeCloseTo(0.5, 5);
    expect(plain.pitch).toBe(1);
  });

  it("a bus's gain and effectiveGain carry the bus automation a global parameter drives", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    Audio.play("plain.audioevent.json"); // the runtime binds the buses on its first play
    await r.step(4);
    const music = () => Audio.debug().buses.find((b) => b.name === "Music")!;
    // Intensity 1: the curve's 1, so the static 0.6.
    expect(music().effectiveGain).toBeCloseTo(0.6, 5);
    Audio.setParameter("Intensity", 0);
    await r.step(2);
    expect(music().gain).toBeCloseTo(0.6 * 0.45, 5);
    expect(music().effectiveGain).toBeCloseTo(0.6 * 0.45, 5);
    expect(Audio.debug().buses.find((b) => b.name === "Master")!.effectiveGain).toBeCloseTo(1, 5);
    Audio.setParameter("Intensity", 1);
    await r.step(2);
    expect(music().effectiveGain).toBeCloseTo(0.6, 5);
  });

  it("an instance's events row goes with its last listed voice, never a poll before it", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const polls: { row: boolean; voices: number }[] = [];
    let watched = 0;
    const poll = () => {
      const d = Audio.debug();
      const listed = d.voices.filter((v) => v.event === watched && v.state !== "stolen").length;
      const row = d.events.find((e) => e.id === watched);
      polls.push({ row: row !== undefined, voices: listed });
      if (row) expect(row.voices).toBeGreaterThanOrEqual(1);
    };
    // A stop with a fade: the voice is listed (stopping) for the fade, and so is the row.
    const h = Audio.play("auto.audioevent.json");
    watched = Audio.debug().events[0]!.id;
    await r.step(10, poll);
    h.stop(0.1);
    expect(h.playing).toBe(false);
    poll();
    expect(polls.at(-1)).toEqual({ row: true, voices: 1 }); // before E3.9 the row went here, at the stop
    await r.step(30, poll);
    expect(polls.at(-1)).toEqual({ row: false, voices: 0 });
    for (const p of polls) expect(p.row).toBe(p.voices > 0);
    // A natural end: the clip plays out, the voice ends, and the row goes with it.
    polls.length = 0;
    Audio.play("short.audioevent.json");
    watched = Audio.debug().events.find((e) => e.asset === "short.audioevent.json")!.id;
    await r.step(40, poll);
    expect(polls.some((p) => p.voices > 0)).toBe(true);
    expect(polls.at(-1)).toEqual({ row: false, voices: 0 });
    for (const p of polls) expect(p.row).toBe(p.voices > 0);
  });
});

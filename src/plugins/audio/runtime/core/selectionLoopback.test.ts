// A3.1 end to end: the core backend's selection on the loopback host (the real wasm, clip registry, shell and
// coreBackend). The mixed cap holds in the core's counts and the output, a louder voice is promoted after the dwell,
// an inaudible World's voices go silent and come back in time, a bus past `maxVoices` steals (the handle reads
// "stolen" and `Audio.debug()` lists it), and a voice stolen for a sound still loading is stopped on the core.
import { fakeDecoder } from "./fakeDecoder";
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import type { AudioHost, CoreLink } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import { DWELL_FRAMES } from "./selection";

const req = (path: string, extra: object = {}) => ({ path, url: path, loop: true, stream: false, bus: "SFX", ...extra });

/** A rig on the loopback host with `maxMixed` and `maxLogical`; clips are a constant 0.5 (paths in `pending` never finish loading). */
async function rig(opts: { maxMixed: number; maxLogical?: number; settings?: AudioSettings; pending?: string[] }) {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost()) as typeof loop;
  } catch {
    return null;
  }
  const { createClipRegistry } = await import("./clipRegistry");
  const link = loop.link;
  const pending = new Set(opts.pending ?? []);
  const frames = 48_000;
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (path) => (pending.has(path) ? new Promise<ArrayBuffer>(() => {}) : new ArrayBuffer(8)),
    decodeWorker: fakeDecoder(async () => ({ frames, channels: 1, sampleRate: 48_000, channelData: [new Float32Array(frames).fill(0.5)] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: opts.maxLogical ?? 64, maxMixed: opts.maxMixed },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const mixer = new Mixer(opts.settings ?? defaultAudioSettings());
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  /** `n` frames of 4 quanta; returns the last quantum's left level. */
  const step = async (n: number) => {
    let level = NaN;
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      const { left } = loop.renderQuanta(4);
      level = left[left.length - 1]!;
      await Promise.resolve();
    }
    return level;
  };
  return { loop, backend, mixer, step };
}

describe("selection on the loopback host (A3.1)", () => {
  it("mixes at most `voices.mixed`: the core's count and the output are the loudest voices'", async (ctx) => {
    const r = await rig({ maxMixed: 4 });
    if (!r) return ctx.skip();
    const { backend, step, loop } = r;
    const volumes = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((v) => v / 4); // under the limiter's 0 dBFS
    const voices = volumes.map((v, k) => backend.play(req(`v${k}.wav`, { volume: v }))!);
    const level = await step(10);
    expect(loop.link.lastStatus?.mixedVoices ?? backend.mirror.mixedVoices).toBe(4);
    expect(backend.mirror.mixedVoices).toBe(4);
    expect(backend.mirror.liveVoices).toBe(8);
    expect(level).toBeCloseTo((0.5 * (0.5 + 0.6 + 0.7 + 0.8)) / 4, 5);
    const states = backend.debug().voices.map((v) => v.state);
    expect(states.filter((s) => s === "playing")).toHaveLength(4);
    expect(states.filter((s) => s === "virtual")).toHaveLength(4);
    expect(voices.map((v) => v.reason)).toEqual(["virtual", "virtual", "virtual", "virtual", null, null, null, null]);
    expect(voices.every((v) => v.playing)).toBe(true);
    backend.dispose();
  });

  it("a voice made louder is promoted (after its dwell) and replaces the quietest", async (ctx) => {
    const r = await rig({ maxMixed: 2 });
    if (!r) return ctx.skip();
    const { backend, step } = r;
    const a = backend.play(req("a.wav", { volume: 0.2 }))!;
    const b = backend.play(req("b.wav", { volume: 0.4 }))!;
    const c = backend.play(req("c.wav", { volume: 0.1 }))!;
    expect(await step(DWELL_FRAMES + 2)).toBeCloseTo(0.5 * (0.2 + 0.4), 5);
    expect(c.reason).toBe("virtual");
    c.setVolume(0.9);
    expect(await step(DWELL_FRAMES + 2)).toBeCloseTo(0.5 * (0.9 + 0.4), 5);
    expect(a.reason).toBe("virtual");
    expect(c.reason).toBeNull();
    expect(b.reason).toBeNull();
    backend.dispose();
  });

  it("an inaudible World's voices go virtual at once and come back, still in time", async (ctx) => {
    const r = await rig({ maxMixed: 8 });
    if (!r) return ctx.skip();
    const { backend, step } = r;
    const w = backend.play({ ...req("w.wav"), world: 7 })!;
    const other = backend.play(req("o.wav", { volume: 0.5 }))!;
    expect(await step(4)).toBeCloseTo(0.5 + 0.25, 5);
    backend.setWorldAudible(7, false);
    expect(await step(2)).toBeCloseTo(0.25, 5);
    expect(w.reason).toBe("virtual");
    expect(w.playing).toBe(true);
    expect(other.reason).toBeNull();
    backend.setWorldAudible(7, true);
    expect(await step(DWELL_FRAMES + 1)).toBeCloseTo(0.75, 5);
    expect(w.reason).toBeNull();
    backend.dispose();
  });

  it("a bus past maxVoices steals: the handle reads stolen and Audio.debug() lists it", async (ctx) => {
    const settings = defaultAudioSettings();
    settings.buses = settings.buses.map((b) => (b.name === "Music" ? { ...b, maxVoices: 1 } : b));
    const r = await rig({ maxMixed: 8, settings });
    if (!r) return ctx.skip();
    const { backend, step } = r;
    const keep = backend.play(req("k.wav", { bus: "Music", priority: 200 }))!;
    const moved = backend.play(req("m.wav", { bus: "SFX", priority: 10, volume: 0.5 }))!;
    expect(await step(10)).toBeCloseTo(0.75, 5);
    moved.setBus("Music"); // two on a bus of one
    expect(await step(3)).toBeCloseTo(0.5, 5);
    expect(moved.playing).toBe(false);
    expect(moved.reason).toBe("stolen");
    expect(keep.playing).toBe(true);
    const listed = backend.debug().voices;
    expect(listed.find((v) => v.state === "stolen")).toMatchObject({ id: moved.id, bus: "Music", priority: 10 });
    expect(backend.debug().buses.find((b) => b.name === "Music")?.voices).toBe(1);
    backend.dispose();
  });

  it("a voice stolen for a sound still loading stops on the core", async (ctx) => {
    const r = await rig({ maxMixed: 8, maxLogical: 2, pending: ["late.wav"] });
    if (!r) return ctx.skip();
    const { backend, step } = r;
    backend.play(req("a.wav", { priority: 10, volume: 0.4 }));
    backend.play(req("b.wav", { priority: 10, volume: 0.2 }));
    expect(await step(10)).toBeCloseTo(0.3, 5);
    const late = backend.play(req("late.wav", { priority: 200 }))!; // table full: steals b (quieter), waits for its clip
    expect(late.reason).toBe("waitingForData");
    expect(await step(4)).toBeCloseTo(0.2, 5);
    expect(backend.mirror.liveVoices).toBe(1);
    backend.dispose();
  });
});

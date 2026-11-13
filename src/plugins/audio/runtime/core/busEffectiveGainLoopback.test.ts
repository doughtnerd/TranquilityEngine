// ADR 0158 §3 (M2 F2) on the real wasm (the loopback host): `Audio.bus(n).effectiveGain` on the core includes the bus
// automation a global parameter drives (as on the Babylon fallback), following the parameter's seek to its target,
// multiplied with snapshots and parents, and never sent to the core a second time (the runtime lane carries no automation).
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
        parameters: [{ name: "Intensity", min: 0, max: 1, default: 1, seekSpeed: 5 }],
        snapshots: [{ name: "Half", volumes: { Music: 0.5 }, lowpass: {} }],
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

const _x = (id: number) => Audio.debug().voices.filter((v) => v.event === id && v.state !== "stolen");


describe("Bus.effectiveGain on the core includes bus automation (M2 F2, loopback)", () => {
  it("follows a seeking global parameter to its target, settles, and multiplies with a snapshot", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    Audio.play("plain.audioevent.json"); // the runtime binds the buses on its first play
    await r.step(4);
    const music = Audio.bus("Music");
    expect(music.effectiveGain).toBeCloseTo(0.6, 5);
    // Intensity 1 -> 0 at 5 units/s: 0.2 s; the curve runs 1 -> 0.45 along it.
    Audio.setParameter("Intensity", 0);
    await r.step(8); // about 0.086 s: Intensity about 0.57
    const mid = music.effectiveGain;
    expect(mid).toBeLessThan(0.6 - 0.01);
    expect(mid).toBeGreaterThan(0.6 * 0.45 + 0.01);
    await r.step(2);
    expect(music.effectiveGain).toBeLessThan(mid);
    await r.step(20);
    expect(music.effectiveGain).toBeCloseTo(0.6 * 0.45, 5);
    const settled = music.effectiveGain;
    await r.step(3);
    expect(music.effectiveGain).toBe(settled);
    // The core's own gain is untouched: the mixer's applied gain leaves automation out (the core multiplies it itself).
    expect(globalMixer.resolve("Music")!.gain).toBeCloseTo(0.6, 5);
    expect(Audio.bus("Master").effectiveGain).toBeCloseTo(1, 5);
    // A snapshot multiplies with it.
    globalMixer.snapshot("Half", 0);
    await r.step(2);
    expect(music.effectiveGain).toBeCloseTo(0.6 * 0.5 * 0.45, 5);
    globalMixer.clearSnapshot(0);
    Audio.setParameter("Intensity", 1);
    await r.step(30);
    expect(music.effectiveGain).toBeCloseTo(0.6, 5);
    globalMixer.clearSnapshot(0);
  });

  it("writes nothing to the mixer while nothing seeks", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    Audio.play("plain.audioevent.json");
    await r.step(4);
    const spy = vi.spyOn(globalMixer, "_setAutomationView");
    await r.step(10);
    expect(spy).not.toHaveBeenCalled();
    Audio.setParameter("Intensity", 0);
    await r.step(30);
    expect(spy.mock.calls.length).toBeGreaterThan(2);
    const n = spy.mock.calls.length;
    await r.step(10);
    expect(spy.mock.calls.length).toBe(n);
  });
});

// ADR 0158 §4, M2 E4.5: the one behaviour change for existing projects. A plain looping clip (an `AudioSource` with
// `loop`, or `playOneShot` with loop) loops its sidecar's or file's loop points instead of the whole clip, on both
// backends: the core (loopback host, real mixer wasm; decoded clips and streams) and the Babylon fallback (mocked
// AudioV2). A late-arriving answer applies, the sidecar wins, Babylon clamps the end to the buffer, no points loops
// whole. Plus the selection half (decision 14): a voice fading to 0 stays audible to selection until its fade ends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../../../engine/index";
import { Mixer, mixer } from "../../../engine/audio/mixer";
import { defaultAudioSettings, parseAudioSettings } from "../../../engine/audio/settings";
import { babylonMock, makeFakeContext, type MockSound } from "../testing/babylonMocks";
import { RATE, rig } from "../testing/streamRig";
import { setAudioBackend, type PlayRequest } from "./backend";
import { BabylonBackend } from "./babylonBackend";
import { fakeDecoder } from "./core/fakeDecoder";
import { _resetHandleWarningsForTests } from "./core/handle";
import { CoreBackend, type CoreBackendHost } from "./core/coreBackend";
import type { AudioHost, CoreLink } from "./core/context";
import { CoreAutomation, type CoreAutomationDeps } from "./core/coreAutomation";
import { VoiceState, VoiceTable } from "./core/voiceTable";
import { makeWav, signal } from "./decoder/testWav";
import { resetFileLoopPoints } from "./loopPoints";
import type { AudioVoice } from "./backend";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

// ---- a WAV with a `smpl` loop, as a file or a data: URL ----

/** `base` with a trailing `smpl` chunk looping `start..end` (end exclusive; the chunk stores it inclusive). */
function withSmpl(base: ArrayBuffer, start: number, end: number): Uint8Array {
  const b = new Uint8Array(base);
  const smpl = new Uint8Array(8 + 60);
  const dv = new DataView(smpl.buffer);
  smpl.set([0x73, 0x6d, 0x70, 0x6c]);
  dv.setUint32(4, 60, true);
  dv.setUint32(8 + 28, 1, true);
  dv.setUint32(8 + 36 + 8, start, true);
  dv.setUint32(8 + 36 + 12, end - 1, true);
  const out = new Uint8Array(b.length + smpl.length);
  out.set(b);
  out.set(smpl, b.length);
  return out;
}
const dataUrl = (bytes: Uint8Array): string => `data:audio/wav;base64,${Buffer.from(bytes).toString("base64")}`;
const tinyWav = (rate: number) => makeWav(16, 1, rate, () => 0);

beforeEach(() => resetFileLoopPoints());
afterEach(() => {
  Assets.clearSources();
  vi.restoreAllMocks();
});

// ---- the core, decoded clips ----

const STEP = 3;
const CLIP_FRAMES = 9_600;
const clipAt = (k: number): number => Math.floor(k / STEP) / 32768;
const looped = (k: number, start: number, end: number) => (k < end ? k : start + ((k - start) % (end - start)));

async function clipRig(points: { start: number; end: number } | null) {
  const testing = await import("./testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } })) as typeof loop;
  } catch {
    return null;
  }
  const { createClipRegistry } = await import("./core/clipRegistry");
  const link = loop.link;
  const ramp = Float32Array.from({ length: CLIP_FRAMES }, (_, k) => Math.floor(k / STEP) / 32767);
  const inner = fakeDecoder(async () => ({ frames: CLIP_FRAMES, channels: 1, sampleRate: 48_000, channelData: [ramp] }));
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async () => new ArrayBuffer(8),
    // The wasm's info carries the file's loop points in frames; the fake adds them.
    decodeWorker: {
      async decodeClip(...args: Parameters<typeof inner.decodeClip>) {
        const r = await inner.decodeClip(...args);
        return points ? { ...r, info: { ...r.info, loopStartFrame: points.start, loopEndFrame: points.end } } : r;
      },
    },
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 16, maxMixed: 8 },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const m = new Mixer(defaultAudioSettings());
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer: m });
  const out: number[] = [];
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      m.update(0.003);
      backend.update(0.003);
      for (const s of loop.renderQuanta(4).left) out.push(s);
      await Promise.resolve();
    }
  };
  return { backend, step, out };
}

/** Checks the output loops `start..end` (clip frames) from a little after the first sound to the end of the run. */
function expectLoops(out: number[], start: number, end: number): void {
  const at = out.findIndex((s) => s !== 0) - STEP; // output index of clip frame 0
  expect(at).toBeGreaterThanOrEqual(0);
  expect(out.length - at).toBeGreaterThan(end + 3 * (end - start));
  for (let j = at + 64; j < out.length; j++) {
    const want = clipAt(looped(j - at, start, end));
    if (Math.abs(out[j]! - want) > 1e-6) expect.fail(`output ${j} (clip frame ${j - at}): ${out[j]} vs ${want} (region ${start}..${end})`);
  }
}

describe("a plain looping clip on the core uses its loop points (E4.5)", () => {
  it("loops the file's region (the points arrive after onPlay, with the decode)", async (ctx) => {
    const r = await clipRig({ start: 2_400, end: 4_800 });
    if (!r) return ctx.skip();
    r.backend.play({ path: "file.wav", url: "file.wav", loop: true, stream: false, bus: "SFX" });
    await r.step(260);
    expectLoops(r.out, 2_400, 4_800);
    r.backend.dispose();
  });

  it("a oneShot with loop does too", async (ctx) => {
    const r = await clipRig({ start: 2_400, end: 4_800 });
    if (!r) return ctx.skip();
    r.backend.play({ path: "shot.wav", url: "shot.wav", loop: true, oneShot: true, stream: false, bus: "SFX" });
    await r.step(260);
    expectLoops(r.out, 2_400, 4_800);
    r.backend.dispose();
  });

  it("the sidecar's points win over the file's (and a full sidecar is known at once)", async (ctx) => {
    Assets.addSource(Assets.fromObject({ "side.wav.meta.json": { format: "myco.import@1", loopStart: 0.1, loopEnd: 0.15 } }));
    const r = await clipRig({ start: 2_400, end: 4_800 });
    if (!r) return ctx.skip();
    r.backend.play({ path: "side.wav", url: "side.wav", loop: true, stream: false, bus: "SFX" });
    await r.step(260);
    expectLoops(r.out, 4_800, 7_200);
    r.backend.dispose();
  });

  it("no points: the whole clip loops, as before", async (ctx) => {
    const r = await clipRig(null);
    if (!r) return ctx.skip();
    r.backend.play({ path: "plain.wav", url: "plain.wav", loop: true, stream: false, bus: "SFX" });
    await r.step(260);
    expectLoops(r.out, 0, CLIP_FRAMES);
    r.backend.dispose();
  });

  it("an event voice with file loop points gets exactly the runtime's loop, not a second plain one", async (ctx) => {
    const r = await clipRig({ start: 2_400, end: 4_800 });
    if (!r) return ctx.skip();
    const voice = r.backend.play({ path: "ev2.wav", url: "ev2.wav", loop: true, stream: false, bus: "SFX", group: 3 })!;
    r.backend.automation.setLoop(voice, 0.1, 0.15, true); // the runtime's region (4,800..7,200), before the points arrive
    await r.step(260);
    expectLoops(r.out, 4_800, 7_200);
    expect(r.backend.automation.stats.loops).toBe(1);
    r.backend.dispose();
  });

  it("an event voice (a group) is left to the event runtime: no plain-loop region", async (ctx) => {
    const r = await clipRig({ start: 2_400, end: 4_800 });
    if (!r) return ctx.skip();
    r.backend.play({ path: "ev.wav", url: "ev.wav", loop: true, stream: false, bus: "SFX", group: 3 });
    await r.step(260);
    expectLoops(r.out, 0, CLIP_FRAMES);
    r.backend.dispose();
  });
});

// ---- the core, streams: the points arrive after PLAY (`streamOpened`) and splice in like an event's region ----

describe("a plain looping stream on the core uses its loop points (E4.5)", () => {
  const FILE_FRAMES = 2 * RATE;
  const want = (k: number) => signal(k, 0) / 32768;

  it("loops the file's region once the worker reports it, from the first pass", async (ctx) => {
    const r = await rig({ "music/s.wav": withSmpl(makeWav(FILE_FRAMES, 2, RATE, signal), 12_000, 24_000).buffer as ArrayBuffer });
    if (!r) return ctx.skip();
    const voice = r.backend.play({ path: "music/s.wav", url: "", loop: true, stream: true, bus: "Music" })!;
    await r.step(2);
    await r.waitOpen(1);
    await r.step(Math.ceil((1.6 * RATE) / 512));
    let first = 0;
    while (first < r.left.length && r.left[first] === 0) first++;
    let lead = 0;
    while (want(lead) === 0) lead++;
    const at = first - lead;
    expect(at).toBeGreaterThan(0);
    const n = r.left.length - at;
    expect(n).toBeGreaterThan(24_000 + 4 * 12_000);
    for (let k = 0; k < n; k++) if (r.left[at + k] !== want(looped(k, 12_000, 24_000))) expect.fail(`stream frame ${k}`);
    expect(voice.playing).toBe(true);
    r.backend.dispose();
  });

  it("a stream without points loops the whole file", async (ctx) => {
    const r = await rig({ "music/p.wav": makeWav(FILE_FRAMES, 2, RATE, signal) });
    if (!r) return ctx.skip();
    r.backend.play({ path: "music/p.wav", url: "", loop: true, stream: true, bus: "Music" });
    await r.step(2);
    await r.waitOpen(1);
    await r.step(Math.ceil((2.4 * RATE) / 512));
    let first = 0;
    while (first < r.left.length && r.left[first] === 0) first++;
    let lead = 0;
    while (want(lead) === 0) lead++;
    const at = first - lead;
    const n = r.left.length - at;
    expect(n).toBeGreaterThan(FILE_FRAMES + 1_000);
    for (let k = 0; k < FILE_FRAMES + 1_000; k++) if (r.left[at + k] !== want(k % FILE_FRAMES)) expect.fail(`stream frame ${k}`);
    r.backend.dispose();
  });
});

// ---- Babylon (mocked AudioV2) ----

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 0));
}
const req = (extra: Partial<PlayRequest> = {}): PlayRequest => ({ path: "a.wav", url: "asset://a.wav", loop: true, stream: false, bus: "Master", ...extra });
const sound = (i = 0): MockSound & { loopStart?: number; loopEnd?: number } => babylonMock.engine.sounds[i]!;
const live: BabylonBackend[] = [];

function make(): BabylonBackend {
  const context = makeFakeContext("running");
  const backend = new BabylonBackend({ createContext: () => context as unknown as AudioContext, unlockTarget: new EventTarget(), hostContext: () => null });
  live.push(backend);
  backend.configureBuses(mixer);
  backend.applyMix(mixer.resolveAll());
  return backend;
}

describe("a plain looping clip on Babylon uses its loop points (E4.5)", () => {
  beforeEach(() => {
    babylonMock.reset();
    _resetHandleWarningsForTests();
    mixer.configure(parseAudioSettings({ buses: [{ name: "Master" }] }).settings);
  });
  afterEach(() => {
    setAudioBackend(null);
    for (const b of live.splice(0)) b.dispose();
  });

  // 8 kHz file: the mock buffer is 1 s long.
  const looping = (start: number, end: number): string => dataUrl(withSmpl(tinyWav(8_000), start, end));

  it("applies the file's region to the sound", async () => {
    const backend = make();
    backend.play(req({ url: looping(2_000, 6_000) }));
    await flush();
    expect(sound()).toMatchObject({ loopStart: 0.25, loopEnd: 0.75, loop: true });
  });

  it("applies points that arrive after the sound is playing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      await gate;
      return real(input, init);
    });
    const backend = make();
    backend.play(req({ url: looping(2_000, 6_000) }));
    await flush();
    expect(sound().loop).toBe(true);
    expect(sound().loopStart).toBeUndefined();
    release();
    await flush();
    expect(sound()).toMatchObject({ loopStart: 0.25, loopEnd: 0.75, loop: true });
  });

  it("the sidecar wins over the file", async () => {
    Assets.addSource(Assets.fromObject({ "a.wav.meta.json": { format: "myco.import@1", loopStart: 0.1, loopEnd: 0.4 } }));
    const backend = make();
    backend.play(req({ url: looping(2_000, 6_000) }));
    await flush();
    expect(sound()).toMatchObject({ loopStart: 0.1, loopEnd: 0.4, loop: true });
  });

  it("clamps an end past the buffer to its duration", async () => {
    const backend = make();
    backend.play(req({ url: looping(2_000, 20_000) })); // 2.5 s in a 1 s buffer
    await flush();
    expect(sound()).toMatchObject({ loopStart: 0.25, loopEnd: 1, loop: true });
  });

  it("no points: the whole clip loops (no region set)", async () => {
    const backend = make();
    backend.play(req({ url: dataUrl(new Uint8Array(tinyWav(8_000))) }));
    await flush();
    expect(sound().loop).toBe(true);
    expect(sound().loopStart).toBeUndefined();
    expect(sound().loopEnd).toBeUndefined();
  });

  it("an event's setLoop wins over the clip's points, and a voice that ended first is left alone", async () => {
    const backend = make();
    const v = backend.play(req({ url: looping(2_000, 6_000) }))!;
    v.setLoop!(0.5, 0.6, true);
    await flush();
    expect(sound()).toMatchObject({ loopStart: 0.5, loopEnd: 0.6 });
    babylonMock.engine.sounds.length = 0;
    const gone = backend.play(req({ path: "b.wav", url: looping(2_000, 6_000) }))!;
    gone.stop();
    await flush();
    expect(gone.playing).toBe(false);
  });

  it("an event voice (a group) gets no plain-clip region from its file's points", async () => {
    const backend = make();
    backend.play(req({ url: looping(2_000, 6_000), group: 3 }));
    await flush();
    expect(sound().loop).toBe(true);
    expect(sound().loopStart).toBeUndefined();
    expect(sound().loopEnd).toBeUndefined();
  });

  it("a streamed clip loops whole and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = make();
    backend.play(req({ stream: true, url: looping(2_000, 6_000) }));
    await flush();
    expect(sound().loop).toBe(true);
    expect(sound().loopStart).toBeUndefined();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("loops whole"))).toHaveLength(1);
  });
});

// ---- selection vs the ramp (decision 14) ----

describe("selection sees a fading voice at its smoothed gain until the fade ends (E4.5)", () => {
  const SR = 48_000;
  function setup() {
    const table = new VoiceTable(8);
    const id = table.allocate(0, 128, 0, VoiceState.PLAYING);
    const i = id & 0xffff;
    const state = { now: 0 };
    const deps = {
      table,
      writer: { automate() {}, param() {}, curves() {}, busAutomate() {}, setLoop() {} },
      clockMap: { framesNow: () => state.now, lookaheadFrames: () => 0, sampleRate: SR },
      playheads: { positionNow: () => 0, start() {}, retime() {} },
      clipInfo: () => null,
      busIndex: () => 0,
      sending: () => true,
    } as unknown as CoreAutomationDeps;
    const auto = new CoreAutomation(deps);
    const voice = { id } as unknown as AudioVoice;
    // The runtime's contract: a curve 0..1 over the parameter, a global parameter bound to gain.
    auto.defineCurve(0, [[0, 0], [1, 1]]);
    auto.setParam(0, 0, 1, 0);
    auto.bindVoice(voice, 0, [{ param: { global: true, slot: 0 }, curve: 0, target: 0 /* AutoTarget.Gain */ }], { volume: 1, pitch: 1 });
    return { auto, table, i, state };
  }

  it("a voice fading to 0 stays audible while the fade runs and drops when it ends", () => {
    const { auto, table, i, state } = setup();
    expect(table.autoGain[i]).toBeCloseTo(1);
    auto.setParam(0, 0, 0, 2); // 1 -> 0 at 2 per second: 0.5 s
    expect(table.autoGain[i]).toBeCloseTo(1); // not 0: selection must not demote it at once
    for (const t of [0.1, 0.25, 0.45]) {
      state.now = Math.round(t * SR);
      auto.beginFrame();
      expect(table.autoGain[i]).toBeCloseTo(1 - 2 * t, 2);
      expect(table.autoGain[i]!).toBeGreaterThan(0);
    }
    state.now = Math.round(0.5 * SR);
    auto.beginFrame();
    expect(table.autoGain[i]).toBe(0);
    state.now = SR;
    auto.beginFrame();
    expect(table.autoGain[i]).toBe(0);
  });

  it("a fade up counts at its target at once, and a jump (no seek) is the target", () => {
    const { auto, table, i } = setup();
    auto.setParam(0, 0, 0, 0);
    expect(table.autoGain[i]).toBe(0);
    auto.setParam(0, 0, 1, 2);
    expect(table.autoGain[i]).toBeCloseTo(1);
    auto.setParam(0, 0, 0, 0);
    expect(table.autoGain[i]).toBe(0);
  });
});

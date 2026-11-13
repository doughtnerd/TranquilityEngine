// ADR 0171 amended by 0172 (Mx2; architecture §4.5, §3.4; api-and-models §4.2): the lane writer on the real wasm (the
// loopback host, the test-hooks build so a trap can be simulated), timed on the audio clock. A `fadeTo` lands on its
// stamp: the first rendered sample that changes is at the stamped frame, and the target is reached `frames` later, with
// no quantum split and no record applied early; a rebuild mid-fade continues the remaining ramp; MASTER through the
// output's runtime lane.
import { fakeDecoder } from "./fakeDecoder";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { createClipRegistry } from "./clipRegistry";
import { AudioHost, presetFromSettings } from "./context";
import { createCoreBackend, type CoreBackend } from "./coreBackend";
import { watchForTraps } from "./recovery";
import { Unlock, type UnlockContext } from "./unlock";

const RATE = 48_000;
const CLIP_FRAMES = 48_000;
const LEVEL = 0.5;
const req = (path: string, extra: object = {}) => ({ path, url: path, loop: true, stream: false, bus: "SFX", ...extra });

const hosts: AudioHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  vi.restoreAllMocks();
});

function fakeContext() {
  const ctx = {
    state: "running",
    sampleRate: RATE,
    destination: {},
    resume: () => Promise.resolve(),
    close: () => {
      ctx.state = "closed";
      return Promise.resolve();
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return ctx;
}

/** The real host and core backend on the loopback, a constant 0.5 clip, the limiter's look-ahead 0 so output frames are core frames. */
async function rig() {
  const testing = await import("../testing");
  const preset = { ...presetFromSettings(defaultAudioSettings()), limiterLookaheadMs: 0 };
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
  try {
    loop = await testing.createLoopbackHost({ testHooks: true, preset });
  } catch {
    return null;
  }
  const context = fakeContext();
  const node = Object.assign(new EventTarget(), { connect() {}, disconnect() {} }) as unknown as AudioWorkletNode;
  const unlock = new Unlock({ target: new EventTarget(), context: context as unknown as UnlockContext });
  const host = AudioHost._create({ context: context as unknown as AudioContext, node, link: loop.link, unlock, preset, respawn: () => loop.respawn() });
  hosts.push(host);
  const link = loop.link;
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (path) => new TextEncoder().encode(path).buffer as ArrayBuffer,
    decodeWorker: fakeDecoder(() => ({ frames: CLIP_FRAMES, channels: 1, sampleRate: RATE, channelData: [new Float32Array(CLIP_FRAMES).fill(LEVEL)] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const mixer = new Mixer(defaultAudioSettings());
  const backend: CoreBackend = createCoreBackend(host, { clips, clock: loop.clock, mixer });
  watchForTraps(host, { now: () => 0, warn: () => {} });
  const settle = async () => {
    for (let k = 0; k < 8; k++) await Promise.resolve();
  };
  /** Rendered left samples with the core frame of the first, over `n` frames of 4 quanta. */
  const step = async (n: number) => {
    const start = loop.frame;
    const out: number[] = [];
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      const { left } = loop.renderQuanta(4);
      for (const v of left) out.push(v);
      await settle();
    }
    return { start, out, last: out[out.length - 1]! };
  };
  return { loop, host, backend, mixer, step };
}

/** SFX's index in the default tree (Master, Music, SFX, Voice, UI). */
const SFX = 2;

describe("the lane writer on the loopback host (Mx2)", () => {
  it("a fadeTo lands on its stamp: the first changed sample is the stamped frame, the target `frames` later; splitQuanta 0", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, mixer, step } = r;
    backend.play(req("const.wav"));
    await step(10);
    expect((await step(1)).last).toBe(LEVEL);
    const lateBefore = backend.mirror.lateCommands;
    const frameAtCall = r.loop.frame;
    mixer.bus("SFX").fadeTo(0.5, 0.05); // 2,400 frames
    const run = await step(60);
    const stamp = backend.lanes.lastRampStartFrame(SFX)!;
    expect(stamp).toBeDefined();
    expect(stamp, "stamped ahead of the core's frame at the call").toBeGreaterThan(frameAtCall);
    expect(backend.debug().buses[SFX]!.lastRampStartFrame).toBe(stamp);
    const at = (frame: number) => run.out[frame - run.start]!;
    const firstChanged = run.start + run.out.findIndex((v) => v !== LEVEL);
    expect(firstChanged, "the fade starts on its stamped frame").toBe(stamp);
    expect(at(stamp - 1)).toBe(LEVEL);
    // Linear over exactly 2,400 frames from the stamp (sample k of the ramp is its (k + 1)th step): the target at its
    // 2,400th sample, stamp + 2,399, not one before.
    expect(at(stamp + 2_398)).toBeGreaterThan(LEVEL * 0.5);
    expect(at(stamp + 2_399)).toBeCloseTo(LEVEL * 0.5, 6);
    expect(at(stamp + 2_400)).toBeCloseTo(LEVEL * 0.5, 6);
    expect(at(stamp + 1_199)).toBeCloseTo(LEVEL * 0.75, 4);
    expect(run.last).toBeCloseTo(LEVEL * 0.5, 6);
    // Applied as a stamp: no quantum split, nothing applied early, nothing late.
    expect(backend.mirror.splitQuanta).toBe(0);
    expect(backend.mirror.busRecordsEarly).toBe(0);
    expect(backend.mirror.lateCommands).toBe(lateBefore);
    // The main side agrees once the fade is over.
    expect(mixer.bus("SFX").volume).toBe(0.5);
    backend.dispose();
  });

  it("a volume set goes asap (no stamp); MASTER rides the output's runtime lane, muted is 0", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, mixer, step } = r;
    backend.play(req("const.wav"));
    await step(10);
    mixer.bus("SFX").volume = 0.5;
    backend.masterVolume = 0.5;
    await step(4);
    expect((await step(1)).last).toBeCloseTo(LEVEL * 0.25, 6);
    expect(backend.lanes.lastRampStartFrame(SFX)).toBeUndefined();
    backend.muted = true;
    await step(4);
    expect((await step(1)).last).toBe(0);
    backend.muted = false;
    await step(4);
    expect((await step(1)).last).toBeCloseTo(LEVEL * 0.25, 6);
    backend.dispose();
  });

  it("a rebuild mid-fade continues the remaining ramp on the new core, landing on the target", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { loop, backend, mixer, step } = r;
    backend.play(req("const.wav"));
    await step(10);
    mixer.bus("SFX").fadeTo(0, 1); // 48,000 frames
    await step(30); // about 0.3 s of it
    const before = (await step(1)).last;
    expect(before).toBeLessThan(LEVEL * 0.8);
    expect(before).toBeGreaterThan(LEVEL * 0.6);
    loop.trapNext();
    let resumed = -1;
    for (let f = 0; f < 60 && resumed < 0; f++) {
      const s = await step(1);
      if (s.last !== 0) resumed = s.last;
    }
    expect(resumed, "sound again on the new core").toBeGreaterThan(0);
    expect(r.host.health.recoveries).toBe(1);
    // From here the new core runs the replayed remaining ramp itself: main sends no further bus ramp.
    const ramps = vi.spyOn(backend.writer, "busRampFrames");
    // Neither back at the fade's start nor jumped to its end: where main's ramp is now, on the heard clock.
    const now = await step(1);
    const expected = mixer.bus("SFX").volume * LEVEL;
    expect(now.last).toBeLessThan(before);
    expect(now.last).toBeGreaterThan(0);
    expect(Math.abs(now.last - expected)).toBeLessThan(0.02);
    // Still falling, linearly, and it lands on 0 when the original fade ends (within the replay's estimate).
    const later = await step(10);
    expect(later.last).toBeLessThan(now.last);
    const rest = await step(80);
    expect(rest.last).toBe(0);
    expect(mixer.bus("SFX").volume).toBe(0);
    expect(ramps).not.toHaveBeenCalled();
    backend.dispose();
  });
});

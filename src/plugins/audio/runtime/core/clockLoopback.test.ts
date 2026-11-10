// A3.2's acceptance check (api-and-models §9: "`at` lands within one quantum in loopback"), plus late counting and a
// far-future `at`, on the real wasm, the real clip registry, shell routing and `CoreBackend`, timed by the fake
// `HostClock` the loopback host advances by one quantum per rendered quantum.
//
// Under the fake clock the output timestamp is {contextTime: currentTime, performanceTime: rafTime}, so the heard clock
// is the context clock and Λ is 0: `Audio.time` = currentTime and F_now = the loopback's frame. A clock started
// behind the loopback's frame makes the host's F_now lag the core, which is how a stamped record arrives late here
// (the loopback itself delivers every batch one quantum after it is posted).
//
// A2.9: the core's output is the master limiter's look-ahead D frames late (72 at 48 kHz for the default 1.5 ms, 0 for
// 0 ms), so the frame where sound first appears in the output is the heard frame, D after the core frame it was
// rendered at. `Audio.time` is the heard clock in core frames, so at the heard frame h it reads (h − D) / sr: an `at`
// lands exactly when the first sound is heard at round(at·sr) + D. Every case runs with 1.5 ms and with 0 ms.
import { fakeDecoder } from "./fakeDecoder";
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { limiterLatencyFrames } from "./limiterLatency";
import { QUANTUM_FRAMES } from "../wire.generated";
import type { AudioHost } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import type { FakeHostClock } from "./hostClock";

const SR = 48_000;
const QUANTUM_S = QUANTUM_FRAMES / SR;

const req = (path: string, extra: object = {}) => ({ path, url: path, loop: false, stream: false, bus: "SFX", oneShot: true, ...extra });

async function rig(lookaheadMs: number, clock?: FakeHostClock) {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
  const preset = { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: lookaheadMs };
  try {
    loop = await testing.createLoopbackHost(clock ? { clock, preset } : { preset });
  } catch {
    return null;
  }
  const { createClipRegistry } = await import("./clipRegistry");
  const link = loop.link;
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async () => new ArrayBuffer(8),
    // 0.1 s of a constant 0.5: the first non-zero sample is the voice's first frame.
    decodeWorker: fakeDecoder(async () => ({ frames: 4_800, channels: 1, sampleRate: SR, channelData: [new Float32Array(4_800).fill(0.5)] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 256, limiterLookaheadMs: lookaheadMs },
    worldCount: 1,
    sampleRate: SR,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const mixer = new Mixer(defaultAudioSettings());
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  // STATUS blocks are decoded into one reused block: copy what the tests read.
  const slack: number[] = [];
  const lateness: number[] = [];
  link.onStatus((s) => {
    slack.push(s.minSlackFrames);
    lateness.push(s.maxLatenessFrames);
  });

  /** One engine frame per quantum: the audio system's update, then one quantum. Returns where sound first appears (absolute frame) or -1. */
  const step = async (quanta: number): Promise<number> => {
    let first = -1;
    for (let q = 0; q < quanta; q++) {
      backend.update(QUANTUM_S);
      const start = loop.frame;
      const { left, right } = loop.renderQuanta(1);
      if (first < 0) {
        for (let i = 0; i < left.length; i++) {
          if (left[i] !== 0 || right[i] !== 0) {
            first = start + i;
            break;
          }
        }
      }
      await Promise.resolve();
    }
    return first;
  };

  /** Loads `path` into the core and waits until it is resident, so a later play starts without waiting for data. */
  const preload = async (path: string) => {
    const id = clips.acquire(path, 0);
    for (let q = 0; q < 200 && clips.info(id)?.state !== "ready"; q++) await step(1);
    expect(clips.info(id)?.state).toBe("ready");
  };
  return { loop, backend, clips, step, preload, slack, lateness };
}

describe.each([1.5, 0])("`at` on the loopback host (A3.2), limiter look-ahead %s ms", (ms) => {
  /** The core's output latency: 72 frames at 1.5 ms, 0 at 0 ms. */
  const D = limiterLatencyFrames(SR, ms);

  it("the latency is the look-ahead in frames, and the clock map knows it", async (ctx) => {
    const r = await rig(ms);
    if (!r) return ctx.skip();
    expect(D).toBe(ms === 0 ? 0 : 72);
    expect(r.backend.clockMap.outputLatencyFrames).toBe(D);
    r.backend.dispose();
  });

  it("a PLAY `at` a time a few quanta ahead starts within one quantum of its frame (exactly on it, in fact)", async (ctx) => {
    const r = await rig(ms);
    if (!r) return ctx.skip();
    const { backend, step, preload, loop } = r;
    await preload("tone.wav");
    expect(await step(4)).toBe(-1);
    // Under the fake clock the heard clock is the loopback's frame (Λ = 0).
    expect(backend.clockMap.leadFrames).toBe(0);
    for (const ahead of [3.3, 5.75, 9.01]) {
      backend.update(QUANTUM_S);
      const now = backend.time;
      // The heard clock: the frame at the output, less the core's latency.
      expect(Math.abs(now * SR - (loop.frame - D))).toBeLessThan(1e-6 * SR);
      const at = now + (ahead * QUANTUM_FRAMES) / SR;
      const target = Math.round(at * SR);
      const voice = backend.play(req("tone.wav", { at }))!;
      expect(voice.playing).toBe(true);
      const first = await step(Math.ceil(ahead) + 3);
      expect(first).toBeGreaterThan(0);
      // Rendered on its frame, heard D later, when Audio.time reads `at`.
      expect(Math.abs(first - D - target)).toBeLessThanOrEqual(QUANTUM_FRAMES);
      expect(first).toBe(target + D);
      // Audio.time when that frame is heard is `at`, to the frame.
      expect(Math.abs((first - D) / SR - at)).toBeLessThanOrEqual(0.5 / SR);
      voice.stop();
      await step(4);
    }
    expect(loop.statuses.at(-1)!.lateCommands).toBe(0);
    backend.dispose();
  });

  it("an `at` in the past plays asap and is not counted late", async (ctx) => {
    const r = await rig(ms);
    if (!r) return ctx.skip();
    const { backend, step, preload, loop } = r;
    await preload("tone.wav");
    backend.update(QUANTUM_S);
    const frame = loop.frame;
    backend.play(req("tone.wav", { at: backend.time - 0.5 }));
    const first = await step(4);
    // Posted in this frame, delivered after one quantum, applied at the start of the next; heard D later.
    expect(first).toBe(frame + QUANTUM_FRAMES + D);
    await step(12);
    expect(loop.statuses.at(-1)!.lateCommands).toBe(0);
    backend.dispose();
  });

  it("a far-future `at` waits, playing silently, then starts on its frame", async (ctx) => {
    const r = await rig(ms);
    if (!r) return ctx.skip();
    const { backend, step, preload } = r;
    await preload("tone.wav");
    backend.update(QUANTUM_S);
    const at = backend.time + 1.0;
    const voice = backend.play(req("tone.wav", { at }))!;
    // Half a second: nothing yet, and the voice exists the whole time.
    expect(await step(Math.round((0.5 * SR) / QUANTUM_FRAMES))).toBe(-1);
    expect(voice.playing).toBe(true);
    const first = await step(Math.round((0.6 * SR) / QUANTUM_FRAMES));
    expect(first).toBe(Math.round(at * SR) + D);
    backend.dispose();
  });

  it("a stamped record that arrives after its frame starts at once and counts in lateCommands and maxLatenessFrames", async (ctx) => {
    const testing = await import("./hostClock");
    // The host's clock runs 480 frames (10 ms) behind the core: its F_now lags, so a stamp 200 frames past it is
    // already 280 frames behind the core's frame when sent (and one quantum more when it arrives).
    const clock = testing.fakeHostClock({ currentTime: -0.01 });
    const r = await rig(ms, clock);
    if (!r) return ctx.skip();
    const { backend, step, preload, loop, slack, lateness } = r;
    await preload("tone.wav");
    await step(6);
    const lateBefore = loop.statuses.at(-1)!.lateCommands;
    expect(Math.max(...lateness)).toBe(0);
    slack.length = 0;
    backend.update(QUANTUM_S);
    const frame = loop.frame;
    // 200 frames past F_now: Audio.time is D frames behind F_now's clock (the latency), so add it back.
    const at = backend.time + (200 + D) / SR;
    expect(Math.round(at * SR)).toBe(frame - 280);
    backend.play(req("tone.wav", { at }));
    const first = await step(12);
    // Applied at offset 0 of the quantum it reached (one quantum after posting), not skipped ahead; heard D later.
    expect(first).toBe(frame + QUANTUM_FRAMES + D);
    const status = loop.statuses.at(-1)!;
    expect(status.lateCommands).toBe(lateBefore + 1);
    // 280 frames late when sent, plus the quantum it waited for delivery.
    expect(Math.max(...lateness)).toBe(280 + QUANTUM_FRAMES);
    expect(backend.debug().core.maxLatenessFrames).toBe(0); // the newest block's, and it has gone by
    // The block that carried it has the lateness; asap batches since have none (the counters are per block).
    expect(Math.min(...slack)).toBeLessThan(0);
    expect(Math.min(...slack)).toBe(frame - 280 - (frame + QUANTUM_FRAMES));
    backend.dispose();
  });

  it("asap batches report a positive minSlackFrames: about L minus the one-quantum delivery", async (ctx) => {
    const r = await rig(ms);
    if (!r) return ctx.skip();
    const { backend, step, preload, slack } = r;
    await preload("tone.wav");
    // A steady 128-frame interval: Δ̄ ≈ 2.67 ms, so L is its 1,024-frame floor.
    await step(60);
    expect(backend.clockMap.lookaheadFrames()).toBe(1024);
    slack.length = 0;
    const voice = backend.play(req("tone.wav", { loop: true }));
    await step(12);
    voice?.stop();
    await step(12);
    const seen = slack.filter((s) => s !== 0);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s).toBe(1024 - QUANTUM_FRAMES);
    backend.dispose();
  });
});

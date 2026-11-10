// A3.7 end to end: a voice's `pause()` / `resume()` on the core backend over the loopback host (the real wasm, clip
// registry, shell and coreBackend). The clip is a ramp (sample k = k / 200,000), so the output says which clip frame
// is playing: a paused voice fades out over 5 ms, is silent and holds while paused, and after `resume()` fades in from
// exactly the frame it held (not from where a virtual voice, which keeps time, would be). A voice paused before its
// clip was resident waits on the core and starts from its beginning when resumed.
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import type { AudioHost, CoreLink } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import { DWELL_FRAMES } from "./selection";

const SCALE = 200_000;
const CLIP_FRAMES = 96_000;
/** The promote, demote and pause fade: 5 ms at 48 kHz. */
const FADE = 240;
const TOL = 1e-6;

const clipAt = (k: number): number => Math.fround(k / SCALE);
/** The core's ramp at frame `k` of an `n`-frame ramp from `a` to `b`. */
const rampAt = (a: number, b: number, n: number, k: number): number => (k + 1 >= n ? b : a + ((b - a) * (k + 1)) / n);

async function rig() {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    // No limiter look-ahead: output frames are core frames.
    loop = (await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } })) as typeof loop;
  } catch {
    return null;
  }
  const { createClipRegistry } = await import("./clipRegistry");
  const link = loop.link;
  const ramp = Float32Array.from({ length: CLIP_FRAMES }, (_, k) => k / SCALE);
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async () => new ArrayBuffer(8),
    decode: async () => ({ frames: CLIP_FRAMES, channels: 1, sampleRate: 48_000, channelData: [ramp] }),
    clipFormat: 0,
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
  const mixer = new Mixer(defaultAudioSettings());
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  const out: number[] = [];
  /** `n` frames of 4 quanta; the left channel is appended to `out`. */
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      const { left } = loop.renderQuanta(4);
      for (const s of left) out.push(s);
      await Promise.resolve();
    }
  };
  return { backend, step, out };
}

/** Expects `out[from + k]` to be `want(k)` for `k < n`. */
function expectFrames(out: number[], from: number, n: number, want: (k: number) => number, what: string): void {
  for (let k = 0; k < n; k++) {
    const got = out[from + k]!;
    if (Math.abs(got - want(k)) > TOL) expect.fail(`${what}: frame ${k} (output ${from + k}): ${got}, expected ${want(k)}`);
  }
}

describe("pause and resume on the loopback host (A3.7)", () => {
  it("resume() continues from the paused position, with 5 ms fades out and in", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, step, out } = r;
    const voice = backend.play({ path: "ramp.wav", url: "ramp.wav", loop: false, stream: false, bus: "SFX" })!;
    await step(6);
    // Playing: out[j] = clipAt(j - start).
    const first = out.findIndex((s) => s !== 0); // clip frame 1 (frame 0 is 0)
    expect(first).toBeGreaterThan(0);
    const start = first - 1;
    expectFrames(out, first, out.length - first, (k) => clipAt(1 + k), "playing");

    voice.pause();
    const pausedAt = out.length;
    await step(DWELL_FRAMES + 20); // far longer than the fade: a voice keeping time would move on 40,000+ frames
    // The 5 ms fade-out starts with the quantum after the pause's batch, then silence.
    let tail = pausedAt;
    while (Math.abs(out[tail]! - clipAt(tail - start)) <= TOL) tail++;
    expectFrames(out, tail, FADE, (k) => clipAt(tail - start + k) * rampAt(1, 0, FADE, k), "fade-out");
    expectFrames(out, tail + FADE, out.length - tail - FADE, () => 0, "paused");
    const held = tail - start + FADE; // the clip frame the voice holds at
    expect(voice.playing).toBe(true);

    voice.resume();
    const resumedAt = out.length;
    await step(4);
    const onset = out.findIndex((s, j) => j >= resumedAt && s !== 0);
    expect(onset).toBeGreaterThanOrEqual(resumedAt);
    // From the held frame, faded in over 5 ms, then the clip from there.
    expectFrames(out, onset, 2_000, (k) => clipAt(held + k) * rampAt(0, 1, FADE, k), "resumed");
    expect(voice.reason).toBeNull();
    backend.dispose();
  });

  it("a voice paused before its clip was resident waits on the core and starts from its beginning on resume()", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, step, out } = r;
    const voice = backend.play({ path: "ramp.wav", url: "ramp.wav", loop: false, stream: false, bus: "SFX" })!;
    voice.pause(); // still loading: nothing is on the core yet
    await step(DWELL_FRAMES + 10);
    expect(out.every((s) => s === 0)).toBe(true);
    expect(backend.mirror.liveVoices).toBe(1);
    voice.resume();
    const resumedAt = out.length;
    await step(4);
    const first = out.findIndex((s, j) => j >= resumedAt && s !== 0);
    expect(first).toBeGreaterThanOrEqual(resumedAt);
    // A voice not started yet starts at its gain (a clean onset, no fade) from clip frame 0.
    expectFrames(out, first, 2_000, (k) => clipAt(1 + k), "started on resume");
    backend.dispose();
  });
});

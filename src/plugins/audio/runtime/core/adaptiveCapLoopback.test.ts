// A3.3 acceptance (api-and-models §9: "cap drops and recovers in a loaded loopback"): the core backend on the loopback
// host (the real wasm, shell, clip registry and selection). Load is a wall-clock jump the shell's underrun probe counts
// (the render fell behind the wall clock by more than 24 ms); the probe tells the core (ABI 1.2), whose adaptive cap
// drops at once and demotes the lowest-score voices itself. STATUS carries `mixedCap` and `demoted`, selection runs at
// the lower cap without promoting past it, `Audio.debug()` shows the cap, and after 5 s of calm the cap climbs back
// once a second and selection re-promotes.
import { fakeDecoder } from "./fakeDecoder";
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import type { AudioHost, CoreLink } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";

const req = (path: string, extra: object = {}) => ({ path, url: path, loop: true, stream: false, bus: "SFX", ...extra });

/** Quanta per frame and frames per second in this rig (4 quanta of 128 at 48 kHz ≈ 10.7 ms). */
const QUANTA_PER_FRAME = 4;
const FRAMES_PER_SECOND = Math.round(48_000 / 128 / QUANTA_PER_FRAME);

async function rig(maxMixed: number) {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, maxMixed } })) as typeof loop;
  } catch {
    return null;
  }
  const { createClipRegistry } = await import("./clipRegistry");
  const link = loop.link;
  const frames = 48_000;
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async () => new ArrayBuffer(8),
    decodeWorker: fakeDecoder(async () => ({ frames, channels: 1, sampleRate: 48_000, channelData: [new Float32Array(frames).fill(0.5)] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 64, maxMixed },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const mixer = new Mixer(defaultAudioSettings());
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  /** `n` frames; returns the last quantum's left level. */
  const step = async (n: number) => {
    let level = NaN;
    for (let f = 0; f < n; f++) {
      mixer.update(0.01);
      backend.update(0.01);
      const { left } = loop.renderQuanta(QUANTA_PER_FRAME);
      level = left[left.length - 1]!;
      await Promise.resolve();
    }
    return level;
  };
  /** The render falls `ms` behind the wall clock (the context clock stands still meanwhile): one underrun. */
  const stall = (ms: number) => {
    loop.clock.setRunning(false);
    loop.clock.advance(ms);
    loop.clock.setRunning(true);
  };
  return { loop, backend, step, stall };
}

describe("the adaptive mixed-voice cap on the loopback host (A3.3)", () => {
  it("drops on an underrun, demotes the quietest voices in the core, and recovers after the load ends", { timeout: 60_000 }, async (ctx) => {
    const r = await rig(40);
    if (!r) return ctx.skip();
    const { backend, step, stall, loop } = r;
    // 40 voices, voice k at volume k/1600 (all under the limiter; scores rank them by volume).
    const voices = Array.from({ length: 40 }, (_, k) => backend.play(req("v.wav", { volume: (k + 1) / 1600 }))!);
    const full = 0.5 * (40 * 41) / 2 / 1600;
    // The probe warms up for 1 s; the cap holds at the configured 40 meanwhile.
    expect(await step(FRAMES_PER_SECOND + 10)).toBeCloseTo(full, 5);
    expect(backend.mirror.mixedCap).toBe(40);
    expect(backend.mixedCap()).toBe(40);
    expect(backend.debug().counters.mixedCap).toBe(40);
    expect(backend.mirror.mixedVoices).toBe(40);

    // Load: the render falls 60 ms behind. The next STATUS shows the underrun, the cut and the demotes.
    stall(60);
    const underrunsBefore = backend.mirror.underruns;
    await step(15); // no batches while nothing changes, so STATUS comes every 48 quanta (12 frames)
    expect(backend.mirror.underruns).toBe(underrunsBefore + 1);
    expect(backend.mirror.mixedCap).toBe(34); // floor(0.85 * 40)
    expect(backend.mixedCap()).toBe(34);
    expect(backend.debug().counters.mixedCap).toBe(34);
    expect(loop.link.lastStatus!.flags & (1 << 3)).not.toBe(0); // "adaptive cap active"
    expect(backend.mirror.mixedVoices).toBe(34);
    // The six quietest went virtual (in time, silent); the table followed the core's `demoted`.
    expect(voices.slice(0, 6).map((v) => v.reason)).toEqual(Array(6).fill("virtual"));
    expect(voices.slice(6).every((v) => v.reason === null)).toBe(true);
    const capped = 0.5 * ((40 * 41) / 2 - (6 * 7) / 2) / 1600;
    expect(await step(3)).toBeCloseTo(capped, 5);

    // Selection respects the lower cap: a voice made loud replaces a quiet one, never adds one.
    voices[0]!.setVolume(0.02);
    await step(5);
    expect(backend.mirror.mixedVoices).toBe(34);
    expect(voices[0]!.reason).toBeNull();
    expect(voices[6]!.reason).toBe("virtual");
    voices[0]!.setVolume(1 / 1600);

    // The load ends: 5 s of calm, then +2 a second (max(2, 40/32)) back to 40, and selection re-promotes.
    const caps: number[] = [];
    for (let s = 0; s < 9; s++) {
      await step(FRAMES_PER_SECOND);
      caps.push(backend.mirror.mixedCap);
    }
    expect(caps.slice(0, 4).every((c) => c === 34)).toBe(true);
    expect(caps[caps.length - 1]).toBe(40);
    for (let k = 1; k < caps.length; k++) expect(caps[k]! - caps[k - 1]!).toBeLessThanOrEqual(2);
    await step(10);
    expect(backend.mirror.mixedVoices).toBe(40);
    expect(loop.link.lastStatus!.flags & (1 << 3)).toBe(0);
    expect(voices.every((v) => v.reason === null)).toBe(true);
    expect(await step(1)).toBeCloseTo(full, 5);
    backend.dispose();
  });

  it("sends score updates only for mixed voices whose audibility moved more than 3 dB, so the core demotes the right ones", { timeout: 60_000 }, async (ctx) => {
    const r = await rig(8);
    if (!r) return ctx.skip();
    const { backend, step } = r;
    const voices = Array.from({ length: 8 }, (_, k) => backend.play(req("s.wav", { volume: 0.01 * (k + 1) }))!);
    await step(10);
    // The loudest becomes the quietest: its score must follow, or the core would keep it over others.
    const sent: number[] = [];
    const sink = backend.selection;
    const before = Array.from(sink.sentScore.slice(0, 64));
    voices[7]!.setVolume(0.001);
    voices[3]!.setVolume(0.04 * 1.1); // +0.8 dB: no update
    await step(2);
    for (let i = 0; i < 64; i++) if (sink.sentScore[i] !== before[i]) sent.push(i);
    expect(sent).toEqual([voices[7]!.id & 0xffff]);
    expect(sink.sentScore[voices[7]!.id & 0xffff]).toBeCloseTo(backend.table.audibility[voices[7]!.id & 0xffff]!, 6);
    backend.dispose();
  });
});

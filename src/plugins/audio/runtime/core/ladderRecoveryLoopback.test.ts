// ADR 0170 acceptance: the load-shedding ladder recovers once underruns stop, on the loopback host (the real wasm,
// shell and debug view). Load is a wall-clock jump the shell's underrun probe counts, as in
// `adaptiveCapLoopback.test.ts`: stalls every half second walk the adaptive cap from its preset down to its floor of 16,
// then a second more at the floor takes the ladder's bed-idle step. Once the stalls stop, `Audio.debug()` reads
// "recovering", the cap climbs back to its preset, and after 20 s without an underrun the step comes back: the ladder
// reads "idle" and counts one step given back.
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import type { AudioHost, CoreLink } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import { createClipRegistry } from "./clipRegistry";
import { fakeDecoder } from "./fakeDecoder";

/** Quanta per frame and frames per second in this rig (4 quanta of 128 at 48 kHz ≈ 10.7 ms). */
const QUANTA_PER_FRAME = 4;
const FRAMES_PER_SECOND = Math.round(48_000 / 128 / QUANTA_PER_FRAME);
const MAX_MIXED = 32;

async function rig() {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    // One bed slot, so the ladder has its bed-idle step (no bed needs to be configured for it).
    loop = (await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, maxMixed: MAX_MIXED, maxBeds: 1 } })) as typeof loop;
  } catch {
    return null;
  }
  const link = loop.link;
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async () => new ArrayBuffer(8),
    decodeWorker: fakeDecoder(async () => ({ frames: 480, channels: 1, sampleRate: 48_000, channelData: [new Float32Array(480)] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 64, maxMixed: MAX_MIXED, maxBeds: 1 },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const mixer = new Mixer(defaultAudioSettings());
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      mixer.update(0.01);
      backend.update(0.01);
      loop.renderQuanta(QUANTA_PER_FRAME);
      await Promise.resolve();
    }
  };
  /** The render falls `ms` behind the wall clock (the context clock stands still meanwhile): one underrun. */
  const stall = (ms: number) => {
    loop.clock.setRunning(false);
    loop.clock.advance(ms);
    loop.clock.setRunning(true);
  };
  return { backend, step, stall };
}

describe("the load-shedding ladder on the loopback host (ADR 0170)", () => {
  it("sheds under sustained underruns, then gives its step back and the cap returns to its preset once they stop", { timeout: 120_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, step, stall } = r;
    const ladder = () => backend.debug().core;
    // The probe warms up for 1 s.
    await step(FRAMES_PER_SECOND + 10);
    expect([backend.mirror.mixedCap, ladder().ladderState, ladder().ladderRecoveries]).toEqual([MAX_MIXED, "idle", 0]);

    // Underruns every half second until the ladder takes a step (the cap reaches its floor first).
    let stalls = 0;
    while (backend.mirror.m3Shed === 0) {
      expect(++stalls, "the ladder steps within 20 s of underruns").toBeLessThan(40);
      stall(60);
      await step(FRAMES_PER_SECOND / 2);
    }
    expect(backend.mirror.mixedCap).toBe(16);
    expect(backend.mirror.m3Shed).toBe(1);
    expect(ladder().ladderState).toBe("shedding (1 step)");

    // Clean from here: "recovering" after a second, the cap back at its preset well before the step comes back.
    await step(2 * FRAMES_PER_SECOND);
    expect(ladder().ladderState).toBe("recovering (1 step)");
    await step(14 * FRAMES_PER_SECOND);
    expect(backend.mirror.mixedCap).toBe(MAX_MIXED);
    expect(backend.mirror.m3Shed).toBe(1);
    // 20 s after the last underrun the step comes back (STATUS every 48 quanta while nothing changes).
    await step(5 * FRAMES_PER_SECOND);
    expect([backend.mirror.m3Shed, backend.mirror.mixedCap]).toEqual([0, MAX_MIXED]);
    expect([ladder().ladderState, ladder().ladderRecoveries]).toEqual(["idle", 1]);
    expect(backend.debug().counters.m3Shed).toBe(0);
    backend.dispose();
  });
});

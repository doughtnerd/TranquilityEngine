// ADR 0170 acceptance: the load-shedding ladder recovers once underruns stop, on the loopback host (the real wasm,
// shell and debug view). Load is a wall-clock jump the shell's underrun probe counts, as in
// `adaptiveCapLoopback.test.ts`: stalls every half second walk the adaptive cap from its preset down to its floor of 16,
// then a second more at the floor takes the ladder's bed-idle step. Once the stalls stop, `Audio.debug()` reads
// "recovering", the cap climbs back to its preset, and after 20 s without an underrun the step comes back: the ladder
// reads "idle" and counts one step given back.
//
// Ld7 (0171/0172 R21, architecture §4.8): with buses metered, the ladder's first step pauses their loudness metering
// (STATUS `loudShed`, `Bus.loudness.pausedBy` "ladder"; master keeps metering) before the bed-idle step, and ADR 0170's
// recovery gives it back last, which marks the paused meters `incomplete`. With only master metered (the first case:
// main always meters master) the step is skipped and the ladder runs as before.
import { afterEach, describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { NULL_PROFILE_SINK } from "../mix/profileSink";
import { taps } from "../mix/profileTaps";
import { recordingSink } from "../mix/recordingSink";
import type { AudioHost, CoreLink } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import { createClipRegistry } from "./clipRegistry";
import { fakeDecoder } from "./fakeDecoder";

/** Quanta per frame and frames per second in this rig (4 quanta of 128 at 48 kHz ≈ 10.7 ms). */
const QUANTA_PER_FRAME = 4;
const FRAMES_PER_SECOND = Math.round(48_000 / 128 / QUANTA_PER_FRAME);
const MAX_MIXED = 32;

async function rig(settings: AudioSettings = defaultAudioSettings()) {
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
  const mixer = new Mixer(settings);
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
  return { backend, mixer, step, stall };
}

/** The default buses with `meter: "loudness"` on the names given. */
function metered(names: string[]): AudioSettings {
  const s = defaultAudioSettings();
  return { ...s, buses: s.buses.map((b) => (names.includes(b.name) ? { ...b, meter: "loudness" as const } : b)) };
}

afterEach(() => {
  taps.sink = NULL_PROFILE_SINK;
});

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
      expect(backend.mirror.loudShed, "only master is metered: no loudness step").toBe(0);
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
    expect(backend.mirror.loudShed).toBe(0);
    backend.dispose();
  });

  it("with buses metered, pauses their metering first, before any 0170 step, and gives it back last", { timeout: 180_000 }, async (ctx) => {
    const r = await rig(metered(["SFX", "Music"]));
    if (!r) return ctx.skip();
    const { backend, mixer, step, stall } = r;
    const rec = recordingSink();
    taps.sink = rec.sink;
    const sfx = mixer.bus("SFX").loudness;
    const master = mixer.bus().loudness;
    await step(FRAMES_PER_SECOND + 10);
    expect([sfx.metered, sfx.paused, master.metered]).toEqual([true, false, true]);
    // The hub is the page's: master's meter carries the first case's core over (a new core's first take is a gap
    // for it). Start both flags clean, as the editor's Play does.
    master.reset();
    sfx.reset();
    expect([master.incomplete, sfx.incomplete]).toEqual([false, false]);
    expect([backend.mirror.loudShed, backend.mirror.m3Shed]).toEqual([0, 0]);

    // Underruns every half second: the loudness step comes first, with no bed step yet.
    let stalls = 0;
    while (backend.mirror.loudShed === 0) {
      expect(++stalls, "the loudness step within 20 s of underruns").toBeLessThan(40);
      expect(backend.mirror.m3Shed, "no 0170 step before the loudness step").toBe(0);
      stall(60);
      await step(FRAMES_PER_SECOND / 2);
    }
    expect(backend.mirror.mixedCap).toBe(16);
    expect(backend.mirror.m3Shed, "metering pauses before the bed-idle step").toBe(0);
    expect([sfx.paused, sfx.pausedBy, mixer.bus("Music").loudness.pausedBy]).toEqual([true, "ladder", "ladder"]);
    expect([master.paused, master.pausedBy], "master keeps metering").toEqual([false, null]);
    expect(sfx.incomplete).toBe(false);
    // The underruns go on: the bed-idle step follows (a second or more later), the loudness step stays.
    while (backend.mirror.m3Shed === 0) {
      expect(++stalls, "the bed step follows within 20 s").toBeLessThan(80);
      stall(60);
      await step(FRAMES_PER_SECOND / 2);
    }
    expect([backend.mirror.loudShed, backend.mirror.m3Shed]).toEqual([1, 1]);
    expect(backend.debug().counters.m3Shed, "m3Shed counts the bed step alone").toBe(1);
    const masterElapsed = master.elapsed;

    // Clean from here. 20 s after the last underrun the bed step comes back, the loudness step stays.
    await step(21 * FRAMES_PER_SECOND);
    expect([backend.mirror.m3Shed, backend.mirror.loudShed]).toEqual([0, 1]);
    expect(sfx.pausedBy).toBe("ladder");
    expect(master.elapsed, "master metered all along").toBeGreaterThan(masterElapsed + 20);
    // 20 s later the loudness step comes back last: metering resumes and the span marks the reading incomplete.
    await step(20 * FRAMES_PER_SECOND);
    expect([backend.mirror.m3Shed, backend.mirror.loudShed, backend.mirror.mixedCap]).toEqual([0, 0, MAX_MIXED]);
    expect([sfx.paused, sfx.pausedBy, sfx.incomplete]).toEqual([false, null, true]);
    expect(master.incomplete, "master was never paused").toBe(false);
    // The profiler's ladder track: the loudness step first in and last out.
    expect(rec.of("ladder")).toEqual([[1, true], [2, true], [2, false], [1, false]]);
    backend.dispose();
  });
});

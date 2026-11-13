// ADR 0171 amended by 0172 (M5b, task Ld8; architecture §4.4, §4.8): loudness integrity end to end on the loopback host
// (the real core wasm, the shell, `CoreBackend` and the page's real `loudnessHub`), timed on the audio clock. A main stall
// is frames rendered without the main side taking STATUS: the port's messages queue and the shell's STATUS buffers stay
// with main, so once the pool is out the core takes nothing and its 32-entry ring (3.2 s) fills. The stall's length is
// counted from the last take that got out, the way the design states the bound ("a main stall of up to 3.2 s").
// `native/audio/crates/audio-core/tests/loudness_core.rs` and `loudness_ladder.rs` cover the ring, the take and the
// ladder step inside the core; these check what main reads.
//
// 1. A 3 s stall loses nothing (integrated, elapsed and lost equal an unstalled run's); a 4 s one loses sub-blocks and
//    the hub's readings say `incomplete` (on the bus and on master, both stalled).
// 2. An EPOCH (a trap, then the host's rebuild on a new core): `seq` restarts (the first take carries the reset flag at
//    sequence 0), integrated and elapsed are kept, `incomplete` is set.
// 3. A shed span (the ladder's metering step, driven by underruns on the fake clock as in
//    `core/ladderRecoveryLoopback.test.ts`): the bus meter pauses and its numbers stand still, master keeps
//    metering, and the give-back sets `incomplete` on the bus and not on master.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { createClipRegistry } from "../core/clipRegistry";
import { AudioHost } from "../core/context";
import { createCoreBackend, type CoreBackend } from "../core/coreBackend";
import { fakeDecoder } from "../core/fakeDecoder";
import { watchForTraps } from "../core/recovery";
import { Unlock, type UnlockContext } from "../core/unlock";
import { LOUD_FLAG_NEW_BLOCKS_MASK, LOUD_FLAG_RESET, LOUD_OUTPUT_TAP, LOUD_RING_SUBBLOCKS, STATUS_POOL_BUFFERS } from "../wire.generated";
import { loudnessHub } from "./loudnessHub";
import type { LoudnessStats } from "./loudnessStats";
import { NULL_PROFILE_SINK } from "./profileSink";
import { taps } from "./profileTaps";

const RATE = 48_000;
const QUANTUM = 128;
const QUANTA_PER_SECOND = RATE / QUANTUM; // 375
const SUB_BLOCK_FRAMES = 4_800;
const CLIP_FRAMES = 4 * RATE;
const MAX_MIXED = 32;

/** A 4 s loop in four steps of loudness (a 997 Hz sine), so a lost sub-block changes what integrated reads. */
function programme(): Float32Array {
  const amps = [0.5, 0.05, 0.25, 0.1];
  const out = new Float32Array(CLIP_FRAMES);
  for (let i = 0; i < CLIP_FRAMES; i++) out[i] = amps[Math.floor(i / RATE)]! * Math.sin((2 * Math.PI * 997 * i) / RATE);
  return out;
}

const hosts: AudioHost[] = [];
afterEach(async () => {
  taps.sink = NULL_PROFILE_SINK;
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

/** The default buses with SFX metered (master always is). */
function metered(): AudioSettings {
  const s = defaultAudioSettings();
  return { ...s, buses: s.buses.map((b) => (b.name === "SFX" ? { ...b, meter: "loudness" as const } : b)) };
}

/** What a take carried for one meter, copied out of the reused STATUS block. */
interface TakeItem {
  slot: number;
  firstSeq: number;
  count: number;
  reset: boolean;
}

/** The real host and core backend on the loopback host, one voice looping the programme on SFX; both meters start clean. */
async function rig() {
  const testing = await import("../testing");
  const preset = { ...testing.LOOPBACK_PRESET, maxMixed: MAX_MIXED, maxBeds: 1, limiterLookaheadMs: 0 };
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
    decodeWorker: fakeDecoder(() => ({ frames: CLIP_FRAMES, channels: 1, sampleRate: RATE, channelData: [programme()] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const mixer = new Mixer(metered());
  const backend: CoreBackend = createCoreBackend(host, { clips, clock: loop.clock, mixer });
  watchForTraps(host, { now: () => 0, warn: () => {} });
  const takes: TakeItem[] = [];
  link.onStatus((s) => {
    for (const it of s.loudBuses) takes.push({ slot: it.slot, firstSeq: it.firstSeq, count: it.flags & LOUD_FLAG_NEW_BLOCKS_MASK, reset: (it.flags & LOUD_FLAG_RESET) !== 0 });
  });
  const settle = async () => {
    for (let k = 0; k < 8; k++) await Promise.resolve();
  };
  /** `quanta` rendered with main running: frames of 4 quanta, the page's update before each render. */
  const step = async (quanta: number) => {
    for (let q = 0; q < quanta; q += 4) {
      mixer.update(0.01);
      backend.update(0.01);
      loop.renderQuanta(Math.min(4, quanta - q));
      await settle();
    }
  };
  /** Main running until the core has rendered up to frame `target` (the same audio frame in every run). */
  const stepTo = (target: number) => step(Math.max(0, Math.ceil((target - loop.frame) / QUANTUM)));
  /**
   * A main stall of `frames` audio frames counted from the last take that got out. The port's messages queue (every STATUS
   * buffer stays with main) and main runs no update. Once the pool is out the core takes nothing; rendering goes on until
   * `frames` have passed since the last take. Then main handles what queued, in order.
   */
  const stall = async (frames: number) => {
    const queued: unknown[] = [];
    const real = link.handleMessage.bind(link);
    let lastTake = loop.frame;
    link.handleMessage = (data: unknown) => {
      queued.push(data);
      lastTake = loop.frame;
    };
    try {
      let guard = 0;
      while (queued.length < STATUS_POOL_BUFFERS || loop.frame - lastTake < frames) {
        expect(++guard, "the stall ends").toBeLessThan(10 * QUANTA_PER_SECOND);
        loop.renderQuanta(1);
      }
    } finally {
      link.handleMessage = real;
    }
    const stalledFrames = loop.frame - lastTake;
    for (const data of queued) real(data);
    await settle();
    return { takes: queued.length, stalledFrames };
  };
  backend.play({ path: "p.wav", url: "p.wav", loop: true, stream: false, bus: "SFX" });
  // Warm up: the meters' first takes, a whole programme. The hub is the page's and outlives a rig: start both clean.
  await step(2 * QUANTA_PER_SECOND);
  const sfx = mixer.bus("SFX").loudness;
  const master = mixer.bus().loudness;
  sfx.reset();
  master.reset();
  const stats = (name: string) => (loudnessHub.busLoudness(name) as unknown as { stats: LoudnessStats }).stats;
  // `lost` counts for the life of the page's meter (a reset leaves it): readings take it from here.
  const lost0 = { SFX: stats("SFX").lost, Master: stats("Master").lost };
  const lost = (name: "SFX" | "Master") => stats(name).lost - lost0[name];
  return { loop, host, backend, mixer, step, stepTo, stall, sfx, master, stats, lost, takes };
}

/** One scenario's readings: what the meters said at its end. */
type Rig = NonNullable<Awaited<ReturnType<typeof rig>>>;
const readings = (r: Rig) => ({
  sfx: { integrated: r.sfx.integrated, elapsed: r.sfx.elapsed, lost: r.lost("SFX"), incomplete: r.sfx.incomplete },
  master: { integrated: r.master.integrated, elapsed: r.master.elapsed, lost: r.lost("Master"), incomplete: r.master.incomplete },
});

describe("loudness integrity on the loopback host (Ld8)", () => {
  // The same audio (frames since the meters were cleared) is rendered three times, each on its own core: with main taking
  // STATUS throughout, with a 3 s stall in the middle, and with a 4 s one. The hub is the page's singleton, so the runs follow one another.
  it("a 3 s main stall loses nothing and integrated equals an unstalled run's; a 4 s one loses sub-blocks and sets incomplete", { timeout: 120_000 }, async (ctx) => {
    /** Every run reads at this core frame (the stalled ones render their stall inside it). */
    const END = 16 * RATE;
    const STALL_AT = 4 * RATE;
    const probe = await rig();
    if (!probe) return ctx.skip();
    probe.backend.dispose();

    // Reference: no stall.
    const ref = (await rig())!;
    await ref.stepTo(END);
    const base = readings(ref);
    const refFrame = ref.loop.frame;
    ref.backend.dispose();
    expect(base.sfx.integrated, "the programme reads a loudness").toBeGreaterThan(-30);
    expect(base.sfx.elapsed, "about 14 s of programme since the clear (the last sub-block may still be in the core)").toBeGreaterThan(13.8);
    expect([base.sfx.lost, base.sfx.incomplete, base.master.lost, base.master.incomplete], "an unstalled run is complete").toEqual([0, false, 0, false]);

    // 3 s since the last take: at most 30 sub-blocks pile up, the ring holds 32.
    const three = (await rig())!;
    await three.stepTo(STALL_AT);
    const s3 = await three.stall(3 * RATE);
    expect(s3.takes, "the pool was exhausted").toBe(STATUS_POOL_BUFFERS);
    expect(s3.stalledFrames, "3 s on the audio clock since the last take").toBeGreaterThanOrEqual(3 * RATE);
    expect(s3.stalledFrames).toBeLessThan(3 * RATE + QUANTUM);
    expect(three.loop.frame, "the stall is inside the run").toBeLessThan(END);
    await three.stepTo(END);
    const got3 = readings(three);
    expect(three.loop.frame).toBe(refFrame);
    three.backend.dispose();
    expect([got3.sfx.lost, got3.master.lost], "no sub-block lost").toEqual([0, 0]);
    expect([got3.sfx.incomplete, got3.master.incomplete], "not incomplete").toEqual([false, false]);
    expect(got3.sfx, "the bus reads what an unstalled run reads").toEqual(base.sfx);
    expect(got3.master, "and so does master").toEqual(base.master);

    // 4 s since the last take: 40 sub-blocks against a ring of 32, the oldest 8 are overwritten.
    const four = (await rig())!;
    await four.stepTo(STALL_AT);
    const s4 = await four.stall(4 * RATE);
    expect(s4.takes).toBe(STATUS_POOL_BUFFERS);
    expect(s4.stalledFrames).toBeGreaterThanOrEqual(4 * RATE);
    expect(s4.stalledFrames).toBeLessThan(4 * RATE + QUANTUM);
    await four.stepTo(END);
    const got4 = readings(four);
    four.backend.dispose();
    const expectLost = Math.floor(s4.stalledFrames / SUB_BLOCK_FRAMES) - LOUD_RING_SUBBLOCKS;
    expect(got4.sfx.lost, "the sub-blocks that did not fit the ring").toBeGreaterThanOrEqual(1);
    expect(got4.sfx.lost).toBeLessThanOrEqual(expectLost + 1);
    expect(got4.master.lost).toBe(got4.sfx.lost);
    expect([got4.sfx.incomplete, got4.master.incomplete], "the hub's readings say incomplete").toEqual([true, true]);
    expect(got4.sfx.elapsed, "the lost audio is not counted as metered").toBeLessThan(base.sfx.elapsed - 0.5);
  });

  it("an EPOCH (a trap, then the rebuild on a new core) restarts seq, keeps integrated and elapsed, and sets incomplete", { timeout: 60_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { loop, host, step, sfx, master, takes } = r;
    const sfxSlot = takes.find((t) => t.slot !== LOUD_OUTPUT_TAP)!.slot;
    await step(6 * QUANTA_PER_SECOND);
    const before = readings(r);
    const seqBefore = Math.max(...takes.filter((t) => t.slot === sfxSlot).map((t) => t.firstSeq + t.count));
    expect(before.sfx.integrated, "metered, a loudness").toBeGreaterThan(-30);
    expect(before.sfx.elapsed).toBeGreaterThan(5.5);
    expect(seqBefore, "the sequence has run on").toBeGreaterThan(50);
    expect([sfx.incomplete, master.incomplete]).toEqual([false, false]);

    // Integrated and elapsed as the first take of the new core leaves them (the hub's feed ran first, the epoch before it).
    const atReset: { integrated: number; elapsed: number; incomplete: boolean }[] = [];
    r.host.link.onStatus((s) => {
      if (s.loudBuses.some((it) => it.slot === sfxSlot && (it.flags & LOUD_FLAG_RESET) !== 0)) atReset.push({ integrated: sfx.integrated, elapsed: sfx.elapsed, incomplete: sfx.incomplete });
    });
    const mark = takes.length;
    loop.trapNext();
    for (let f = 0; f < 120 && host.health.recoveries === 0; f++) await step(4);
    expect(host.health.recoveries, "the host rebuilt").toBe(1);
    expect(loop.cores, "on a new core").toBe(2);
    await step(QUANTA_PER_SECOND);

    const after = takes.slice(mark).filter((t) => t.slot === sfxSlot);
    const first = after.find((t) => t.reset);
    expect(first, "the new core's first take of the meter carries the reset flag").toBeDefined();
    expect(first!.firstSeq, "seq restarts at 0").toBe(0);
    expect(Math.max(...after.map((t) => t.firstSeq + t.count)), "and counts up from there").toBeLessThan(seqBefore);
    expect(atReset.length, "the reset take reached main once").toBeGreaterThanOrEqual(1);
    expect(atReset[0]!.integrated, "integrated kept across the EPOCH").toBe(before.sfx.integrated);
    expect(atReset[0]!.elapsed, "elapsed kept").toBeGreaterThanOrEqual(before.sfx.elapsed);
    expect(atReset[0]!.incomplete, "the EPOCH marks the reading incomplete").toBe(true);

    // The new core meters on from there: the same histograms, more of them, nothing counted lost.
    await step(5 * QUANTA_PER_SECOND);
    const later = readings(r);
    expect(later.sfx.elapsed, "metering continues on the new core").toBeGreaterThan(before.sfx.elapsed + 0.5);
    expect(later.sfx.integrated).toBeGreaterThan(-30);
    expect([later.sfx.incomplete, later.master.incomplete], "incomplete stays until a reset").toEqual([true, true]);
    expect([r.lost("SFX"), r.lost("Master")], "a rebuild is not a loss").toEqual([0, 0]);
    r.backend.dispose();
  });

  it("a shed span pauses the bus meter and not master's, and the give-back sets incomplete on the bus alone", { timeout: 120_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { loop, backend, step, sfx, master } = r;
    /** The render falls `ms` behind the wall clock (the context clock stands still meanwhile): one underrun, the ladder's input. */
    const underrun = (ms: number) => {
      loop.clock.setRunning(false);
      loop.clock.advance(ms);
      loop.clock.setRunning(true);
    };
    // The ladder's probe warms up for 1 s (the rig's warm-up passed it); underruns every half second until the metering step.
    await step(QUANTA_PER_SECOND);
    expect([backend.mirror.loudShed, sfx.paused, master.paused, sfx.elapsed > 0]).toEqual([0, false, false, true]);
    let underruns = 0;
    while (backend.mirror.loudShed === 0) {
      expect(++underruns, "the metering step within 20 s of underruns").toBeLessThan(40);
      underrun(60);
      await step(188);
    }
    expect(backend.mirror.m3Shed, "the metering step comes before any audible one").toBe(0);

    // From the step on, the bus's numbers stand still while master's go on.
    await step(94); // the pause has reached the hub
    expect([sfx.paused, sfx.pausedBy, master.paused, master.pausedBy]).toEqual([true, "ladder", false, null]);
    expect(sfx.incomplete, "incomplete waits for the give-back").toBe(false);
    const frozen = { elapsed: sfx.elapsed, integrated: sfx.integrated, masterElapsed: master.elapsed, masterIntegrated: master.integrated };
    await step(8 * QUANTA_PER_SECOND);
    expect(backend.mirror.loudShed, "still shed").toBe(1);
    expect([sfx.elapsed, sfx.integrated], "the bus meter is paused: nothing taken").toEqual([frozen.elapsed, frozen.integrated]);
    expect(master.elapsed, "master meters on, 8 s of it").toBeGreaterThan(frozen.masterElapsed + 7.5);
    expect(master.integrated).not.toBe(frozen.masterIntegrated);
    expect([master.paused, master.incomplete]).toEqual([false, false]);

    // Clean from here: the loudness step comes back last, 80 s after the last underrun; the bus resumes `incomplete`.
    let clean = 0;
    while (backend.mirror.loudShed !== 0) {
      expect(++clean, "the step is given back within 90 s").toBeLessThan((90 * QUANTA_PER_SECOND) / 4);
      await step(4);
    }
    expect([sfx.paused, sfx.pausedBy, sfx.incomplete], "resumed, the shed span marks the reading incomplete").toEqual([false, null, true]);
    expect([master.paused, master.incomplete], "master was never shed").toEqual([false, false]);
    expect(sfx.integrated, "integrated kept across the span").toBeGreaterThan(-30);
    const resumed = sfx.elapsed;
    expect(resumed, "nothing metered during the span (at most the sub-blocks since the give-back)").toBeLessThan(frozen.elapsed + 0.2);
    await step(3 * QUANTA_PER_SECOND);
    expect(sfx.elapsed, "metering goes on after the give-back").toBeGreaterThan(resumed + 2.5);
    expect([sfx.incomplete, master.incomplete]).toEqual([true, false]);
    backend.dispose();
  });
});

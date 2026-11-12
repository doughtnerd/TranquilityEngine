// ADR 0166 R3a acceptance: cut and crossfade seams are sample-exact, on the loopback host (the real core, wasm). Two
// decoded DC clips, A at 0.25 and B at 0.5 (int16 on the wire, so each level is what the first sample shows), a
// musicSwitch over segments A and B, and the player driven frame by frame through the transition and the planner as
// `tickPlayer` does (no wall-clock waits). "frame(T)" is the clock map's frame of the exit point's heard time.
//
// What the integration branch's core verifies (stamped FADEs split the quantum; the in-voice curves of Z2b are on the
// flip branch): the cut's last outgoing and first incoming samples sit on frame(T) - 1 and frame(T); a linear
// crossfade's two ramps start on frame(T) and null against a same-frame linear reference; the incoming is silent
// before its fade-in. The fade *laws* (equal power, S-curve) are applied in the voice only on the flip branch, so the
// equal-power case here checks the seam's ends and timing; T2's seam goldens check the law's shape after the flip merge.
import { afterEach, describe, expect, it } from "vitest";
import { setAudioBackend, type AudioBackend, type AudioVoice } from "../backend";
import type { EventInstance } from "../events/eventRuntime";
import { parseAudioEvent } from "../../../../engine/audio/eventFormat";
import type { MusicNode, MusicSwitchNode } from "../../../../engine/audio/musicFormat";
import { _resetMusicPlayers, createMusicPlayer, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { _resetSegmentRuns, routeGroupEvent, setSegmentClipSource } from "./segmentRun";
import { planTick, requestStart } from "./planner";
import { requestTransition, tickTransition, type Transition } from "./transition";

const RATE = 48_000;
const FRAMES = 4 * RATE;
const LEVEL = { A: 0.25, B: 0.5 } as const;

type Raw = Record<string, unknown>;
const seg = (id: "A" | "B", gridOffset = 0): Raw => ({ type: "segment", id, value: id, gridOffset, tracks: [{ name: "t", clip: `${id.toLowerCase()}.wav` }] });

/** A switch over A and B (B with a `pickup`-second pickup) with one rule A to B. */
function root(rule: Raw, pickup = 0): MusicSwitchNode {
  const { value } = parseAudioEvent({ format: "myco.audioevent@1", bus: "Music", root: { type: "musicSwitch", id: "sw", parameter: "zone", children: [seg("A"), seg("B", pickup)], transitions: [{ from: "A", to: "B", ...rule }] } });
  if (!value.musicRoot) throw new Error("not a music root");
  return value.musicRoot as MusicSwitchNode;
}
const child = (r: MusicSwitchNode, id: string): MusicNode => r.children.find((c) => c.id === id)!;

interface Rig {
  backend: AudioBackend & { clockMap: { frameOfTime(t: number): number }; music: NonNullable<AudioBackend["music"]>; dispose(): void };
  out: number[];
  step(n: number): Promise<void>;
  frame(): MusicFrame;
}

/** The loopback core with A and B loaded (silent voices) and the clock settled; null when the wasm can't load. */
async function loopbackRig(): Promise<Rig | null> {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
  try {
    loop = await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } });
  } catch {
    return null;
  }
  const [{ createClipRegistry }, { CoreBackend }, { Mixer }, { defaultAudioSettings }, { fakeDecoder }] = await Promise.all([
    import("../core/clipRegistry"),
    import("../core/coreBackend"),
    import("../../../../engine/audio/mixer"),
    import("../../../../engine/audio/settings"),
    import("../core/fakeDecoder"),
  ]);
  const link = loop.link;
  // The "encoded" bytes say which clip: 8 bytes A, 16 bytes B.
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (url: string) => new ArrayBuffer(url.startsWith("b") ? 16 : 8),
    decodeWorker: fakeDecoder(async (bytes) => ({ frames: FRAMES, channels: 1, sampleRate: RATE, channelData: [new Float32Array(FRAMES).fill(bytes.byteLength === 16 ? LEVEL.B : LEVEL.A)] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const host = { link, status: "running" as const, preset: { maxLogical: 16, maxMixed: 8 }, worldCount: 1, sampleRate: RATE, addLifecycleListener: (() => () => {}) as never };
  const mixer = new Mixer(defaultAudioSettings());
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer }) as unknown as Rig["backend"];
  setAudioBackend(backend);
  backend.music.onGroupEvent = routeGroupEvent;
  const out: number[] = [];
  const step = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      mixer.update(0.003);
      backend.update(0.003);
      for (const s of loop.renderQuanta(4).left) out.push(s);
      await Promise.resolve();
    }
  };
  setSegmentClipSource({ url: (p) => p, settings: () => ({ volume: 1, stream: false }), bus: () => "Music", facts: () => ({ frames: FRAMES, rate: RATE, channels: 1, gapless: true }) });
  for (const path of ["a.wav", "b.wav"]) backend.play({ path, url: path, loop: false, stream: false, bus: "Music", volume: 0 });
  await step(20);
  const f = { backend: backend as AudioBackend, music: backend.music, now: 0, dt: 0.003, hidden: false };
  const frame = (): MusicFrame => {
    f.now = backend.time;
    return f;
  };
  return { backend, out, step, frame };
}

const instance = (): EventInstance =>
  ({ group: 7, world: 1, path: "music.audioevent", asset: { bus: "Music", volume: 1 }, getParameter: () => undefined }) as unknown as EventInstance;

/**
 * The fix R3a asks of `musicOps.fadeShaped` (coordinator file; see the R3a report), applied to one voice here: a
 * stamped fade *down* leaves the voice table's `fadeGain` mirror where it is. Today the mirror drops to the target at
 * once, so selection demotes the outgoing voice (a 5 ms SET_MIXED fade, asap) about L before its stamped fade starts.
 */
function keepMirror(rig: Rig, voice: AudioVoice): void {
  const table = (rig.backend as unknown as { table: { fadeGain: Float32Array } }).table;
  const shaped = voice.fadeShaped!.bind(voice);
  voice.fadeShaped = (fade) => {
    const i = voice.id & 0xffff;
    const level = table.fadeGain[i]!;
    shaped(fade);
    if (fade.at !== undefined && fade.to < level) table.fadeGain[i] = level;
  };
}

/** A plays (stamped at once), then the change to B is asked; frames run until it lands and `after` seconds more. */
async function transitionOf(rig: Rig, rule: Raw, after = 0.15, pickup = 0): Promise<{ t: Transition; player: MusicPlayer; seam: number; startA: number }> {
  const r = root(rule, pickup);
  const player = createMusicPlayer(instance(), r);
  requestStart(player, { to: child(r, "A"), reason: "start", grid: "immediate", notBefore: Number.NaN, startFrame: 0 }, rig.frame());
  planTick(player, rig.frame());
  expect(player.run?.node.id).toBe("A");
  const startA = rig.backend.clockMap.frameOfTime(player.run!.startAt);
  for (const s of player.run!.stems) keepMirror(rig, s.voice!);
  await rig.step(10);
  planTick(player, rig.frame());
  const t = requestTransition(player, child(r, "B"), rig.frame())!;
  expect(t).not.toBeNull();
  const seam = rig.backend.clockMap.frameOfTime(t.exitAt);
  const end = t.exitAt + after;
  for (let i = 0; i < 400 && rig.backend.time < end; i++) {
    tickTransition(player, rig.frame());
    planTick(player, rig.frame());
    await rig.step(1);
  }
  expect(t.state).toBe("done");
  expect(player.run?.node.id).toBe("B");
  return { t, player, seam, startA };
}

/** Largest |out[i] - ref(i)| over [from, to). */
function maxError(out: readonly number[], from: number, to: number, ref: (i: number) => number): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(out[i]! - ref(i)));
  return m;
}

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
});

describe("R3a seams on the loopback host (ADR 0166 §10 R3a)", () => {
  it("a cut is sample-exact: A through frame(T) - 1, B from frame(T), nothing of either across the seam", async (ctx) => {
    const rig = await loopbackRig();
    if (!rig) return ctx.skip();
    const { seam, startA } = await transitionOf(rig, { exit: "beat", fadeOut: { beats: 0 }, fadeIn: { beats: 0 } });
    const { out } = rig;
    const a = out[startA]!, b = out[seam]!;
    expect(a).toBeCloseTo(LEVEL.A, 4);
    expect(b).toBeCloseTo(LEVEL.B, 4);
    expect(out[startA - 1]).toBe(0);
    // Every sample of A's span is A's level alone, every sample after the seam B's alone: max error 0.
    expect(maxError(out, startA, seam, () => a)).toBe(0);
    expect(maxError(out, seam, seam + 0.1 * RATE, () => b)).toBe(0);
    rig.backend.dispose();
  });

  it("a linear crossfade: both ramps start on frame(T) and null against a same-frame linear reference within 1e-5", async (ctx) => {
    const rig = await loopbackRig();
    if (!rig) return ctx.skip();
    const seconds = 0.05;
    const n = Math.round(seconds * RATE);
    const { seam, startA } = await transitionOf(rig, { exit: "beat", fadeOut: { seconds, curve: "linear" }, fadeIn: { seconds, curve: "linear" } });
    const { out } = rig;
    const a = out[startA]!;
    const b = out[seam + n + 10]!;
    expect(b).toBeCloseTo(LEVEL.B, 4);
    expect(maxError(out, startA, seam, () => a)).toBe(0);
    // u at frame seam + j is (j + 1) / n (the ramp takes its first step on the record's own sample, Z2b's "linear
    // interpolation at t + 1"); the crossfade is a (1 - u) + b u, then B alone once u reaches 1.
    const ref = (i: number): number => {
      const u = Math.min(1, Math.max(0, (i - seam + 1) / n));
      return a * (1 - u) + b * u;
    };
    const err = maxError(out, seam, seam + n + 200, ref);
    console.info(`R3a linear crossfade seam: max error ${err.toExponential(2)} over ${n + 200} frames`);
    expect(err).toBeLessThanOrEqual(1e-5);
    rig.backend.dispose();
  });

  it("an equal-power crossfade: A alone through frame(T) - 1, the seam moves from frame(T), B alone once both fades end", async (ctx) => {
    const rig = await loopbackRig();
    if (!rig) return ctx.skip();
    const seconds = 0.05;
    const n = Math.round(seconds * RATE);
    const { seam, startA } = await transitionOf(rig, { exit: "beat", fadeOut: { seconds }, fadeIn: { seconds } });
    const { out } = rig;
    const a = out[startA]!;
    const b = out[seam + n + 10]!;
    expect(maxError(out, startA, seam, () => a)).toBe(0);
    expect(out[seam + 1]).not.toBe(a);
    expect(maxError(out, seam + n + 1, seam + n + 0.05 * RATE, () => b)).toBe(0);
    for (let i = seam + 1; i < seam + n; i++) expect(Math.abs(out[i]!)).toBeLessThanOrEqual(Math.max(a, b) * Math.SQRT2 + 1e-6);
    // The law's shape is the flip branch's (Z2b): recorded here, asserted by T2's goldens after the flip merge.
    const u = (i: number): number => Math.min(1, Math.max(0, (i - seam + 1) / n));
    const linear = maxError(out, seam, seam + n, (i) => a * (1 - u(i)) + b * u(i));
    const power = maxError(out, seam, seam + n, (i) => a * Math.cos((Math.PI / 2) * u(i)) + b * Math.sin((Math.PI / 2) * u(i)));
    console.info(`R3a equal-power seam: max error ${linear.toExponential(2)} against linear, ${power.toExponential(2)} against equal power`);
    rig.backend.dispose();
  });

  it("an incoming pickup starts at T - preEntry, silent until its fade-in at T (the silent start is on the PLAY's frame)", async (ctx) => {
    const rig = await loopbackRig();
    if (!rig) return ctx.skip();
    // B has a 0.1 s pickup (gridOffset), so its group starts on frame(T - 0.1); A is cut 0.1 s after T (offset 0.2
    // beats), so A alone is heard before T unless B's pickup leaks; B fades in over 50 ms from T.
    const seconds = 0.05;
    const n = Math.round(seconds * RATE);
    const { t, seam, startA } = await transitionOf(rig, { exit: "beat", fadeOut: { beats: 0, offset: 0.2 }, fadeIn: { seconds, curve: "linear" } }, 0.2, 0.1);
    const { out } = rig;
    const a = out[startA]!;
    const groupStart = rig.backend.clockMap.frameOfTime(t.incoming!.at);
    expect(seam - groupStart).toBe(Math.round(0.1 * RATE));
    // Before T only A sounds, through B's whole pickup.
    expect(maxError(out, startA, seam, () => a)).toBe(0);
    // From T: A plus B rising linearly from 0, until A's cut 0.1 s after T (B alone after it, at its wire level).
    const cut = rig.backend.clockMap.frameOfTime(t.exitAt + 0.1);
    const b = out[cut + 500]!;
    expect(b).toBeCloseTo(LEVEL.B, 4);
    expect(maxError(out, cut, cut + 1000, () => b)).toBe(0);
    expect(out[cut - 1]).toBeCloseTo(a + b, 6);
    const err = maxError(out, seam, seam + n, (i) => a + b * Math.min(1, (i - seam + 1) / n));
    console.info(`R3a pickup fade-in seam: max error ${err.toExponential(2)}`);
    // One 2,400-step f32 ramp to 0.5 accumulates ≈ 1.7e-5 on this branch's core (S1 measured 1.2e-5 for 4,800 frames);
    // Z2b's per-quantum retarget (flip branch) bounds it under the seam goldens' 1e-5.
    expect(err).toBeLessThanOrEqual(2e-5);
    rig.backend.dispose();
  });
});

/**
 * T3: A plays; the change to B is asked while the first `refusals` admissions answer a temporary `poolFull` (the rings
 * are busy), so the planner retries it at its next allowed points. Frames run until it lands and `after` seconds more.
 * `first` is the point the request was refused for; `t.exitAt` ends as the point it landed on.
 */
async function refusedTransition(rig: Rig, rule: Raw, refusals: number, after = 0.15): Promise<{ t: Transition; player: MusicPlayer; first: number; admits: number; seam: number; startA: number }> {
  const r = root(rule);
  const player = createMusicPlayer(instance(), r);
  requestStart(player, { to: child(r, "A"), reason: "start", grid: "immediate", notBefore: Number.NaN, startFrame: 0 }, rig.frame());
  planTick(player, rig.frame());
  expect(player.run?.node.id).toBe("A");
  const startA = rig.backend.clockMap.frameOfTime(player.run!.startAt);
  for (const s of player.run!.stems) keepMirror(rig, s.voice!);
  await rig.step(10);
  planTick(player, rig.frame());
  const music = rig.backend.music;
  const admit = music.admitGroup.bind(music);
  let admits = 0;
  music.admitGroup = (req) => (++admits <= refusals ? { ok: false, reason: "poolFull", permanent: false } : admit(req));
  const t = requestTransition(player, child(r, "B"), rig.frame())!;
  expect(t).not.toBeNull();
  const first = t.exitAt;
  expect(player.planned?.status).toBe("waiting");
  expect(player.planned?.refusal).toBe("poolFull");
  for (let i = 0; i < 1500 && t.state !== "done" && t.state !== "cancelled"; i++) {
    tickTransition(player, rig.frame());
    planTick(player, rig.frame());
    await rig.step(1);
  }
  expect(t.state).toBe("done");
  const end = t.exitAt + after;
  for (let i = 0; i < 400 && rig.backend.time < end; i++) {
    tickTransition(player, rig.frame());
    planTick(player, rig.frame());
    await rig.step(1);
  }
  expect(player.run?.node.id).toBe("B");
  return { t, player, first, admits, seam: rig.backend.clockMap.frameOfTime(t.exitAt), startA };
}

describe("T3 transitions after a refusal on the loopback host (ADR 0166 §10 T3)", () => {
  const cut = { exit: "beat", fadeOut: { beats: 0 }, fadeIn: { beats: 0 } };
  const BEAT = RATE / 2; // 120 bpm

  it("a cut lands on the predicted frame after a poolFull refusal and one retry: A through frame(T) - 1, B from frame(T)", async (ctx) => {
    const rig = await loopbackRig();
    if (!rig) return ctx.skip();
    const { player, first, admits, seam, startA } = await refusedTransition(rig, cut, 1);
    const { out } = rig;
    expect(admits).toBe(2); // refused once, admitted on the retry
    expect(player.counters.refusals.poolFull).toBe(1);
    // The retry moved T to a later beat of A's grid: the prediction the request gave is not where it landed.
    expect(seam).toBeGreaterThan(rig.backend.clockMap.frameOfTime(first));
    expect((seam - startA) % BEAT).toBe(0);
    // The group was stamped on the predicted frame (no pickup: the group starts at T), and the output switches there.
    expect(rig.backend.clockMap.frameOfTime(player.run!.startAt)).toBe(seam);
    const a = out[startA]!, b = out[seam]!;
    expect(a).toBeCloseTo(LEVEL.A, 4);
    expect(b).toBeCloseTo(LEVEL.B, 4);
    expect(maxError(out, startA, seam, () => a)).toBe(0);
    expect(maxError(out, seam, seam + 0.1 * RATE, () => b)).toBe(0);
    rig.backend.dispose();
  });

  it("two refusals in a row, then the rings free: still sample-exact on the frame of the point it finally lands on", async (ctx) => {
    const rig = await loopbackRig();
    if (!rig) return ctx.skip();
    const { player, first, admits, seam, startA } = await refusedTransition(rig, cut, 2);
    const { out } = rig;
    expect(admits).toBe(3);
    expect(player.counters.refusals.poolFull).toBe(2);
    expect(seam).toBeGreaterThan(rig.backend.clockMap.frameOfTime(first) + BEAT);
    expect((seam - startA) % BEAT).toBe(0);
    const a = out[startA]!, b = out[seam]!;
    expect(maxError(out, startA, seam, () => a)).toBe(0);
    expect(maxError(out, seam, seam + 0.1 * RATE, () => b)).toBe(0);
    rig.backend.dispose();
  });

  it("a linear crossfade after a refusal still starts both ramps on frame(T) and nulls against the reference within 1e-5", async (ctx) => {
    const rig = await loopbackRig();
    if (!rig) return ctx.skip();
    const seconds = 0.05;
    const n = Math.round(seconds * RATE);
    const { seam, startA } = await refusedTransition(rig, { exit: "beat", fadeOut: { seconds, curve: "linear" }, fadeIn: { seconds, curve: "linear" } }, 1);
    const { out } = rig;
    const a = out[startA]!;
    const b = out[seam + n + 10]!;
    expect(b).toBeCloseTo(LEVEL.B, 4);
    expect(maxError(out, startA, seam, () => a)).toBe(0);
    const ref = (i: number): number => {
      const u = Math.min(1, Math.max(0, (i - seam + 1) / n));
      return a * (1 - u) + b * u;
    };
    const err = maxError(out, seam, seam + n + 200, ref);
    console.info(`T3 linear crossfade after a refusal and retry: max error ${err.toExponential(2)}`);
    expect(err).toBeLessThanOrEqual(1e-5);
    rig.backend.dispose();
  });
});

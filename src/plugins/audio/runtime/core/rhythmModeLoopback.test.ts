// ADR 0166 Rh1 (api-and-models §1.5, architecture §3.7, §4.6): a change of `audio.rhythmMode` on the loopback host. The
// real `AudioHost` makes a new context with the other `latencyHint` (the device path, through `recovery.ts`), the real
// `CoreBackend` reads the new context's latency back into `Audio.latency`, and the playing music re-enters through P9's
// recovery, every stem together where continuous playback would be. In rhythm mode the beat clock is held from the
// rebuild's start until the re-entry is stamped, and the gap arrives as one coalesced call. The rig is P9's
// (`musicRecoveryLoopback.test.ts`): stems of independent noise, so a correlation tells each stem's file position.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mixer, mixer as pageMixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import type { MusicEvent } from "../../../../engine/audio/musicTypes";
import type { EventInstance } from "../events/eventRuntime";
import { fakeDecoder } from "./fakeDecoder";
import { createClipRegistry } from "./clipRegistry";
import { AudioHost, presetFromSettings, RHYTHM_LATENCY_HINT, type ContextOptions, type ContextParts, type LatencyHint } from "./context";
import { createCoreBackend, type CoreBackend } from "./coreBackend";
import { contextRebuilds, rebuildHost, watchForTraps, type RebuildOutcome } from "./recovery";
import { BackgroundController, type VisibilitySource } from "./background";
import { Unlock, type UnlockContext } from "./unlock";
import { _resetMusicPlayers, createMusicPlayer, musicEarlyStep, musicPlanStep, type MusicPlayer } from "../music/musicSystem";
import { _resetSegmentRuns, setSegmentClipSource } from "../music/segmentRun";
import { _resetMusicBackground } from "../music/background";
import { predictDue, seatBeats } from "../music/beatClock";
import { Audio } from "../Audio";
import { setAudioBackend } from "../backend";

const RATE = 48_000;
/** Stems are 6 s at 48 kHz (decoded: under the 30 s rule). */
const CLIP_FRAMES = 6 * RATE;
/** 240 bpm 4/4: a beat is 0.25 s, a bar 1 s (48,000 frames). */
const BAR_FRAMES = RATE;
const BEAT_SECONDS = 0.25;
const STEMS = ["music/m0.wav", "music/m1.wav"];
/** What the fake contexts report per hint: Chromium's fake sink at each (S5). */
const LATENCY: Record<string, { base: number; output: number }> = { interactive: { base: 0.01, output: 0.032 }, "0": { base: 0.0029, output: 0.008 } };

function noise(k: number): Float32Array {
  const a = new Float32Array(CLIP_FRAMES);
  let s = (0x9e3779b9 * (k + 1)) >>> 0;
  for (let i = 0; i < CLIP_FRAMES; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    a[i] = ((s >>> 8) / (1 << 24) - 0.5) * 0.2;
  }
  return a;
}
const SIGNALS = STEMS.map((_, k) => noise(k));

const hosts: AudioHost[] = [];
const pageSettings = pageMixer.audioSettings;
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  _resetMusicPlayers();
  _resetSegmentRuns();
  _resetMusicBackground();
  pageMixer.configure(pageSettings);
  vi.restoreAllMocks();
});

/** A fake context made with `hint`, reporting its latency, with a valid output timestamp once running. */
function fakeContext(hint: LatencyHint) {
  const l = LATENCY[String(hint)] ?? { base: 0, output: 0 };
  const ctx = {
    state: "running",
    sampleRate: RATE,
    destination: {},
    hint,
    baseLatency: l.base,
    outputLatency: l.output,
    getOutputTimestamp: () => ({ contextTime: ctx.state === "running" ? 1 : 0, performanceTime: 1000 }),
    resume: () => Promise.resolve(),
    suspend: () => Promise.resolve(),
    close: () => {
      ctx.state = "closed";
      return Promise.resolve();
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return ctx;
}

function segment(): SegmentNode {
  const node = parseSegmentNode(
    { type: "segment", id: "loop", gridOffset: 0, tempo: [{ at: "1:1:0", bpm: 240, beatsPerBar: 4, beatUnit: 4 }], tracks: STEMS.map((clip, k) => ({ name: `t${k}`, clip })) },
    "test",
    newMusicContext(),
  );
  if (!node) throw new Error("fixture segment did not parse");
  return node;
}

const withRhythm = (on: boolean): AudioSettings => ({ ...defaultAudioSettings(), rhythmMode: on });

/** One beat callback as the dispatch would deliver it: the heard time, the frame's `Audio.time`, `missed`, and whether a rebuild ran. */
interface Fired {
  time: number;
  now: number;
  missed: number;
  bar: number;
  beat: number;
}

async function rig(startInRhythm: boolean) {
  const testing = await import("../testing");
  const loop = await testing.createLoopbackHost();
  const target = new EventTarget();
  const hints: LatencyHint[] = [];
  let hostNow = 0;
  const first = fakeContext(startInRhythm ? RHYTHM_LATENCY_HINT : "interactive");
  const respawn = () => loop.respawn();
  /** Frames the next new context takes to open (a real one adds its worklet module meanwhile); the old core renders on. */
  let openFrames = 0;
  let opening: (() => void) | null = null;
  const recreate = async (options: ContextOptions): Promise<ContextParts> => {
    hints.push(options.latencyHint);
    if (openFrames > 0) await new Promise<void>((resolve) => (opening = resolve));
    const context = fakeContext(options.latencyHint);
    const { node, port } = loop.recreate(RATE);
    return { context: context as unknown as AudioContext, node, port, unlock: new Unlock({ target, context: context as unknown as UnlockContext }), respawn };
  };
  const host = AudioHost._create({
    context: first as unknown as AudioContext,
    node: Object.assign(new EventTarget(), { connect() {}, disconnect() {} }) as unknown as AudioWorkletNode,
    link: loop.link,
    unlock: new Unlock({ target, context: first as unknown as UnlockContext }),
    preset: presetFromSettings(defaultAudioSettings()),
    respawn,
    recreate,
    rhythmMode: startInRhythm,
    now: () => hostNow,
  });
  hosts.push(host);
  const link = loop.link;
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (path) => new TextEncoder().encode(path).buffer as ArrayBuffer,
    decodeWorker: fakeDecoder((encoded) => {
      const k = STEMS.indexOf(new TextDecoder().decode(encoded));
      return { frames: CLIP_FRAMES, channels: 1, sampleRate: RATE, channelData: [SIGNALS[Math.max(0, k)]!] };
    }),
    clipFormat: 0,
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const mixer = new Mixer(withRhythm(startInRhythm));
  pageMixer.configure(withRhythm(startInRhythm)); // `Audio.rhythmMode` and the hold read the page's mixer
  const backend: CoreBackend = createCoreBackend(host, { clips, clock: loop.clock, mixer });
  setAudioBackend(backend);
  watchForTraps(host, { now: () => 0, warn: () => {} });
  host.reconfigure(withRhythm(startInRhythm)); // as `service.ts` does at start: nothing to rebuild
  setSegmentClipSource({
    url: (p) => p,
    settings: () => ({ volume: 1, stream: false }),
    bus: () => "Music",
    facts: () => ({ frames: CLIP_FRAMES, rate: RATE, channels: 1, gapless: true }),
  });
  const page = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const controller = new BackgroundController({ host, target: backend, visibility: page as unknown as VisibilitySource, rebuild: async () => "unavailable" }).start();
  backend.addCleanup(() => controller.dispose());

  /** Left samples by their frame on the context that rendered them (a new context restarts at 0: `ctx` says which). */
  const out: { v: number; frame: number; ctx: number }[] = [];
  let ctxIndex = 0;
  host.addLifecycleListener({ onContextReplaced: () => void ctxIndex++ });
  const fired: Fired[] = [];
  /** Frames (by `Audio.time`) the backend spent rebuilding, and whether beats were held then. */
  const rebuilding: { now: number; held: boolean }[] = [];
  let beatsOf: MusicPlayer | null = null;
  const ev = { handle: null } as unknown as MusicEvent;
  const settle = async () => {
    for (let k = 0; k < 8; k++) await Promise.resolve();
  };
  /** One rendered frame of 4 quanta; the frame steps first (step 0 with the beat dispatch, step 9, the backend's update). */
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      const dt = 512 / loop.sampleRate;
      hostNow += dt * 1000;
      musicEarlyStep(backend, dt);
      if (beatsOf) {
        const now = backend.time;
        if (backend.isRecovering) rebuilding.push({ now, held: beatsOf.beats!.held });
        if (predictDue(beatsOf, "beat", now, dt, ev)) fired.push({ time: ev.time, now, missed: ev.missed, bar: ev.bar, beat: ev.beat });
      }
      musicPlanStep(backend, dt);
      mixer.update(dt);
      backend.update(dt);
      for (let q = 0; q < 4; q++) {
        const start = loop.frame;
        const { left } = loop.renderQuanta(1);
        left.forEach((v, j) => out.push({ v, frame: start + j, ctx: ctxIndex }));
      }
      await settle();
      if (opening && --openFrames <= 0) {
        const open = opening as () => void;
        opening = null;
        open();
        await settle();
      }
    }
  };
  /** Changes the setting as an Engine's `create` would (`Engine._onAudioConfigured` → `host.reconfigure`), and steps until the new context runs. */
  const toggle = async (on: boolean, max = 120): Promise<boolean> => {
    pageMixer.configure(withRhythm(on));
    host.reconfigure(withRhythm(on));
    let started = false;
    for (let k = 0; k < max; k++) {
      await step(1);
      started ||= host.rebuilding;
      if (started && !host.rebuilding && host.rhythmMode === on) return true;
    }
    return false;
  };
  /** A trap in the core: the same-context rebuild; steps until it settles. */
  const trap = async (max = 80): Promise<RebuildOutcome | null> => {
    let outcome: RebuildOutcome | null = null;
    void rebuildHost(host, "trap").then((o) => (outcome = o));
    for (let k = 0; k < max && outcome === null; k++) await step(1);
    return outcome;
  };
  const instance = { group: 5, world: 0, path: "music.audioevent", asset: { bus: "Music", volume: 1 } } as unknown as EventInstance;
  const watchBeats = (p: MusicPlayer) => {
    beatsOf = p;
    seatBeats(p, backend.time);
  };
  return { loop, host, backend, out, step, toggle, trap, hints, instance, fired, rebuilding, watchBeats, advanceHostClock: (ms: number) => void (hostNow += ms), slowOpen: (frames: number) => void (openFrames = frames) };
}

function firstSound(out: readonly { v: number }[], from: number): number {
  for (let i = from; i < out.length; i++) if (out[i]!.v !== 0) return i;
  return -1;
}

/** Stem `k`'s file position at `out[at]` (best-correlating lag in `guess ± range`), and the normalised peak. */
function positionOf(out: readonly { v: number }[], at: number, k: number, guess: number, range = 2_000, n = 2_048): { pos: number; peak: number } {
  const s = SIGNALS[k]!;
  let best = -1;
  let bestC = -Infinity;
  let energyOut = 0;
  for (let j = 0; j < n; j++) energyOut += out[at + j]!.v ** 2;
  for (let p = Math.max(0, guess - range); p <= Math.min(CLIP_FRAMES - n, guess + range); p++) {
    let c = 0;
    let e = 0;
    for (let j = 0; j < n; j++) {
      c += out[at + j]!.v * s[p + j]!;
      e += s[p + j]! ** 2;
    }
    const norm = c / Math.sqrt(e * energyOut);
    if (norm > bestC) {
      bestC = norm;
      best = p;
    }
  }
  return { pos: best, peak: bestC };
}

async function startPlaying(r: Awaited<ReturnType<typeof rig>>): Promise<MusicPlayer> {
  for (const p of STEMS) r.backend.play({ path: p, url: p, loop: false, stream: false, bus: "Music", volume: 0 });
  await r.step(20);
  const player = createMusicPlayer(r.instance, segment(), {});
  const from = r.out.length;
  for (let k = 0; k < 200 && firstSound(r.out, from) < 0; k++) await r.step(1);
  expect(firstSound(r.out, from)).toBeGreaterThanOrEqual(0);
  return player;
}

/** After a mode rebuild: the re-entry's stamp, its start frame against continuous playback, and both stems' positions at the first sound. */
async function checkReentry(r: Awaited<ReturnType<typeof rig>>, player: MusicPlayer, t0: number, at: number) {
  const gapFrom = r.out.findIndex((o) => o.ctx === r.out[r.out.length - 1]!.ctx);
  for (let k = 0; k < 200 && firstSound(r.out, gapFrom) < 0; k++) await r.step(1);
  const on = firstSound(r.out, gapFrom);
  expect(on).toBeGreaterThan(0);
  await r.step(20);
  const run = player.run!;
  // The re-entry is the file position heard at the stamp on the old timeline (continuous playback), on a bar.
  expect(Math.abs(run.startFrame - (at - t0) * RATE)).toBeLessThanOrEqual(1);
  expect(run.startFrame % BAR_FRAMES).toBe(0);
  // Every stem at that position at the first sound: aligned with each other and with the grid.
  const positions = STEMS.map((_, k) => positionOf(r.out, on, k, run.startFrame));
  for (const p of positions) expect(p.peak).toBeGreaterThan(0.5);
  expect(positions[1]!.pos - positions[0]!.pos).toBe(0);
  expect(Math.abs(positions[0]!.pos - run.startFrame)).toBeLessThanOrEqual(1);
  // And the new context sounds it at the stamp's frame there (less the limiter's offset in output frames).
  expect(Math.abs(r.out[on]!.frame - r.backend.clockMap.frameOfTime(at))).toBeLessThanOrEqual(r.backend.clockMap.outputLatencyFrames + 1);
  return { on, positions, run };
}

describe("rhythm mode on the loopback host (ADR 0166 Rh1, architecture §4.6)", () => {
  it("turning it on rebuilds the context with latencyHint 0, reads the latency back, and the music re-enters aligned", async () => {
    const r = await rig(false);
    expect(r.host.latencyHint).toBe("interactive");
    const before = Audio.latency;
    expect(before.base).toBeCloseTo(0.01, 9);
    expect(before.output).toBeCloseTo(0.032, 9);
    expect(before.reliable).toBe(true); // a valid output timestamp
    expect(Audio.rhythmMode).toBe(false);

    const player = await startPlaying(r);
    await r.step(30);
    r.watchBeats(player);
    await r.step(40);
    const t0 = player.run!.startAt;
    const stamps = vi.spyOn(r.backend.musicOps, "stampGroup");
    const firedBefore = r.fired.length;
    expect(firedBefore).toBeGreaterThanOrEqual(1);
    r.slowOpen(45); // ≈ 0.48 s to open the new context: beats fall due while the backend rebuilds
    expect(await r.toggle(true)).toBe(true);

    // One mode rebuild, into a new context made with the numeric hint.
    expect(r.host.modeRebuilds).toBe(1);
    expect(r.hints).toEqual([RHYTHM_LATENCY_HINT]);
    expect(contextRebuilds(r.host)).toBe(1);
    expect(r.host.health.rebuilds).toBe(1);
    expect(r.host.rhythmMode).toBe(true);
    expect(r.host.pendingRhythmMode).toBeNull();
    expect(Audio.rhythmMode).toBe(true);
    const after = Audio.latency;
    expect(after.base).toBeCloseTo(0.0029, 9);
    expect(after.output).toBeCloseTo(0.008, 9);
    expect(after.limiter).toBeCloseTo(72 / RATE, 9);
    expect(after.total).toBeCloseTo(0.0029 + 0.008 + 72 / RATE, 9);
    expect(after.reliable).toBe(true);

    // P9's recovery: one stamp, every stem together where continuous playback would be; the beats held meanwhile.
    const at = (await waitStamp(r, stamps)).at;
    const { positions } = await checkReentry(r, player, t0, at);
    expect(player.counters.recoveries.rebuild).toBe(1);
    const beats = await checkHeldBeats(r, player, at, firedBefore);
    expect(beats.missed).toBeGreaterThanOrEqual(1); // the beats of the gap, held, then one call
    console.log(`[Rh1 on] stems ${positions.map((p) => p.pos).join(", ")}; latency ${(before.total * 1000).toFixed(2)} -> ${(after.total * 1000).toFixed(2)} ms; re-entry missed ${beats.missed}`);
    r.backend.dispose();
  });

  it("a trap rebuild in rhythm mode: callbacks held until the re-entry is stamped, then the gap as one call", async () => {
    const r = await rig(true);
    expect(r.host.latencyHint).toBe(RHYTHM_LATENCY_HINT);
    const player = await startPlaying(r);
    await r.step(10);
    r.watchBeats(player);
    await r.step(60); // ≈ 0.64 s of steady beats
    expect(r.fired.length).toBeGreaterThanOrEqual(2);
    expect(r.fired.every((f) => f.missed === 0)).toBe(true);
    const t0 = player.run!.startAt;
    const stamps = vi.spyOn(r.backend.musicOps, "stampGroup");
    const firedBefore = r.fired.length;
    expect(await r.trap()).toBe("rebuilt");
    expect(r.hints).toEqual([]); // a trap keeps the context, and its hint
    expect(r.host.latencyHint).toBe(RHYTHM_LATENCY_HINT);
    const at = (await waitStamp(r, stamps)).at;
    // Same context: frames continue, so the re-entry's position is the frames since the first stamp.
    expect(Math.abs(player.run!.startFrame - (at - t0) * RATE)).toBeLessThanOrEqual(1);
    const beats = await checkHeldBeats(r, player, at, firedBefore);
    console.log(`[Rh1 trap] re-entry at ${at.toFixed(4)} s with missed ${beats.missed}; ${r.rebuilding.length} rebuilding frames, all held`);
    r.backend.dispose();
  });

  it("outside rhythm mode nothing is held, and turning it off goes back to the interactive hint", async () => {
    const r = await rig(true);
    const player = await startPlaying(r);
    await r.step(10);
    r.watchBeats(player);
    await r.step(20);
    expect(await r.toggle(false)).toBe(true);
    expect(r.hints).toEqual(["interactive"]);
    expect(r.host.rhythmMode).toBe(false);
    expect(Audio.rhythmMode).toBe(false);
    expect(Audio.latency.output).toBeCloseTo(0.032, 9);
    expect(r.rebuilding.length).toBeGreaterThan(0);
    expect(r.rebuilding.every((x) => !x.held)).toBe(true);
    await r.step(150);
    expect(player.counters.recoveries.rebuild).toBe(1);
    expect(player.state === "committed" || player.state === "playing").toBe(true);
    expect(player.beats!.held).toBe(false);
    r.backend.dispose();
  });
});

/**
 * Rhythm mode's hold across a recovery: every frame the backend rebuilt was held; no callback fired between the
 * rebuild's start and the re-entry; the first one after it is the re-entry's bar at its heard time and carries the gap's
 * beats as `missed`; the next ones are steady. Returns the re-entry call.
 */
async function checkHeldBeats(r: Awaited<ReturnType<typeof rig>>, player: MusicPlayer, at: number, firedBefore: number): Promise<Fired> {
  await r.step(120);
  expect(r.rebuilding.length).toBeGreaterThan(0);
  expect(r.rebuilding.every((x) => x.held)).toBe(true);
  const lastBefore = r.fired[firedBefore - 1]!;
  const after = r.fired.slice(firedBefore);
  const gapStart = r.rebuilding[0]!.now;
  // Nothing fired from the rebuild's start (a beat heard just before it may still be in the frame's window) to the re-entry.
  for (const f of after) expect(f.time >= at - 1e-6 || f.time < gapStart + BEAT_SECONDS).toBe(true);
  expect(after.filter((f) => f.time < at - 1e-6).length).toBeLessThanOrEqual(1);
  const reentry = after.find((f) => f.time >= at - 1e-6)!;
  expect(reentry).toBeDefined();
  expect(reentry.time).toBeCloseTo(at, 6);
  expect(reentry.beat).toBe(1);
  const lastHeard = after.filter((f) => f.time < at - 1e-6).pop() ?? lastBefore;
  expect(reentry.missed).toBe(Math.round((at - lastHeard.time) / BEAT_SECONDS) - 1);
  const rest = after.slice(after.indexOf(reentry) + 1);
  expect(rest.length).toBeGreaterThanOrEqual(2);
  for (const f of rest) expect(f.missed).toBe(0);
  for (let k = 1; k < rest.length; k++) expect(rest[k]!.time - rest[k - 1]!.time).toBeCloseTo(BEAT_SECONDS, 6);
  expect(player.beats!.held).toBe(false);
  return reentry;
}

/** Steps until the recovery's stamp; its request. */
async function waitStamp(r: Awaited<ReturnType<typeof rig>>, stamps: { mock: { calls: unknown[][] } }): Promise<{ at: number }> {
  for (let k = 0; k < 200 && stamps.mock.calls.length === 0; k++) await r.step(1);
  expect(stamps.mock.calls.length).toBe(1);
  return stamps.mock.calls[0]![0] as { at: number };
}

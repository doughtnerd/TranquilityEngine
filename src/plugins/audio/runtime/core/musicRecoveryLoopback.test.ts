// ADR 0166 P9 (architecture §3.7, §3.8): music across a hard rebuild, a rate change and a hidden tab, end to end on the
// loopback host: the real `AudioHost` (respawn, recreate), the real `CoreBackend` and its `musicOps`, the real
// `Replayer` hand-off, the music player driven by the frame steps (visible) or by STATUS (hidden, `BackgroundController`
// with a fake page). Every stem is a decoded clip of its own pseudo-random noise, so the output's correlation with one
// stem's signal tells that stem's position on its own: "aligned" is the same position for every stem, and "the grid
// continues" is the position a continuous playback from the first stamp would have, and a re-entry on a bar.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import type { EventInstance } from "../events/eventRuntime";
import type { AudioBackground } from "../backend";
import { fakeDecoder } from "./fakeDecoder";
import { createClipRegistry } from "./clipRegistry";
import { AudioHost, presetFromSettings, type ContextParts } from "./context";
import { createCoreBackend, type CoreBackend } from "./coreBackend";
import { rebuildHost, watchForTraps, type RebuildOutcome } from "./recovery";
import { BackgroundController, type VisibilitySource } from "./background";
import { Unlock, type UnlockContext } from "./unlock";
import { _resetMusicPlayers, createMusicPlayer, musicEarlyStep, musicPlanStep, type MusicPlayer } from "../music/musicSystem";
import { _resetSegmentRuns, setSegmentClipSource } from "../music/segmentRun";
import { _resetMusicBackground } from "../music/background";

const RATE = 48_000;
const NEW_RATE = 44_100;
/** Stems are 6 s at 48 kHz (decoded: under the 30 s rule). */
const CLIP_FRAMES = 6 * RATE;
/** 240 bpm 4/4: a bar is 1 s, 48,000 frames. */
const BAR_FRAMES = RATE;
const STEMS = ["music/m0.wav", "music/m1.wav"];

/** Stem `k`'s signal: deterministic noise in ±0.1, independent between stems. */
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
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  _resetMusicPlayers();
  _resetSegmentRuns();
  _resetMusicBackground();
  vi.restoreAllMocks();
});

function fakeContext(rate: number) {
  const ctx = {
    state: "running",
    sampleRate: rate,
    destination: {},
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

/** A fake page whose visibility the test flips. */
function fakePage() {
  const listeners = new Set<() => void>();
  const page = {
    hidden: false,
    addEventListener: (_: "visibilitychange", fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: "visibilitychange", fn: () => void) => void listeners.delete(fn),
    set(hidden: boolean) {
      page.hidden = hidden;
      for (const fn of [...listeners]) fn();
    },
  };
  return page;
}

async function rig() {
  const testing = await import("../testing");
  const loop = await testing.createLoopbackHost();
  const target = new EventTarget();
  const first = fakeContext(RATE);
  const respawn = () => loop.respawn();
  const recreate = async (): Promise<ContextParts> => {
    const context = fakeContext(NEW_RATE);
    const { node, port } = loop.recreate(NEW_RATE);
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
  const mixer = new Mixer(defaultAudioSettings());
  const backend: CoreBackend = createCoreBackend(host, { clips, clock: loop.clock, mixer });
  watchForTraps(host, { now: () => 0, warn: () => {} });
  setSegmentClipSource({
    url: (p) => p,
    settings: () => ({ volume: 1, stream: false }),
    bus: () => "Music",
    facts: () => ({ frames: CLIP_FRAMES, rate: RATE, channels: 1, gapless: true }),
  });
  const page = fakePage();
  const controller = new BackgroundController({ host, target: backend, visibility: page as VisibilitySource, rebuild: async () => "unavailable" }).start();
  backend.addCleanup(() => controller.dispose());

  /** Left samples by their frame on the context that rendered them (a new context restarts at 0: `ctx` says which). */
  const out: { v: number; frame: number; ctx: number }[] = [];
  let ctxIndex = 0;
  const settle = async () => {
    for (let k = 0; k < 8; k++) await Promise.resolve();
  };
  /** One rendered frame of 4 quanta; visible, the frame steps run first (step 0, step 9, the backend's update). */
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      if (!page.hidden) {
        const dt = 512 / loop.sampleRate;
        musicEarlyStep(backend, dt);
        backend.beginFrame();
        musicPlanStep(backend, dt);
        mixer.update(dt);
        backend.update(dt);
      }
      for (let q = 0; q < 4; q++) {
        const start = loop.frame;
        const { left } = loop.renderQuanta(1);
        left.forEach((v, j) => out.push({ v, frame: start + j, ctx: ctxIndex }));
      }
      await settle();
    }
  };
  const rebuildAndWait = async (reason: "trap" | "rate", max = 80): Promise<RebuildOutcome | null> => {
    let outcome: RebuildOutcome | null = null;
    void rebuildHost(host, reason).then((o) => (outcome = o));
    if (reason === "rate") ctxIndex++;
    for (let k = 0; k < max && outcome === null; k++) await step(1);
    return outcome;
  };
  const instance = { group: 5, world: 0, path: "music.audioevent", asset: { bus: "Music", volume: 1 } } as unknown as EventInstance;
  return { loop, host, backend, clips, mixer, page, out, step, rebuildAndWait, instance, setMode: (m: AudioBackground) => backend.setBackground(m) };
}

/** Index in `out` of the first non-zero sample at or after `from`. */
function firstSound(out: readonly { v: number }[], from: number): number {
  for (let i = from; i < out.length; i++) if (out[i]!.v !== 0) return i;
  return -1;
}

/**
 * Stem `k`'s file position at `out[at]`: the lag in `guess ± range` whose window of `n` samples correlates best with the
 * stem's signal (the other stem is independent noise, so it doesn't move the peak). Returns the position and the
 * normalised peak (≈ 1 / √stems for a clean match).
 */
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

/** Plays the segment from `at` (heard seconds, NaN: as soon as possible) and steps until it sounds; the first sample's index. */
async function startPlaying(r: Awaited<ReturnType<typeof rig>>, at = Number.NaN): Promise<{ player: MusicPlayer; first: number }> {
  const player = createMusicPlayer(r.instance, segment(), Number.isFinite(at) ? { at } : {});
  const from = r.out.length;
  for (let k = 0; k < 200 && firstSound(r.out, from) < 0; k++) await r.step(1);
  const first = firstSound(r.out, from);
  expect(first).toBeGreaterThanOrEqual(0);
  return { player, first };
}

describe("music across a hard rebuild on the loopback host (ADR 0166 P9, architecture §3.7)", () => {
  it("re-enters every stem together on a bar, where continuous playback would be (same context, REPLAY)", async () => {
    const r = await rig();
    // Load both clips first (silent voices), so the first stamp doesn't wait for a clip.
    for (const p of STEMS) r.backend.play({ path: p, url: p, loop: false, stream: false, bus: "Music", volume: 0 });
    await r.step(20);
    const { player, first } = await startPlaying(r);
    await r.step(40);
    // Before the rebuild: both stems at the position since the first sound.
    const before = r.out.length - 4_096;
    for (let k = 0; k < STEMS.length; k++) expect(positionOf(r.out, before, k, before - first).pos).toBe(before - first);

    const oldGroup = player.run!.group;
    expect(await r.rebuildAndWait("trap")).toBe("rebuilt");
    expect(r.loop.cores).toBe(2);
    const gapFrom = r.out.length;
    // The music is silent from the rebuild until the re-entry (at most a bar plus a lead), then sounds again.
    for (let k = 0; k < 200 && firstSound(r.out, gapFrom) < 0; k++) await r.step(1);
    const on = firstSound(r.out, gapFrom);
    expect(on).toBeGreaterThan(0);
    expect(player.counters.recoveries.rebuild).toBe(1);
    expect(player.run!.group).not.toBe(oldGroup);
    expect(player.state === "committed" || player.state === "playing").toBe(true);
    await r.step(20);
    const expected = r.out[on]!.frame - r.out[first]!.frame;
    // On a bar of the segment's grid (the first stamp is bar 1).
    expect(Math.abs(expected - Math.round(expected / BAR_FRAMES) * BAR_FRAMES)).toBeLessThanOrEqual(1);
    const positions = STEMS.map((_, k) => positionOf(r.out, on, k, expected));
    for (const p of positions) expect(p.peak).toBeGreaterThan(0.5);
    // Aligned: every stem at the same position. Where it should be: within a frame of continuous playback.
    expect(positions[1]!.pos - positions[0]!.pos).toBe(0);
    expect(Math.abs(positions[0]!.pos - expected)).toBeLessThanOrEqual(1);
    // And it stays so a while later.
    const later = r.out.length - 4_096;
    const want = r.out[later]!.frame - r.out[first]!.frame;
    for (let k = 0; k < STEMS.length; k++) expect(Math.abs(positionOf(r.out, later, k, want).pos - want)).toBeLessThanOrEqual(1);
    console.log(`[P9 rebuild] re-entry ${(expected / BAR_FRAMES).toFixed(4)} bars in; stem offset ${positions[1]!.pos - positions[0]!.pos}; error ${positions[0]!.pos - expected} frames`);
    r.backend.dispose();
  });

  it("48 -> 44.1 kHz: Ê reset, the group re-primed at the heard position, both stems stamped at one frame", async () => {
    const r = await rig();
    for (const p of STEMS) r.backend.play({ path: p, url: p, loop: false, stream: false, bus: "Music", volume: 0 });
    await r.step(20);
    const { player } = await startPlaying(r);
    await r.step(30);
    const t0 = player.run!.startAt; // heard time of file frame 0
    const stamps = vi.spyOn(r.backend.musicOps, "stampGroup");
    (r.backend.musicOps as unknown as { ema: number }).ema = 90;
    expect(await r.rebuildAndWait("rate")).toBe("rebuilt");
    expect(r.backend.clockMap.sampleRate).toBe(NEW_RATE);
    const gapFrom = r.out.length;
    for (let k = 0; k < 200 && firstSound(r.out, gapFrom) < 0; k++) await r.step(1);
    const on = firstSound(r.out, gapFrom);
    expect(on).toBeGreaterThan(0);
    expect(player.counters.recoveries.rate).toBe(1);
    expect(r.backend.music.primeEmaMs).toBe(40);
    expect(stamps).toHaveBeenCalledTimes(1);
    const at = stamps.mock.calls[0]![0].at;
    const run = player.run!;
    // The start frame is the file position heard at the stamp (48 kHz file frames), on a bar.
    expect(Math.abs(run.startFrame - (at - t0) * RATE)).toBeLessThanOrEqual(1);
    expect(run.startFrame % BAR_FRAMES).toBe(0);
    // Both members in one stamp: one frame, one start frame (the core's PLAYs, back to back in one BATCH).
    expect(stamps.mock.results[0]!.value.filter((v: unknown) => v !== null)).toHaveLength(2);
    // The new context's output starts at the stamp's frame there.
    const planned = r.backend.clockMap.frameOfTime(at);
    expect(Math.abs(r.out[on]!.frame - planned)).toBeLessThanOrEqual(r.backend.clockMap.outputLatencyFrames + 1);
    console.log(`[P9 rate] startFrame ${run.startFrame} vs heard ${((at - t0) * RATE).toFixed(2)}; first sound at ${r.out[on]!.frame}, stamp ${planned}`);
    r.backend.dispose();
  });
});

describe("music across a hidden tab on the loopback host (ADR 0166 P9, architecture §3.8, ADR 0167 owner decision 5)", () => {
  for (const mode of ["play", "mute"] as const) {
    it(`under \`${mode}\`: a start due while hidden lands on time from the STATUS tick, and the music is in place, aligned, on resume`, async () => {
      const r = await rig();
      r.setMode(mode);
      for (const p of STEMS) r.backend.play({ path: p, url: p, loop: false, stream: false, bus: "Music", volume: 0 });
      await r.step(20);
      // Hidden from here: no frame step runs; STATUS keeps flowing and ticks the music.
      r.page.set(true);
      expect(r.backend.pageHidden).toBe(true);
      // Audio.play from a message handler while hidden, at 0.4 s from now: only the hidden tick can plan and stamp it.
      const at = r.backend.time + 0.4;
      const player = createMusicPlayer(r.instance, segment(), { at });
      const hiddenFrom = r.out.length;
      await r.step(120); // ≈ 1.3 s hidden
      expect(player.state === "committed" || player.state === "playing").toBe(true);
      expect(player.counters.recoveries.hidden).toBe(1);
      const stampFrame = r.backend.clockMap.frameOfTime(player.run!.startAt);
      expect(player.run!.startAt).toBeCloseTo(at, 9);
      if (mode === "play") {
        // Heard while hidden: the first sample is the stamp's (less the limiter latency's offset in output frames).
        const first = firstSound(r.out, hiddenFrom);
        expect(Math.abs(r.out[first]!.frame - stampFrame)).toBeLessThanOrEqual(r.backend.clockMap.outputLatencyFrames + 1);
      } else {
        // MASTER at 0 under mute: nothing heard (the ramp to 0 is over before the start).
        expect(firstSound(r.out, hiddenFrom + 4_096)).toBe(-1);
      }
      // Visible again: the music is where it would have been, every stem at the same position (after the unmute ramp).
      r.page.set(false);
      await r.step(30);
      const check = r.out.length - 4_096;
      const want = r.out[check]!.frame - (stampFrame + r.backend.clockMap.outputLatencyFrames);
      const positions = STEMS.map((_, k) => positionOf(r.out, check, k, want));
      for (const p of positions) expect(p.peak).toBeGreaterThan(0.5);
      expect(positions[1]!.pos - positions[0]!.pos).toBe(0);
      expect(Math.abs(positions[0]!.pos - want)).toBeLessThanOrEqual(1);
      console.log(`[P9 hidden ${mode}] stem offset ${positions[1]!.pos - positions[0]!.pos}; error ${positions[0]!.pos - want} frames`);
      r.backend.dispose();
    });
  }
});

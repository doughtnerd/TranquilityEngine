// @internal test fixture (ADR 0166 M4c, K1): display-frame jitter traces for the beat clock, recorded or synthesised,
// replayed through the engine's real `ClockMap`, and scored against the S4 tolerances (architecture §4.5).
//
// A trace is, per display frame, the rAF time `p` (ms), the heard frame Chromium's `getOutputTimestamp` reported at p
// (`hot`, what `ClockMap.beginFrame` reads) and the truth: the frame actually heard at p. `replayClock` feeds p and hot to
// a `ClockMap` (the fake host clock returns them, nothing else), giving each frame's `Audio.time` and Δ̄ exactly as the
// engine computes them. A scenario is the music: epochs (a segment each, with its tempo map, heard start and the rAF
// time main learned of it). `runScenario` plays it on a player through the beat clock (`testing/beatRig.ts`'s `drive`),
// promoting each successor after the frame it is heard in (the planner's step 9), and `score` buckets every beat as the
// spike did (`spikes/audio-music/beat-clock/run.mjs` `analyse`) and counts missed, doubled and phantom beats.
//
// Recorded: `traces/s3-interactive-60s.json`, the S3 confirming run (see `spikes/audio-music/beat-clock/extract-trace.mjs`).
// Synthesised: `synthTrace`, from the S3 run's measured distributions (frame intervals, timestamp jitter, rejected
// excursions, hitches, clock drift), or rougher than measured for the [U] device cases.
import { ClockMap } from "../../core/clock";
import type { HostClock, OutputTimestamp } from "../../core/hostClock";
import type { TempoMarker } from "../../../../../engine/audio/musicFormat";
import { anchorRun } from "../anchors";
import type { MusicPlayer } from "../musicSystem";
import { drive, musicSegment, playingRun, stampedRun, type Fired } from "./beatRig";
import recorded from "./traces/s3-interactive-60s.json";

/** One trace, decoded. Times in ms (`p`), frames at `sr`. */
export interface JitterTrace {
  readonly name: string;
  readonly sr: number;
  /** The core's output latency (the limiter), frames: `Audio.time` is the heard frame less this, over `sr`. */
  readonly limiterFrames: number;
  readonly p: Float64Array;
  readonly hot: Float64Array;
  /** The frame truly heard at each p. */
  readonly truth: Float64Array;
  /** Long frames: rAF time (ms) the hitch began, and its length. */
  readonly hitches: readonly { p: number; ms: number }[];
  readonly scenario: Scenario;
}

/** One epoch of the music: a segment heard from `start` (seconds, `Audio.time`'s base), learned at rAF time `knownAt`. */
export interface Epoch {
  readonly id: number;
  readonly tempo: TempoMarker[];
  readonly start: number;
  readonly knownAt: number;
}

export interface Scenario {
  readonly epochs: readonly Epoch[];
  /** Beat index (from 0) of the tempo change in epoch 1 (its beats around it are the `tempo` bucket). */
  readonly tempoBeat: number;
  /** The beats the core rendered, `[epoch, n, heard seconds]`, when recorded; else computed from the tempo maps. */
  readonly rendered?: readonly (readonly [number, number, number])[];
}

const T = (bpm: number): TempoMarker[] => [{ at: "1:1:0", bpm, beatsPerBar: 4, beatUnit: 4 }];
/** Epoch 1 of the spike: 120 bpm, 90 from beat `tempoBeat` (a bar line). */
const T1 = (tempoBeat: number): TempoMarker[] => [...T(120), { at: `${tempoBeat / 4 + 1}:1:0`, bpm: 90, beatsPerBar: 4, beatUnit: 4 }];

/** The recorded S3 trace (interactive latency, 60 s, idle machine, headless Chromium's null sink). */
export function recordedTrace(): JitterTrace {
  const r = recorded as unknown as {
    sr: number; limiterFrames: number; tempoBeat: number; p0: number; hot0: number; dp: number[]; dh: number[]; truth: number[];
    epochs: { id: number; S: number; bpm0: number; knownAt: number }[]; hitches: { p: number; ms: number }[]; rendered: [number, number, number][];
  };
  const n = r.dp.length;
  const p = new Float64Array(n), hot = new Float64Array(n), truth = new Float64Array(n);
  let pq = 0, hq = 0;
  for (let i = 0; i < n; i++) {
    pq += r.dp[i]!;
    hq += r.dh[i]!;
    p[i] = r.p0 + pq * 0.005;
    hot[i] = r.hot0 + hq / 100;
    truth[i] = hot[i]! + r.truth[i]! / 100;
  }
  const epochs = r.epochs.map((e) => ({ id: e.id, tempo: e.id === 1 ? T1(r.tempoBeat) : T(e.bpm0), start: e.S / r.sr, knownAt: e.knownAt }));
  return {
    name: "recorded S3, interactive", sr: r.sr, limiterFrames: r.limiterFrames, p, hot, truth, hitches: r.hitches,
    scenario: { epochs, tempoBeat: r.tempoBeat, rendered: r.rendered.map(([id, k, f]) => [id, k, f / r.sr] as const) },
  };
}

/** A deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthOptions {
  name: string;
  seed: number;
  seconds?: number;
  sr?: number;
  /** Render-ahead (ms): how long after a command the earliest stamp is heard (S3: 35 interactive, 9 at hint 0). */
  renderAheadMs?: number;
  /** Audio clock rate against `performance.now`, ppm (S3's fits: -6 .. -210, one +3650). */
  ppm?: number;
  /** Slow wander of the audio clock against `performance.now`, ms amplitude (period 20 s). */
  wanderMs?: number;
  /** Timestamp noise: Gaussian sd (ms); S3 measured 0.15-0.23 ms frame to frame. */
  noiseMs?: number;
  /** Timestamp quantisation (ms): the reported heard time is off by up to half of it (a device reporting per buffer). */
  quantumMs?: number;
  /** Timestamp excursions over the 5 ms gate per 60 s (S3: 10-20 rejected per run). */
  excursions?: number;
  /** Long frames (ms) at 10%, 20%, 35% of the run (S3: 100, 200, 300). */
  hitches?: readonly number[];
  /** rAF interval (ms) and its jitter (+- ms): S3 measured 16.665, p01 16.660, p99 16.670. */
  frameMs?: number;
  frameJitterMs?: number;
}

/**
 * A trace synthesised from S3's measured distributions, with the spike's scenario: a stamped start, a tempo change, a
 * stamped bar transition at half time and 8 seeks from 58% (stamped, as every M4 change is: learned one lead before).
 */
export function synthTrace(o: SynthOptions): JitterTrace {
  const sr = o.sr ?? 44_100, seconds = o.seconds ?? 60, rand = rng(o.seed);
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const frameMs = o.frameMs ?? 16.665, jitter = o.frameJitterMs ?? 0.005;
  const hitchAt = [0.1, 0.2, 0.35];
  const hitches = (o.hitches ?? [100, 200, 300]).map((ms, k) => ({ p: 160 + hitchAt[k]! * seconds * 1000, ms }));
  const ppm = o.ppm ?? -200, wander = o.wanderMs ?? 0.5, noise = o.noiseMs ?? 0.2, q = o.quantumMs ?? 0;
  const exc = o.excursions ?? 15;
  const heardAt = (pp: number): number =>
    ((pp - 160) / 1000) * sr * (1 + ppm * 1e-6) + 4000 + (wander / 1000) * sr * Math.sin((2 * Math.PI * pp) / 20_000);
  const P: number[] = [], H: number[] = [], TR: number[] = [];
  let pp = 160;
  let h = 0;
  while (pp < 160 + seconds * 1000) {
    const tr = heardAt(pp);
    let rep = tr + (gauss() * noise * sr) / 1000;
    if (q > 0) rep += (rand() - 0.5) * (q / 1000) * sr;
    if (rand() < exc / (seconds * 60)) rep += ((6 + 3 * rand()) / 1000) * sr;
    P.push(pp);
    H.push(rep);
    TR.push(tr);
    const hit = h < hitches.length && pp >= hitches[h]!.p ? hitches[h++]!.ms : 0;
    pp += hit > 0 ? Math.ceil(hit / frameMs) * frameMs : frameMs + (rand() < 0.5 ? 0 : rand() < 0.5 ? jitter : -jitter);
  }
  // The scenario, in heard seconds (Audio.time's base: the heard frame less the limiter, over sr).
  const D = 66;
  const atP = (x: number): number => (heardAt(x) - D) / sr;
  const ahead = (o.renderAheadMs ?? 35) / 1000;
  const tempoBeat = 28;
  const epochs: Epoch[] = [];
  const t1 = 1500 + 160;
  epochs.push({ id: 1, tempo: T1(tempoBeat), start: atP(t1) + ahead + 0.1, knownAt: t1 });
  const e1 = epochs[0]!.start;
  const beatOf1 = (n: number): number => e1 + Math.min(n, tempoBeat) * 0.5 + Math.max(0, n - tempoBeat) * (2 / 3);
  const tTr = 160 + 0.5 * seconds * 1000;
  let n = 0;
  while (beatOf1(n) < atP(tTr) + ahead + 0.1 || n % 4) n++;
  epochs.push({ id: 2, tempo: T(100), start: beatOf1(n), knownAt: tTr });
  for (let s = 0; s < 8; s++) {
    const tc = 160 + (0.58 + 0.045 * s) * seconds * 1000;
    epochs.push({ id: 3 + s, tempo: T(s % 2 ? 120 : 100), start: atP(tc) + ahead + 0.1, knownAt: tc });
  }
  return {
    name: o.name, sr, limiterFrames: D, p: Float64Array.from(P), hot: Float64Array.from(H), truth: Float64Array.from(TR), hitches,
    scenario: { epochs, tempoBeat },
  };
}

/** Each frame's `Audio.time` and Δ̄ (seconds) from the engine's `ClockMap` over the trace. */
export function replayClock(tr: JitterTrace): { time: Float64Array; interval: Float64Array; rejected: number; reanchors: number } {
  let i = 0;
  const host: HostClock = {
    rafTime: () => tr.p[i]!,
    outputTimestamp: (): OutputTimestamp => ({ contextTime: tr.hot[i]! / tr.sr, performanceTime: tr.p[i]! }),
    currentTime: () => tr.hot[i]! / tr.sr + 0.035,
    dateNow: () => tr.p[i]!,
    fake: true,
  };
  const cm = new ClockMap(host, tr.sr, tr.limiterFrames);
  const n = tr.p.length;
  const time = new Float64Array(n), interval = new Float64Array(n);
  for (i = 0; i < n; i++) {
    cm.beginFrame();
    time[i] = cm.audioTime();
    interval[i] = cm.frameIntervalMs / 1000;
  }
  return { time, interval, rejected: cm.rejected, reanchors: cm.reanchors };
}

/** The heard seconds (Audio.time's base) of beat `n` of an epoch, from its tempo map (independent of the grid code). */
function beatTime(e: Epoch, n: number): number {
  let t = e.start;
  const m = e.tempo;
  for (let k = 0; k < n; k++) {
    let bpm = m[0]!.bpm;
    for (const mk of m) {
      const [bar] = mk.at.split(":").map(Number);
      if ((bar! - 1) * 4 <= k) bpm = mk.bpm;
    }
    t += 60 / bpm;
  }
  return t;
}

/** The beats the core renders: each epoch's beats until the next epoch starts. */
function renderedOf(s: Scenario, until: number): (readonly [number, number, number])[] {
  if (s.rendered) return [...s.rendered];
  const out: (readonly [number, number, number])[] = [];
  s.epochs.forEach((e, k) => {
    const end = s.epochs[k + 1]?.start ?? until;
    for (let n = 0; ; n++) {
      const t = beatTime(e, n);
      if (t >= end - 1e-9 || t > until) break;
      out.push([e.id, n, t]);
    }
  });
  return out;
}

/** Plays the scenario on a player through the beat clock, frame by frame on the replayed clock. */
export function runScenario(tr: JitterTrace, clock = replayClock(tr)): { fired: Fired[]; player: MusicPlayer; nodeEpoch: Map<string, number> } {
  const nodes = tr.scenario.epochs.map((e) => musicSegment({ tempo: e.tempo }));
  const nodeEpoch = new Map(nodes.map((nd, k) => [nd.id, tr.scenario.epochs[k]!.id]));
  let player: MusicPlayer | null = null;
  let known = 0;
  const fired: Fired[] = [];
  for (let i = 0; i < tr.p.length; i++) {
    // Step 9 of the previous frame: a successor heard by then is promoted (as the planner, playlist and transition do).
    const next = player?.next;
    if (player && next && i > 0 && clock.time[i - 1]! >= next.startAt - 1e-6) {
      player.run = next;
      player.anchor = anchorRun(next, next.startAt);
      player.next = null;
    }
    // Main learns of an epoch (stamped, or an asap seek's STATUS confirmation in the recorded run).
    while (known < tr.scenario.epochs.length && tr.p[i]! >= tr.scenario.epochs[known]!.knownAt) {
      const e = tr.scenario.epochs[known]!;
      if (!player) player = playingRun(nodes[known]!, 0, e.start).player;
      else player.next = stampedRun(player, nodes[known]!, 0, e.start, 10 + known);
      known++;
    }
    if (player) for (const f of drive(player, [{ now: clock.time[i]!, interval: clock.interval[i]! }])) fired.push({ ...f, frame: i });
  }
  return { fired, player: player!, nodeEpoch };
}

/** One bucket's result (as the spike's tables). */
export interface Bucket {
  n: number;
  /** Fired frame minus ideal frame -> count (coalesced beats are counted where their call fired). */
  offsets: Record<number, number>;
  ideal: number;
}

export interface Score {
  buckets: Record<"steady" | "tempo" | "transition" | "hitch", Bucket>;
  missed: number;
  doubled: number;
  phantom: number;
  coalesced: number;
  /** Largest |fired time - rendered time| (s): the grid against the core's beats. */
  gridError: number;
}

/** Scores what the beat clock fired against the trace's truth (the spike's buckets and counts). */
export function score(tr: JitterTrace, fired: readonly Fired[], nodeEpoch: Map<string, number>): Score {
  const n = tr.p.length;
  const truthAt = Array.from(tr.truth, (f) => (f - tr.limiterFrames) / tr.sr);
  const lastHeard = truthAt[n - 2]!; // beats heard in the last frame's window may not have been asked for
  const rendered = renderedOf(tr.scenario, lastHeard).filter(([, , t]) => t < lastHeard);
  const idealOf = (t: number): number => {
    let lo = 0, hi = n - 1;
    if (t < truthAt[0]!) return -1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (truthAt[m]! <= t) lo = m;
      else hi = m - 1;
    }
    return lo;
  };
  const pOfHeard = (t: number): number => tr.p[Math.max(0, idealOf(t))]!;
  const switches = tr.scenario.epochs.slice(1).map((e) => e.start);
  const bucketOf = (id: number, k: number, t: number): keyof Score["buckets"] => {
    const pt = pOfHeard(t);
    if (tr.hitches.some((h) => pt >= h.p - 50 && pt <= h.p + h.ms + 1000)) return "hitch";
    if (switches.some((s) => Math.abs(t - s) < 1)) return "transition";
    if (id === tr.scenario.epochs[0]!.id && k >= tr.scenario.tempoBeat - 2 && k <= tr.scenario.tempoBeat + 3) return "tempo";
    return "steady";
  };
  // Fired beats in order; each accounts for itself and the `missed` beats before it.
  const beats = fired.filter((f) => f.kind === "beat");
  const key = (id: number, k: number): string => `${id}:${k}`;
  const renderedKeys = new Map(rendered.map(([id, k, t]) => [key(id, k), t]));
  const order = rendered.map(([id, k]) => key(id, k));
  const count = new Map<string, number>();
  const firedAt = new Map<string, number>();
  let phantom = 0, gridError = 0, coalesced = 0;
  for (const f of beats) {
    const id = nodeEpoch.get(f.e.segment)!;
    const k = (f.e.bar - 1) * 4 + f.e.beat - 1;
    const kk = key(id, k);
    const t = renderedKeys.get(kk);
    if (t === undefined) {
      if (f.e.time < lastHeard) phantom++;
      continue;
    }
    gridError = Math.max(gridError, Math.abs(t - f.e.time));
    count.set(kk, (count.get(kk) ?? 0) + 1);
    firedAt.set(kk, f.frame);
    // The coalesced ones: the `missed` rendered beats before it.
    const at = order.indexOf(kk);
    for (let m = 1; m <= f.e.missed && at - m >= 0; m++) {
      const c = order[at - m]!;
      count.set(c, (count.get(c) ?? 0) + 1);
      firedAt.set(c, f.frame);
      coalesced++;
    }
  }
  const empty = (): Bucket => ({ n: 0, offsets: {}, ideal: 0 });
  const buckets = { steady: empty(), tempo: empty(), transition: empty(), hitch: empty() };
  let missed = 0, doubled = 0;
  for (const [id, k, t] of rendered) {
    const kk = key(id, k);
    const c = count.get(kk) ?? 0;
    if (c === 0) {
      missed++;
      continue;
    }
    if (c > 1) doubled++;
    const b = buckets[bucketOf(id, k, t)];
    const off = firedAt.get(kk)! - idealOf(t);
    b.n++;
    b.offsets[off] = (b.offsets[off] ?? 0) + 1;
    if (off === 0) b.ideal++;
  }
  return { buckets, missed, doubled, phantom, coalesced, gridError };
}

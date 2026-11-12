// ADR 0166 M4b (Bench1): the main thread's cost of music per frame, wall clock (architecture §7.3: "beat dispatch: nanoseconds
// per instance per frame; no budget line"). The planner and the frame step on the fake backend with a deterministic clock:
// - steady: `musicPlanStep` (step 9, every player's tick: reloads, containers, transition, planner, tails, stingers, stems)
//   with 1, 4 and 16 players each playing an 8-stem segment, timed per frame;
// - seam: one player requesting a change to another 8-stem segment on the bar and carrying it through priming, the stamp and
//   the swap, timed per frame of that run (the planner's decision is the dearest frame).
//
// Like `selectionBench`, timing in a shared test run is noisy, so each case takes the best of a few attempts and the gates are
// loose (a tripwire against a planner that scans or allocates per frame, not a budget): the audio thread has the allowances
// (`tools/audio-bench`, the metered music scenes); the main thread's line is only this.
import { afterEach, describe, expect, it } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { _resetMusicPlayers, createMusicPlayer, musicPlanStep, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { _resetSegmentRuns, setSegmentClipSource } from "./segmentRun";
import { planTick, requestStart, type PlanRequest } from "./planner";

const RATE = 48_000;
const L = 1 / 30;
const DT = 1 / 60;
const STEMS = 8;
const FRAMES = 2000;
const ATTEMPTS = 4;
/** Loose gates, microseconds: one frame of every player's tick, and the dearest frame of a seam. */
const GATE_STEADY_P99_US = { 1: 100, 4: 250, 16: 600 } as const;
const GATE_SEAM_MAX_US = 1_500;

const clips = (prefix: string): string[] => Array.from({ length: STEMS }, (_, k) => `music/${prefix}${k}.ogg`);
const FACTS: Record<string, MusicClipFacts> = Object.fromEntries(
  [...clips("a"), ...clips("b")].map((c) => [c, { frames: 120 * RATE, rate: RATE, channels: 2, gapless: true }]),
);

function segment(id: string, files: string[]): SegmentNode {
  const node = parseSegmentNode({ type: "segment", id, gridOffset: 0, tracks: files.map((clip, k) => ({ name: `t${k}`, clip })) }, "bench", newMusicContext());
  if (!node) throw new Error("fixture segment did not parse");
  return node;
}

let groupIds = 7;
const instance = (): EventInstance => ({ group: groupIds++, world: 1, path: "music.audioevent", asset: { bus: "Music", volume: 1 } }) as unknown as EventInstance;

let b: FakeBackend;
const f = { backend: null as unknown as FakeBackend, music: null as FakeBackend["music"] | null, now: 0, dt: DT, hidden: false };

/** Sets the clock to `now`: Audio.time and the horizon (now + L). */
function at(now: number): MusicFrame {
  f.now = now;
  (b as { time: number }).time = now;
  b.horizonTime = now + L;
  return f as unknown as MusicFrame;
}

function rig(): void {
  b = makeFakeBackend();
  setAudioBackend(b);
  f.backend = b;
  f.music = b.music ?? null;
  setSegmentClipSource({ url: (p) => `/assets/${p}`, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master", facts: (p) => FACTS[p] });
  at(1);
}

/** A player whose first segment (8 streamed stems) is primed, stamped and playing. */
function playingPlayer(): MusicPlayer {
  const player = createMusicPlayer(instance(), segment("A", clips("a")));
  planTick(player, at(1));
  b.music!.setPrimed(player.planned!.run.group);
  planTick(player, at(1 + DT));
  planTick(player, at(1.2));
  if (player.state !== "playing") throw new Error(`the bench's player is ${player.state}`);
  return player;
}

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
});

interface Result {
  p50: number;
  p99: number;
  max: number;
}

function summarize(us: Float64Array): Result {
  const sorted = Float64Array.from(us).sort();
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { p50: at(0.5), p99: at(0.99), max: sorted[sorted.length - 1]! };
}

/** One attempt: `players` playing players, `FRAMES` timed steps (after a warm-up), microseconds per frame. */
function steady(players: number): Result {
  rig();
  for (let k = 0; k < players; k++) playingPlayer();
  const times = new Float64Array(FRAMES);
  let now = 1.2;
  for (let k = 0; k < 300 + FRAMES; k++) {
    now += DT;
    at(now);
    const t0 = performance.now();
    musicPlanStep(b, DT);
    if (k >= 300) times[k - 300] = (performance.now() - t0) * 1000;
  }
  const result = summarize(times);
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
  return result;
}

/** One attempt: a player changes to another segment on the bar; each frame of the run (request, priming, the stamp, the swap), microseconds. */
function seam(): Result {
  rig();
  const player = playingPlayer();
  const bars = (nb: number): number => Math.ceil(nb / 0.5 - 1e-9) * 0.5;
  const times: number[] = [];
  let now = 1.35;
  for (let n = 0; n < 40; n++) {
    const to = segment(`B${n}`, clips(n % 2 === 0 ? "b" : "a"));
    const req: PlanRequest = { to, reason: "switch", grid: "bar", notBefore: Number.NaN, startFrame: 0, points: bars };
    const t0 = performance.now();
    const planned = requestStart(player, req, at(now));
    times.push((performance.now() - t0) * 1000);
    if (!planned) throw new Error("the bench's change was refused");
    // Frames to the stamp: primed after one frame, then until the swap.
    for (let k = 0; k < 90 && player.planned; k++) {
      now += DT;
      if (k === 1) b.music!.setPrimed(planned.run.group);
      const t1 = performance.now();
      planTick(player, at(now));
      times.push((performance.now() - t1) * 1000);
    }
    now += 1;
  }
  const result = summarize(Float64Array.from(times));
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
  return result;
}

/** The best attempt by the case's own figure. */
function best(run: () => Result, key: "p99" | "max"): Result {
  let out: Result | null = null;
  for (let k = 0; k < ATTEMPTS; k++) {
    const r = run();
    if (out === null || r[key] < out[key]) out = r;
  }
  return out!;
}

describe("music on the main thread (ADR 0166 M4b Bench1, wall clock)", () => {
  for (const players of [1, 4, 16] as const) {
    it(`steady: ${players} player${players === 1 ? "" : "s"} of ${STEMS} stems, one frame step`, () => {
      const r = best(() => steady(players), "p99");
      console.log(`[bench] musicPlanStep, ${players} playing player(s): p50 ${r.p50.toFixed(2)} us, p99 ${r.p99.toFixed(2)} us, max ${r.max.toFixed(1)} us per frame`);
      expect(r.p99).toBeLessThan(GATE_STEADY_P99_US[players]);
    });
  }

  it("seam: a change on the bar to another 8-stem segment, request to swap", () => {
    const r = best(seam, "max");
    console.log(`[bench] a seam (request, priming, stamp, swap), per call: p50 ${r.p50.toFixed(2)} us, p99 ${r.p99.toFixed(2)} us, max ${r.max.toFixed(1)} us`);
    expect(r.max).toBeLessThan(GATE_SEAM_MAX_US);
  });
});

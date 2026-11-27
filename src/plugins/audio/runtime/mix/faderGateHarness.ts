// ADR 0171 amended by 0172 (task Fg1; api-and-models §6.6, architecture §4.7 and §7): the fader gate's harness.
//
// The gate is measured on the AUDIO CLOCK: from the input event's timestamp to the first core sample that differs from the
// no-edit render, in frames the loopback host rendered converted at its rate. Nothing here reads a wall clock: the
// simulated main thread keeps one virtual time in audio-clock milliseconds; while the drags run, the page's
// `performance.now` reads it and `setTimeout` schedules on it (the live path's coalescing window and timer use those),
// and a drag's events, the coalescing timer and the main-thread frames are all events on it.
//
// The model (the loopback host has no threads): between two quanta the main thread runs every event whose time is at or
// before the next quantum's first frame (an event inside a quantum is seen by the worklet before the next one, as a posted
// message is); the host then renders one quantum. So an event at time `e` posts at `max(e, window end)`, reaches the core
// at the first quantum start at or after that, and the first changed sample follows from the core's own asap rule.
//
// A drag = 3..10 `setBus volume` events (`mixer.apply` + `backend.flushNow()`, the preview path) at 1..16.7 ms spacing,
// from the volume the bus holds to a new one. Variation (seeded): the start phase inside a quantum (fractional ms), the
// phase and cadence of the main-thread frame (8.3, 16.7, 33.3, 50 ms: the rig's `mainFrame`, ADR 0434), and, on half the
// drags, an edit of a silent bus posted 0.2..3.8 ms before the first event so the first event lands inside the coalescing
// window and waits for its end.
import { vi } from "vitest";
import { mixer, DRAG_RAMP_MS } from "../../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { Kind, LANE_AUTHORED, Op, readBusRamp } from "../wire.generated";
import { presetFromSettings } from "../core/context";
import { loopbackAudio } from "../testing";

export const RATE = 48_000;
export const QUANTUM = 128;
export const LEVEL = 0.5;
export const CLIP_FRAMES = 48_000;
/** Main-thread frame lengths: 120, 60, 30 and 20 fps. */
const CADENCES_MS = [8.333, 16.667, 33.333, 50];
/** Pointer-move spacings: 1 kHz mouse to a 60 Hz one. */
const SPACINGS_MS = [1, 2, 4, 8.333, 16.667];

const PROJECT = {
  buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "Voice", parent: "Master" }],
};
const VOICE_SLOT = 2;

/** mulberry32: the gate's seeded stream, so every run draws the same drags. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank percentile of `xs` (`p` in 0..1). */
export function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)]!;
}

export interface DragResult {
  /** The first event's audio-clock time, ms. */
  eventMs: number;
  /** Event to the post that carried its ramp (the coalescing wait, or a frame's BATCH when `preview` is off), ms. */
  toPostMs: number;
  /** That post to the first frame of the quantum that applies it (the worklet picks it up between quanta), ms. */
  toAppliedMs: number;
  /** That quantum's first frame to the first changed sample (the core's asap start and the ramp's first step), ms. */
  toSampleMs: number;
  /** The whole gate figure: event to first changed sample, ms. */
  totalMs: number;
  /** The first changed core frame. */
  changedFrame: number;
  cadenceMs: number;
  /** Whether the first event fell inside the coalescing window of a precursor post. */
  precursor: boolean;
  /** The settled output after the drag minus `LEVEL x` the drag's final volume. */
  settleError: number;
  /** The output was constant before the batch reached the core (the no-edit render). */
  baselineHeld: boolean;
}

export interface GateOptions {
  seed: number;
  drags: number;
  /** The preview path (`flushNow` after each `apply`); false leaves the batch for the main-thread frame (the commit path). */
  preview?: boolean;
}

interface Ev {
  t: number;
  seq: number;
  fn: () => void;
}

/** Builds the loopback rig (ADR 0221: `loopbackAudio`, the production assembly); null where the wasm cannot be built. */
async function build() {
  const settings = parseAudioSettings(PROJECT).settings;
  const audio = await loopbackAudio({
    settings,
    preset: { ...presetFromSettings(settings), limiterLookaheadMs: 0 },
    decode: () => ({ channelData: [new Float32Array(CLIP_FRAMES).fill(LEVEL)] }),
  });
  if (!audio) return null;
  /** Every BATCH the core received: its virtual post time (the sim's at the post), the core frame it arrived at and its Voice authored ramps. */
  const posts: { atMs: number; frame: number; voiceRamp: boolean }[] = [];
  const watch = audio.watch();
  /** Moves what was posted since the last call into `posts`, at virtual time `atMs` (called after each main-thread event). */
  const collect = (atMs: number) => {
    for (const { frame, batch } of watch.takeReceived()) {
      if (batch.kind !== Kind.BATCH) continue;
      const voiceRamp = batch.records.some((x) => x.opcode === Op.BUS_RAMP && x.voiceId === VOICE_SLOT && readBusRamp(x.view, x.off).lane === LANE_AUTHORED);
      posts.push({ atMs, frame, voiceRamp });
    }
  };
  return { audio, posts, collect };
}
/** Runs the seeded drags on a fresh loopback rig and returns one result per drag; null when the wasm is unavailable. */
export async function runFaderGate(options: GateOptions): Promise<DragResult[] | null> {
  const rig = await build();
  if (!rig) return null;
  const { audio, posts, collect } = rig;
  const backend = audio.backend;
  const preview = options.preview ?? true;
  const rand = rng(options.seed);
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;

  // The virtual main thread: one time in audio-clock ms, a queue of events and the frame tick.
  let now = 0;
  let seq = 0;
  const queue: Ev[] = [];
  const at = (t: number, fn: () => void) => {
    queue.push({ t, seq: seq++, fn });
    queue.sort((a, b) => a.t - b.t || a.seq - b.seq);
  };
  let cadence = 16.667;
  let nextTick = cadence;
  // The page's clock and timer are the virtual main thread's while the drags run (restored before returning).
  const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
  const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    at(now + (ms ?? 0), fn);
    return 0;
  }) as unknown as typeof setTimeout);

  const trace: number[] = [];
  let traceBase = 0;
  /** Runs the main thread and renders until the host's next quantum starts at or after `untilMs`. */
  const runTo = async (untilMs: number) => {
    while ((audio.frame * 1000) / RATE < untilMs) {
      const start = (audio.frame * 1000) / RATE;
      for (;;) {
        const e = queue[0];
        const tickDue = nextTick <= start && (!e || nextTick <= e.t);
        if (tickDue) {
          now = nextTick;
          audio.mainFrame(cadence / 1000); // ADR 0434: mixer, backend frame, playlists
          collect(now);
          nextTick += cadence;
        } else if (e && e.t <= start) {
          queue.shift();
          now = e.t;
          e.fn();
          collect(now);
        } else break;
      }
      now = start;
      const { left } = audio.render(1);
      for (let i = 0; i < left.length; i++) trace.push(left[i]!);
      await audio.settle();
      collect(now);
    }
  };

  backend.play({ path: "const.wav", url: "const.wav", loop: true, stream: false, bus: "Voice" });
  await runTo(200);
  let volume = 1;
  const results: DragResult[] = [];

  for (let d = 0; d < options.drags; d++) {
    // The no-edit render: the output holds one value since the last settle.
    const base = trace[trace.length - 1]!;
    trace.length = 0;
    traceBase = audio.frame;
    const postsBefore = posts.length;
    cadence = pick(CADENCES_MS);
    const e0 = now + between(8, 40);
    nextTick = e0 + rand() * cadence;
    const precursor = rand() < 0.5;
    if (precursor) {
      // A silent bus's edit, posted just ahead: the first Voice event lands inside its coalescing window.
      const lead = between(0.2, 3.8);
      const musicTo = 0.2 + rand() * 0.8;
      at(e0 - lead, () => {
        mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: musicTo });
        if (preview) backend.flushNow();
      });
    }
    let target = 0.1 + rand() * 0.9;
    while (Math.abs(target - volume) < 0.2) target = 0.1 + rand() * 0.9;
    const n = 3 + Math.floor(rand() * 8);
    let t = e0;
    for (let i = 1; i <= n; i++) {
      const v = volume + ((target - volume) * i) / n;
      at(t, async () => {
        mixer.apply({ op: "setBus", bus: "Voice", key: "volume", value: v });
        if (preview) backend.flushNow();
      });
      if (i < n) t += pick(SPACINGS_MS);
    }
    // Run until every event, timer and the 10 ms ramp have passed, plus a margin to read the settled level.
    await runTo(t + 4 + DRAG_RAMP_MS + 60);
    if (queue.length > 0 && queue[0]!.t <= now) throw new Error("fader gate harness: an event was left unprocessed");
    volume = target;

    const post = posts.slice(postsBefore).find((p) => p.voiceRamp && p.atMs >= e0)!;
    const firstIdx = trace.findIndex((v) => v !== base);
    const changedFrame = traceBase + firstIdx;
    const appliedMs = (post.frame * 1000) / RATE;
    const changedMs = (changedFrame * 1000) / RATE;
    const last = trace.slice(-QUANTUM);
    results.push({
      eventMs: e0,
      toPostMs: post.atMs - e0,
      toAppliedMs: appliedMs - post.atMs,
      toSampleMs: changedMs - appliedMs,
      totalMs: changedMs - e0,
      changedFrame,
      cadenceMs: cadence,
      precursor,
      settleError: Math.max(...last.map((v) => Math.abs(v - LEVEL * target))),
      baselineHeld: firstIdx >= 0 && trace.slice(0, firstIdx).every((v) => v === base) && changedFrame >= post.frame,
    });
  }
  clockSpy.mockRestore();
  timerSpy.mockRestore();
  await audio.close();
  return results;
}

/** p50, p95, max of one field over the drags. */
export function summarize(rs: readonly DragResult[], field: "totalMs" | "toPostMs" | "toAppliedMs" | "toSampleMs") {
  const xs = rs.map((r) => r[field]);
  return { p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), max: Math.max(...xs) };
}

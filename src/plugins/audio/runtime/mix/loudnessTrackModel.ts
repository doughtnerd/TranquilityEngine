// ADR 0171 amended by 0172 (M5a, task Pf6, leaf L-Pf6a; api-and-models §5.5, §7 `loudnessTrackModel.ts`): the profiler's
// loudness series as a pure model (no DOM, no Preact, no clock, no Worker). The Worker (Pf6's lead) walks a capture's
// records in order and calls `feed` for each STATUS, `addKeyframe` for each KEYFRAME, `epoch` for each EPOCH and `control`
// for each loudnessControl EVENT; the track reads `series`, `valuesAt` and `targetMarks`.
//
// The numbers are the live meter's. Each bus owns a `LoudnessStats` (the shared Ld3 module, never reimplemented) and is
// fed exactly as `runtime/mix/loudnessHub.ts` feeds its meters, through the same `LoudnessFeedControl` (loudnessStats.ts):
// a RESET flag calls `epoch()` except on the meter's first take, then `takeBlock(firstSeq, ...)`, then `notePeak(truePeak)`;
// a STATUS with `loudShed` pauses every meter but the final output's and its end resumes them marking `incomplete` (the
// hub's ladder); a script's own pause resumes without marking. The one difference is granularity: the hub takes a
// STATUS's sub-blocks in one `takeBlock`; here they go in one at a time (`takeBlock(firstSeq + j, e, j, 1)` after a
// zero-count `takeBlock(firstSeq, ...)` that does the gap check), which leaves the stats in the identical state and lets
// every 100 ms sub-block carry its own sample.
//
// Two modes per model:
// - `"replay"` (the capture is fed from its first record): M, S, I, LRA, the maximum true peak and `incomplete` all come
//   from the `LoudnessStats`, so a reopened capture reads the live meter's values bit for bit.
// - `"seek"` (fed from a point inside the capture, e.g. one segment before the cursor): the stats cannot be seeded with a
//   histogram, so only M, S and the peak since the start point come from the sub-blocks (exact once 4 and 30 sub-blocks have
//   arrived). I, LRA, the maximum true peak and `incomplete` are held at the latest keyframe's reading (api §5.5: "holds I
//   and LRA at the last keyframe's value, at most 1 s stale"); before the first keyframe they read `-Infinity` / false.
// `keyframes` may be added in either mode; a replay model ignores their readings but keeps them (`keyframeAt`).
//
// Time. All times are seconds on the viewport axis. `feed`'s `time` is when the STATUS's newest sub-block completed;
// sub-block j of n is at `time - (n - 1 - j) * 0.1`. Times must not go backwards (the axis is continuous across epochs,
// §5.4): a sample earlier than the previous one is clamped to it, which keeps `valuesAt`'s binary search valid.
//
// Marks warn and nothing more: this module holds no setter on the mixer, the buses or the target (a target is read, never
// written), and `targetMarks` returns data.
import type { KeyframeMetered } from "../capture/format";
import { LOUD_FLAG_NEW_BLOCKS_MASK, LOUD_FLAG_RESET, LOUD_OUTPUT_TAP } from "../wire.generated";
import { LoudnessFeedControl, LoudnessStats, SUB_BLOCK_SECONDS, linearToDb, type LoudnessStatsResetWhat } from "./loudnessStats";

/** Keyframe `metered` flag bits (format.ts `KeyframeMetered.flags`). */
export const KF_METERED_PAUSED = 1;
export const KF_METERED_INCOMPLETE = 2;
export const KF_METERED_TAINTED = 4;
export const KF_METERED_LOWER_BOUND = 8;

export type LoudnessModelMode = "replay" | "seek";

/** One `loudBuses` item (structurally `StatusLoudBusesItem`). */
export interface LoudnessStatusItem {
  slot: number;
  flags: number;
  firstSeq: number;
  /** Linear. */
  truePeak: number;
}

/** The loudness part of a STATUS (structurally a `StatusBlock`) and its time. */
export interface LoudnessStatusInput {
  time: number;
  loudShed: number;
  loudBuses: readonly LoudnessStatusItem[];
  /** Bus-major in `loudBuses` order, oldest first; each item's new-block count (flags bits 0-5) says how many are its. */
  loudEnergies: ArrayLike<number>;
}

/** What the loudnessControl EVENT records (event reasons 1 reset, 2 pause, 3 resume). */
export type LoudnessControl = { kind: "reset"; what?: LoudnessStatsResetWhat } | { kind: "pause" } | { kind: "resume" };

/** A span the series has no audio for. */
export interface LoudnessGap {
  /** `"lost"`: sub-blocks the core's ring overwrote; `"epoch"`: a rebuild or a core-side reset restarted the feed. */
  kind: "lost" | "epoch";
  from: number;
  to: number;
  /** Sub-blocks lost (0 for an epoch). */
  lost: number;
}

/** The series of one bus; arrays are live (they grow), parallel and read-only: sample i is at `time[i]`. */
export interface LoudnessSeries {
  readonly slot: number;
  readonly time: readonly number[];
  /** LUFS; `-Infinity` where undefined (as the live meter). */
  readonly momentary: readonly number[];
  readonly shortTerm: readonly number[];
  readonly integrated: readonly number[];
  /** LU. */
  readonly lra: readonly number[];
  /** dBTP, the maximum since the last maximum reset (the live `maxTruePeak`). */
  readonly truePeak: readonly number[];
  /** dBTP of the STATUS the sample belongs to (its own true-peak maximum; `-Infinity` when none). */
  readonly peak: readonly number[];
  /** 1 once the meter is `incomplete` at the sample. */
  readonly incomplete: readonly number[];
  readonly gaps: readonly LoudnessGap[];
}

/** The values at a time: the newest sample at or before it. */
export interface LoudnessValues {
  /** The sample's time (<= the asked time). */
  time: number;
  momentary: number;
  shortTerm: number;
  integrated: number;
  lra: number;
  truePeak: number;
  peak: number;
  incomplete: boolean;
}

/** A target as `audio.loudnessTargets` has it (structurally `LoudnessTarget`); only read. */
export interface LoudnessTargetLike {
  readonly name?: string;
  readonly integrated: number;
  readonly tolerance: number;
  readonly truePeak: number;
}

export type LoudnessMarkMetric = "integrated" | "shortTerm" | "momentary" | "truePeak";

/**
 * A span outside the target. `over`: above `integrated + tolerance` (or, for `truePeak`, above the ceiling); `under`: below
 * `integrated - tolerance`. `from` is the first violating sample's time, `to` the last's. Warn only.
 */
export interface LoudnessMark {
  /** The bus's core slot (`LOUD_OUTPUT_TAP` for the final output). */
  bus: number;
  kind: "over" | "under";
  metric: LoudnessMarkMetric;
  from: number;
  to: number;
}

export interface TargetMarkOptions {
  /** Which loudness readings to judge against `integrated +- tolerance`; default `["integrated"]` (the live check's reading). */
  metrics?: readonly Exclude<LoudnessMarkMetric, "truePeak">[];
  /** Judge each STATUS's true peak against the ceiling (marks `over`, metric `truePeak`); default true. */
  truePeak?: boolean;
}

function binarySearchLast(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return at;
}

/** One bus: its stats, its series and the hub's pause bookkeeping. */
export class LoudnessBusModel implements LoudnessSeries {
  /** The shared statistics; exposed so a test (and the Worker's keyframe-less readers) can compare with a live feed. */
  readonly stats = new LoudnessStats();
  readonly time: number[] = [];
  readonly momentary: number[] = [];
  readonly shortTerm: number[] = [];
  readonly integrated: number[] = [];
  readonly lra: number[] = [];
  readonly truePeak: number[] = [];
  readonly peak: number[] = [];
  readonly incomplete: number[] = [];
  readonly gaps: LoudnessGap[] = [];
  /** The hub's pause bookkeeping and first-take rule (the same class the live meter uses). */
  private readonly feedControl = new LoudnessFeedControl(this.stats);
  /** The newest keyframe reading seen (any mode). */
  private held: KeyframeMetered | null = null;
  private lastPeak = Number.NEGATIVE_INFINITY;

  constructor(readonly slot: number, readonly mode: LoudnessModelMode = "replay") {}

  /** The newest keyframe reading added, or null. */
  get keyframe(): KeyframeMetered | null {
    return this.held;
  }

  /** The ladder's state changed (`loudShed !== 0`), as the hub's `setLadder`: the final output keeps metering. */
  setShed(on: boolean): void {
    this.feedControl.setLadder(on, this.slot === LOUD_OUTPUT_TAP);
  }

  /** One `loudBuses` item and its `count` energies from `energies[offset]`, the STATUS completing at `time`. */
  take(time: number, item: LoudnessStatusItem, energies: ArrayLike<number>, offset: number, count: number): void {
    const st = this.stats;
    const first = time - Math.max(0, count - 1) * SUB_BLOCK_SECONDS;
    const restarted = this.feedControl.beginTake((item.flags & LOUD_FLAG_RESET) !== 0);
    if (restarted) this.gaps.push({ kind: "epoch", from: first, to: first, lost: 0 });
    const lostBefore = st.lost;
    st.takeBlock(item.firstSeq, energies, offset, 0);
    const lost = st.lost - lostBefore;
    if (lost > 0) this.gaps.push({ kind: "lost", from: first - lost * SUB_BLOCK_SECONDS, to: first, lost });
    st.notePeak(item.truePeak);
    this.lastPeak = linearToDb(item.truePeak);
    // A take with no sub-blocks that still restarted the feed (a loss: the output meters on through a ladder shed while
    // the STATUS carries none of its sub-blocks; or a reset) changes the readings: one sample at the STATUS shows it.
    if (count === 0 && (lost > 0 || restarted) && !st.paused) this.sample(time);
    for (let j = 0; j < count; j++) {
      st.takeBlock((item.firstSeq + j) >>> 0, energies, offset + j, 1);
      if (!st.paused) this.sample(first + j * SUB_BLOCK_SECONDS);
    }
  }

  /** A loudnessControl EVENT at `time`. A sample at `time` shows the effect (a reset drops I at the reset). */
  control(time: number, what: LoudnessControl): void {
    if (what.kind === "reset") {
      this.stats.reset(what.what ?? "all");
      if ((what.what ?? "all") !== "integrated") this.lastPeak = Number.NEGATIVE_INFINITY;
    } else this.feedControl.setScriptPaused(what.kind === "pause");
    this.sample(time);
  }

  /** An EPOCH record: the feed restarts (I, LRA and the maxima stay, `incomplete` is set), as the hub's `epoch`. */
  epoch(time: number): void {
    this.stats.epoch();
    this.gaps.push({ kind: "epoch", from: time, to: time, lost: 0 });
    this.sample(time);
  }

  /**
   * A KEYFRAME's reading for this bus at `time`. It applies to the samples after it; one at exactly `time` (the STATUS the
   * keyframe was written with) is patched, so a seek landing on a keyframe reads the keyframe's I.
   */
  addKeyframe(time: number, reading: KeyframeMetered): void {
    this.held = reading;
    const n = this.time.length;
    if (this.mode === "seek" && n > 0 && this.time[n - 1] === time) this.patch(n - 1);
  }

  private heldIntegrated(): number {
    return this.held ? this.held.integrated : Number.NEGATIVE_INFINITY;
  }

  private patch(i: number): void {
    const h = this.held;
    this.integrated[i] = h ? h.integrated : Number.NEGATIVE_INFINITY;
    this.lra[i] = h ? h.lra : Number.NEGATIVE_INFINITY;
    this.truePeak[i] = this.heldPeak();
    this.incomplete[i] = this.heldIncomplete() ? 1 : 0;
  }

  private heldPeak(): number {
    const kf = this.held ? this.held.maxTruePeak : Number.NEGATIVE_INFINITY;
    return Math.max(kf, this.stats.maxTruePeak);
  }

  private heldIncomplete(): boolean {
    return this.stats.incomplete || (this.held !== null && (this.held.flags & KF_METERED_INCOMPLETE) !== 0);
  }

  private sample(time: number): void {
    const st = this.stats;
    const n = this.time.length;
    this.time.push(n > 0 && time < this.time[n - 1]! ? this.time[n - 1]! : time);
    this.momentary.push(st.momentary);
    this.shortTerm.push(st.shortTerm);
    this.peak.push(this.lastPeak);
    if (this.mode === "replay") {
      this.integrated.push(st.integrated);
      this.lra.push(st.lra);
      this.truePeak.push(st.maxTruePeak);
      this.incomplete.push(st.incomplete ? 1 : 0);
    } else {
      this.integrated.push(this.heldIntegrated());
      this.lra.push(this.held ? this.held.lra : Number.NEGATIVE_INFINITY);
      this.truePeak.push(this.heldPeak());
      this.incomplete.push(this.heldIncomplete() ? 1 : 0);
    }
  }

  /** The newest sample at or before `t`, or null before the first. */
  valuesAt(t: number): LoudnessValues | null {
    const i = binarySearchLast(this.time, t);
    if (i < 0) return null;
    return {
      time: this.time[i]!, momentary: this.momentary[i]!, shortTerm: this.shortTerm[i]!, integrated: this.integrated[i]!, lra: this.lra[i]!,
      truePeak: this.truePeak[i]!, peak: this.peak[i]!, incomplete: this.incomplete[i] === 1,
    };
  }

  /** Spans outside `target`; see {@link LoudnessMark}. Reads the target, changes nothing. */
  marks(target: LoudnessTargetLike, options: TargetMarkOptions = {}): LoudnessMark[] {
    const out: LoudnessMark[] = [];
    const metrics = options.metrics ?? ["integrated"];
    const hi = target.integrated + target.tolerance;
    const lo = target.integrated - target.tolerance;
    for (const metric of metrics) {
      const values = this[metric];
      collect(out, this.slot, this.time, values, "over", metric, (v) => v > hi);
      collect(out, this.slot, this.time, values, "under", metric, (v) => v > Number.NEGATIVE_INFINITY && v < lo);
    }
    if (options.truePeak !== false) collect(out, this.slot, this.time, this.peak, "over", "truePeak", (v) => v > target.truePeak);
    return out.sort((a, b) => a.from - b.from || a.to - b.to);
  }
}

/** Appends one mark per run of consecutive samples where `bad` holds. */
function collect(
  out: LoudnessMark[], bus: number, times: readonly number[], values: readonly number[], kind: "over" | "under", metric: LoudnessMarkMetric,
  bad: (v: number) => boolean,
): void {
  let from = -1;
  for (let i = 0; i < values.length; i++) {
    if (bad(values[i]!)) {
      if (from < 0) from = i;
    } else if (from >= 0) {
      out.push({ bus, kind, metric, from: times[from]!, to: times[i - 1]! });
      from = -1;
    }
  }
  if (from >= 0) out.push({ bus, kind, metric, from: times[from]!, to: times[values.length - 1]! });
}

/** The whole profiler loudness model: one {@link LoudnessBusModel} per metered slot, created on first sight. */
export class LoudnessTrackModel {
  private readonly buses = new Map<number, LoudnessBusModel>();
  private ladderOn = false;

  constructor(readonly mode: LoudnessModelMode = "replay") {}

  /** Slots seen, in first-seen order. */
  slots(): number[] {
    return [...this.buses.keys()];
  }

  /** The bus model of `slot` (null until it has been fed). */
  bus(slot: number): LoudnessBusModel | null {
    return this.buses.get(slot) ?? null;
  }

  private ensure(slot: number): LoudnessBusModel {
    let b = this.buses.get(slot);
    if (!b) {
      b = new LoudnessBusModel(slot, this.mode);
      if (this.ladderOn) b.setShed(true);
      this.buses.set(slot, b);
    }
    return b;
  }

  /** The series of `slot`, or null. Arrays are live. */
  series(slot: number): LoudnessSeries | null {
    return this.buses.get(slot) ?? null;
  }

  /** One STATUS's loudness sections, as `LoudnessHub.feed` reads them. */
  feed(status: LoudnessStatusInput): void {
    const shed = status.loudShed !== 0;
    if (shed !== this.ladderOn) {
      this.ladderOn = shed;
      for (const b of this.buses.values()) b.setShed(shed);
    }
    const items = status.loudBuses;
    const energies = status.loudEnergies;
    let off = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      let count = it.flags & LOUD_FLAG_NEW_BLOCKS_MASK;
      if (off + count > energies.length) count = Math.max(0, energies.length - off);
      this.ensure(it.slot).take(status.time, it, energies, off, count);
      off += count;
    }
  }

  /** A KEYFRAME's `metered` section at `time` (seconds on the axis). */
  addKeyframe(time: number, metered: readonly KeyframeMetered[]): void {
    for (const m of metered) this.ensure(m.slot).addKeyframe(time, m);
  }

  /** An EPOCH record at `time`: every bus restarts its feed. */
  epoch(time: number): void {
    for (const b of this.buses.values()) b.epoch(time);
  }

  /** A loudnessControl EVENT at `time` for every bus, or for `slot` only. */
  control(time: number, what: LoudnessControl, slot?: number): void {
    if (slot !== undefined) this.buses.get(slot)?.control(time, what);
    else for (const b of this.buses.values()) b.control(time, what);
  }

  /** Values of `slot` at `t` (null when the bus is unknown or `t` is before its first sample). */
  valuesAt(slot: number, t: number): LoudnessValues | null {
    return this.buses.get(slot)?.valuesAt(t) ?? null;
  }

  /** Marks of every bus against `target`, by start time. Warn only: nothing here changes a bus, a fader or the target. */
  targetMarks(target: LoudnessTargetLike, options?: TargetMarkOptions): LoudnessMark[] {
    const out: LoudnessMark[] = [];
    for (const b of this.buses.values()) out.push(...b.marks(target, options));
    return out.sort((a, b) => a.from - b.from || a.to - b.to);
  }
}

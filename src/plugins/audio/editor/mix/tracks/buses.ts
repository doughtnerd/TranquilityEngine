// ADR 0171 amended by 0172 (M5a, task Pf3c; api-and-models §7 "bus levels", "bus gain factors"): the profiler's two bus
// tracks, both read from `seek` samples on a fixed time grid (the STATUS `peaks` and the KEYFRAME's bus rows are not
// `range` columns):
//
//   - `buses.level` (lanes): one line per bus, the STATUS peak (the larger of left and right) on the mixer meter's dB scale
//     (`meterFill`, 0..1 from -60 dB to 0 dB). The tooltip gives each bus's peak in dB.
//   - `buses.gain` (line): one line per bus, the effective gain (the product of the seven lanes) of the keyframe in force.
//     The tooltip lists each bus's product and the lanes off unity (`busFactorsModel.ts` does the arithmetic).
//
// The grid is every `GRID_BASE_S` seconds, doubled while it would hold more than `MAX_GRID_SAMPLES` points; a sample is
// cached by its time, so a live capture's refresh seeks only the new points (a stride doubling reuses the even ones).
// A keyframe is in force from its own instant until the next, so a gain step shows within one grid step of the keyframe
// that carries it. A bus is named from META's bus names; a bus that is a tombstone at the instant is named from the project
// section the take started with (`meta.audio.buses`, by slot), since the slot may since have been recycled. Pure TypeScript, no DOM.
import { meterFill } from "../../BusMeters";
import { busFactors, formatDb, gainToDb, type BusFactors } from "../busFactorsModel";
import type { LineSeries, TrackData } from "../drawTimeline";
import type { ProfileSource } from "../profilerSource";
import type { TrackContext, TrackFactory, TrackModule } from "./types";

export const BUS_LEVEL_TRACK_ID = "buses.level";
export const BUS_GAIN_TRACK_ID = "buses.gain";

/** The finest grid step, seconds. */
export const GRID_BASE_S = 0.5;
/** The most grid points a capture is sampled at. */
export const MAX_GRID_SAMPLES = 512;

/** The grid step for a capture of `duration` seconds: `GRID_BASE_S` doubled until at most `MAX_GRID_SAMPLES` points fit. */
export function gridStride(duration: number): number {
  let s = GRID_BASE_S;
  while (duration / s + 1 > MAX_GRID_SAMPLES) s *= 2;
  return s;
}

/** What one seek contributes: the STATUS peaks (null before the first STATUS) and the keyframe's bus rows (null before the first keyframe). */
export interface BusSample {
  /** Viewport seconds (0 = the capture's first record). */
  time: number;
  /** Peak per bus slot, linear, left and right; `null` when no STATUS is at or before the sample. */
  peaks: readonly { l: number; r: number }[] | null;
  /** The keyframe in force: its buses' factors; `null` when there is none, or it carries no bus rows. */
  factors: readonly BusFactors[] | null;
}

/** The seek samples of one capture; both tracks share it. */
export class BusSampler {
  private readonly cache = new Map<number, BusSample>();
  private readonly byKeyframe = new Map<number, readonly BusFactors[] | null>();
  private chain: Promise<void> = Promise.resolve();
  private list: readonly BusSample[] = [];

  constructor(private readonly source: ProfileSource) {}

  /** The samples on the current grid, ascending in time. */
  get samples(): readonly BusSample[] {
    return this.list;
  }

  /** Seeks the grid points not yet cached; calls queue, so two tracks refreshing together do the work once. */
  refresh(): Promise<void> {
    const run = async (): Promise<void> => {
      const stride = gridStride(this.source.duration);
      const n = Math.floor(this.source.duration / stride) + 1;
      const next: BusSample[] = [];
      for (let k = 0; k < n; k++) {
        const t = k * stride;
        let s = this.cache.get(t);
        if (!s) {
          s = await this.sampleAt(t);
          this.cache.set(t, s);
        }
        next.push(s);
      }
      const keep = new Set(next.map((s) => s.time));
      for (const t of [...this.cache.keys()]) if (!keep.has(t)) this.cache.delete(t);
      this.list = next;
    };
    const p = this.chain.then(run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async sampleAt(t: number): Promise<BusSample> {
    const state = await this.source.seek(this.source.startSeconds + t);
    let factors: readonly BusFactors[] | null = null;
    if (state.keyframe && state.keyframe.buses.length > 0) {
      const seq = state.keyframeSeq;
      const known = this.byKeyframe.get(seq);
      factors = known !== undefined ? known : state.keyframe.buses.map(busFactors);
      this.byKeyframe.set(seq, factors);
    }
    return { time: t, peaks: state.status ? state.status.peaks.map((p) => ({ l: p.l, r: p.r })) : null, factors };
  }
}

/** A bus's name at a sample: META's name for a live bus; for a tombstone, the take's project section first. */
export function busName(ctx: Pick<TrackContext, "source" | "names">, slot: number, tombstone: boolean): string {
  const audio = ctx.source.summary.meta.audio as { buses?: unknown } | null | undefined;
  const list = audio && typeof audio === "object" && Array.isArray(audio.buses) ? (audio.buses as unknown[]) : [];
  const entry = list[slot] as { name?: unknown } | null | undefined;
  const fromProject = entry && typeof entry.name === "string" ? entry.name : undefined;
  const fromMeta = ctx.names.bus(slot);
  return (tombstone ? (fromProject ?? fromMeta) : (fromMeta ?? fromProject)) ?? `bus ${slot}`;
}

const BUS_COLORS = ["accent", "accent2", "warning", "danger", "text", "muted"] as const satisfies readonly LineSeries["color"][];
const colorOf = (slot: number): LineSeries["color"] => BUS_COLORS[slot % BUS_COLORS.length]!;

/** The last sample at or before `t`. */
function sampleAtOrBefore(samples: readonly BusSample[], t: number): BusSample | undefined {
  let lo = 0;
  let hi = samples.length - 1;
  let found: BusSample | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.time <= t) {
      found = samples[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

const tombstoneAt = (s: BusSample, slot: number): boolean => s.factors?.find((f) => f.slot === slot)?.tombstone ?? false;
const peakOf = (p: { l: number; r: number } | undefined): number => (p ? Math.max(p.l, p.r) : 0);

// --- levels -------------------------------------------------------------------------------------------------------------

/** One bus's level line: `values` is `meterFill` of the larger channel's peak. */
export interface BusLevelLine {
  slot: number;
  times: Float64Array;
  values: Float64Array;
}

/**
 * A line per bus slot, from the samples that have a STATUS. A slot is drawn when a peak above silence was ever read on it
 * or `named(slot)` is true (a configured bus that stayed silent still gets its flat line, never a missing one).
 */
export function busLevelLines(samples: readonly BusSample[], named: (slot: number) => boolean): BusLevelLine[] {
  const measured = samples.filter((s) => s.peaks !== null);
  if (measured.length === 0) return [];
  let slots = 0;
  for (const s of measured) slots = Math.max(slots, s.peaks!.length);
  const times = Float64Array.from(measured, (s) => s.time);
  const lines: BusLevelLine[] = [];
  for (let slot = 0; slot < slots; slot++) {
    const values = Float64Array.from(measured, (s) => meterFill(peakOf(s.peaks![slot])));
    if (named(slot) || values.some((v) => v > 0)) lines.push({ slot, times, values });
  }
  return lines;
}

/** The level lanes as `TrackData` (each on the meter's 0..1 scale); `undefined` when nothing was measured. */
export function busLevelData(lines: readonly BusLevelLine[]): TrackData | undefined {
  if (lines.length === 0) return undefined;
  return { lines: lines.map((l) => ({ times: l.times, values: l.values, color: colorOf(l.slot), yMax: 1 })) };
}

/** The hover text: each bus's peak in dB at the STATUS in force at `t`, one per line; `null` with no STATUS yet. */
export function busLevelTooltip(samples: readonly BusSample[], t: number, nameOf: (slot: number, tombstone: boolean) => string, named: (slot: number) => boolean): string | null {
  const s = sampleAtOrBefore(samples, t);
  if (!s || !s.peaks) return null;
  const rows: string[] = [];
  s.peaks.forEach((p, slot) => {
    if (named(slot) || peakOf(p) > 0) rows.push(`${nameOf(slot, tombstoneAt(s, slot))}: peak ${formatDb(gainToDb(peakOf(p)))}`);
  });
  return rows.length ? rows.join("\n") : null;
}

// --- gain factors ---------------------------------------------------------------------------------------------------------

/** One bus's effective-gain line: the product of its seven lanes at each sample's keyframe. */
export interface BusGainLine {
  slot: number;
  times: Float64Array;
  values: Float64Array;
}

/** A line per slot that any keyframe carries, over the samples whose keyframe has a row for it. */
export function busGainLines(samples: readonly BusSample[]): BusGainLine[] {
  const slots = new Set<number>();
  for (const s of samples) for (const f of s.factors ?? []) slots.add(f.slot);
  return [...slots].sort((a, b) => a - b).map((slot) => {
    const t: number[] = [];
    const v: number[] = [];
    for (const s of samples) {
      const f = s.factors?.find((x) => x.slot === slot);
      if (f) {
        t.push(s.time);
        v.push(f.product);
      }
    }
    return { slot, times: Float64Array.from(t), values: Float64Array.from(v) };
  });
}

export function busGainData(lines: readonly BusGainLine[]): TrackData | undefined {
  if (lines.length === 0) return undefined;
  return { lines: lines.map((l) => ({ times: l.times, values: l.values, color: colorOf(l.slot) })) };
}

/** One bus's tooltip line: its effective gain and the lanes off unity, e.g. `Music: product 0.398 (-8.0 dB) = authored -6.0 dB x duck -2.0 dB`. */
export function busFactorsText(name: string, f: BusFactors): string {
  const head = f.tombstone ? `${name} (removed)` : name;
  if (f.nonUnity.length === 0) return `${head}: product 1.000 (0.0 dB), every lane at unity`;
  const lanes = f.factors.filter((x) => !x.unity).map((x) => `${x.lane} ${formatDb(x.db)}`).join(" x ");
  return `${head}: product ${f.product.toFixed(3)} (${formatDb(f.productDb)}) = ${lanes}`;
}

/** The hover text at `t`: every bus of the keyframe in force, one per line; `null` before the first keyframe. */
export function busGainTooltip(samples: readonly BusSample[], t: number, nameOf: (slot: number, tombstone: boolean) => string): string | null {
  const s = sampleAtOrBefore(samples, t);
  if (!s || !s.factors) return null;
  return s.factors.map((f) => busFactorsText(nameOf(f.slot, f.tombstone), f)).join("\n");
}

// --- the tracks -------------------------------------------------------------------------------------------------------------

/** The bus level lanes and the bus gain factors line. */
export const busTracks: TrackFactory = (ctx): readonly TrackModule[] => {
  const sampler = new BusSampler(ctx.source);
  const nameOf = (slot: number, tombstone: boolean): string => busName(ctx, slot, tombstone);
  const named = (slot: number): boolean => ctx.names.bus(slot) !== undefined;
  let level: TrackData | undefined;
  let gain: TrackData | undefined;
  const build = (): void => {
    level = busLevelData(busLevelLines(sampler.samples, named));
    gain = busGainData(busGainLines(sampler.samples));
  };
  return [
    {
      track: { id: BUS_LEVEL_TRACK_ID, label: "Bus levels", kind: "lanes", height: 110, visible: true },
      data: () => level,
      async refresh() {
        await sampler.refresh();
        build();
      },
      tooltipAt: (t) => busLevelTooltip(sampler.samples, t, nameOf, named),
    },
    {
      track: { id: BUS_GAIN_TRACK_ID, label: "Bus gain", kind: "line", height: 70, visible: true },
      data: () => gain,
      async refresh() {
        await sampler.refresh();
        build();
      },
      tooltipAt: (t) => busGainTooltip(sampler.samples, t, nameOf),
    },
  ];
};

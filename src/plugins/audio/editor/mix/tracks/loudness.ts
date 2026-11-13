// ADR 0171 amended by 0172 (M5b, task Pf6; api-and-models §7 "the loudness track"): the profiler's loudness track as a
// `TrackFactory` (`types.ts`). The series are built in the capture Worker (`worker.ts`, from the STATUS records' sub-blocks
// with the shared `LoudnessStats`) and fetched through `loudnessSource.ts`; this module only shapes them for
// `drawTimeline.ts`:
//
//   - `loudness`, a line track with M (momentary), S (short-term) and I (integrated) for every bus the capture meters (the
//     final output included) and the target's integrated level as a line (`warning`); and `loudness.marks`, a ticks track
//     with a tick (`danger`) at the start of each over/under mark. The marks are the model's
//     (`LoudnessTrackModel.targetMarks`): they warn, nothing here or in the Worker adjusts a bus, a fader or the target.
//   - the canvas scales a line from 0, and LUFS is negative, so a line is drawn as `LUFS - LOUDNESS_PLOT_FLOOR` (0 at -70 LUFS, the
//     meter's absolute gate, to `LOUDNESS_PLOT_RANGE` at 0 LUFS). An undefined reading (`-Infinity`) is left out, so a gap is a
//     gap and not a floor, as the CPU line does.
//   - `tooltipAt(t)` is the readout at `t`: M, S, I, LRA and the true-peak maximum per bus, the target and the marks in force.
//
// The panel gives the factory the target in force (`audio.loudnessTargets` through `Audio.loudnessTarget`); without one the
// track has no target line and no marks.
import { LOUD_OUTPUT_TAP } from "../../../runtime/wire.generated";
import { SUB_BLOCK_SECONDS } from "../../../runtime/mix/loudnessStats";
import type { CaptureLoudnessMark, CaptureLoudnessTarget, CaptureLoudnessValues } from "../../../runtime/capture/format";
import type { LineSeries, TrackData } from "../drawTimeline";
import { LoudnessSource, canAskLoudness, type LoudnessInfo, type LoudnessSeriesData } from "../loudnessSource";
import type { ProfileSource } from "../profilerSource";
import type { TrackContext, TrackFactory, TrackModule } from "./types";

/** The plotted value of a reading is `LUFS - LOUDNESS_PLOT_FLOOR`. */
export const LOUDNESS_PLOT_FLOOR = -70;
/** The top of the scale in the same units (0 LUFS). */
export const LOUDNESS_PLOT_RANGE = 70;
export const LOUDNESS_TRACK_ID = "loudness";
export const LOUDNESS_MARKS_TRACK_ID = "loudness.marks";

/** One bus's cached series: the readings the lines and the tooltip use. */
interface BusSeries {
  slot: number;
  series: LoudnessSeriesData;
}

/** A level as text: `-23.1`, or `-inf` where undefined. */
export function formatLevel(v: number): string {
  if (Number.isNaN(v) || v === Number.NEGATIVE_INFINITY) return "-inf";
  return v.toFixed(1);
}

/** One bus's line of the tooltip. */
export function formatBusReadout(name: string, v: CaptureLoudnessValues): string {
  return `${name}: M ${formatLevel(v.momentary)}  S ${formatLevel(v.shortTerm)}  I ${formatLevel(v.integrated)} LUFS  LRA ${formatLevel(v.lra)} LU  TP ${formatLevel(v.truePeak)} dBTP${v.incomplete ? "  (incomplete)" : ""}`;
}

/** The marks in force at `t` as words (a run's last sample holds for one more sub-block). */
export function formatMarks(marks: readonly CaptureLoudnessMark[], t: number, name: (slot: number) => string): string[] {
  const out: string[] = [];
  for (const m of marks) if (m.from <= t && t <= m.to + SUB_BLOCK_SECONDS) out.push(`${name(m.bus)}: ${m.kind} target (${m.metric === "truePeak" ? "true peak" : m.metric})`);
  return out;
}

/** The track module: `TrackModule` plus what the cursor readout and the empty state read. */
export interface LoudnessTrackModule extends TrackModule {
  /** How the series was built (`"seek"`: a truncated capture, I and LRA held at the keyframes' readings); null before the first refresh. */
  mode(): LoudnessInfo["mode"] | null;
  /** The buses with samples, in the Worker's order. */
  slots(): readonly number[];
  /** The marks of the last refresh, by start time (empty without a target). */
  marks(): readonly CaptureLoudnessMark[];
  /** The ticks track of the marks (`loudness.marks`), refreshed with this one. */
  readonly marksTrack: TrackModule;
  /** The Worker's values at viewport time `t` for every bus (the cursor's M, S and I). */
  valuesAt(t: number): Promise<{ slot: number; values: CaptureLoudnessValues | null }[]>;
}

export interface LoudnessTrackOptions {
  /** The target in force, read at each refresh (null: none). Only read, never written. */
  target?: () => CaptureLoudnessTarget | null;
  /** The client for a source (default: a `LoudnessSource` over a source that can be asked; null: no loudness, no track data). */
  client?: (source: ProfileSource) => LoudnessSource | null;
}

function defaultClient(source: ProfileSource): LoudnessSource | null {
  return canAskLoudness(source) ? new LoudnessSource(source) : null;
}

function lastAtOrBefore(times: ArrayLike<number>, t: number): number {
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

class LoudnessTrack implements LoudnessTrackModule {
  readonly track = { id: LOUDNESS_TRACK_ID, label: "Loudness", kind: "line", height: 72, visible: true } as const;
  private info: LoudnessInfo | null = null;
  private buses: BusSeries[] = [];
  private markList: CaptureLoudnessMark[] = [];
  private targetNow: CaptureLoudnessTarget | null = null;
  private drawn: TrackData | undefined;
  private inflight: Promise<void> | null = null;
  readonly marksTrack: TrackModule = {
    track: { id: LOUDNESS_MARKS_TRACK_ID, label: "Loudness target", kind: "ticks", height: 20, visible: true },
    data: () => (this.targetNow ? { ticks: Float64Array.from(this.markList.map((m) => m.from)), tickColor: "danger" } : undefined),
    refresh: () => this.refresh(),
    tooltipAt: (t) => {
      const words = formatMarks(this.markList, t, (slot) => this.busName(slot));
      return words.length > 0 ? words.join("\n") : null;
    },
  };

  constructor(private readonly ctx: TrackContext, private readonly client: LoudnessSource | null, private readonly options: LoudnessTrackOptions) {}

  private busName(slot: number): string {
    return this.ctx.names.bus(slot) ?? (slot === LOUD_OUTPUT_TAP ? "Master" : `Bus ${slot}`);
  }

  mode(): LoudnessInfo["mode"] | null {
    return this.info?.mode ?? null;
  }

  slots(): readonly number[] {
    return this.buses.map((b) => b.slot);
  }

  marks(): readonly CaptureLoudnessMark[] {
    return this.markList;
  }

  valuesAt(t: number): Promise<{ slot: number; values: CaptureLoudnessValues | null }[]> {
    return this.client ? this.client.valuesAt(t) : Promise.resolve([]);
  }

  /** One read at a time: the two tracks' refreshes in the same turn share it. */
  refresh(): Promise<void> {
    return (this.inflight ??= this.read().finally(() => { this.inflight = null; }));
  }

  private async read(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const info = await client.info();
    const buses = await Promise.all(info.buses.filter((b) => b.samples > 0).map(async (b) => ({ slot: b.slot, series: await client.series(b.slot) })));
    const target = this.options.target?.() ?? null;
    const marks = target ? await client.marks(target) : [];
    this.info = info;
    this.buses = buses;
    this.targetNow = target;
    this.markList = marks;
    this.drawn = this.build();
  }

  private build(): TrackData | undefined {
    if (this.buses.length === 0) return undefined;
    const lines: LineSeries[] = [];
    for (const { series } of this.buses) {
      const c = series.columns;
      for (const [values, color] of [[c.momentary, "muted"], [c.shortTerm, "accent2"], [c.integrated, "accent"]] as const) {
        const times: number[] = [];
        const plotted: number[] = [];
        for (let i = 0; i < values.length; i++) {
          const v = values[i]!;
          if (v === Number.NEGATIVE_INFINITY || Number.isNaN(v)) continue;
          times.push(c.time[i]!);
          plotted.push(Math.max(0, v - LOUDNESS_PLOT_FLOOR));
        }
        lines.push({ times, values: plotted, color, yMax: LOUDNESS_PLOT_RANGE });
      }
    }
    const target = this.targetNow;
    if (target) {
      const end = Math.max(this.ctx.source.duration, 0);
      lines.push({ times: [0, end], values: [target.integrated - LOUDNESS_PLOT_FLOOR, target.integrated - LOUDNESS_PLOT_FLOOR], color: "warning", yMax: LOUDNESS_PLOT_RANGE });
    }
    return { lines };
  }

  data(): TrackData | undefined {
    return this.drawn;
  }

  tooltipAt(t: number): string | null {
    if (this.buses.length === 0) return null;
    const rows: string[] = [];
    for (const { slot, series } of this.buses) {
      const c = series.columns;
      const i = lastAtOrBefore(c.time, t);
      if (i < 0) continue;
      rows.push(formatBusReadout(this.busName(slot), {
        time: c.time[i]!, momentary: c.momentary[i]!, shortTerm: c.shortTerm[i]!, integrated: c.integrated[i]!, lra: c.lra[i]!,
        truePeak: c.truePeak[i]!, peak: c.peak[i]!, incomplete: c.incomplete[i] === 1,
      }));
    }
    if (rows.length === 0) return null;
    const target = this.targetNow;
    if (target) {
      rows.push(`Target${target.name ? ` ${target.name}` : ""}: ${formatLevel(target.integrated)} LUFS +/- ${formatLevel(target.tolerance)} LU, ${formatLevel(target.truePeak)} dBTP`);
      rows.push(...formatMarks(this.markList, t, (slot) => this.busName(slot)));
    }
    return rows.join("\n");
  }
}

/** The factory with the panel's target; `loudnessTrackFactory` is the one without. */
export function loudnessTracks(options: LoudnessTrackOptions = {}): TrackFactory {
  return (ctx) => {
    const main = new LoudnessTrack(ctx, (options.client ?? defaultClient)(ctx.source), options);
    return [main, main.marksTrack];
  };
}

export const loudnessTrackFactory: TrackFactory = loudnessTracks();

// ADR 0171 amended by 0172 (M5a, task Pf3b; api-and-models §7, architecture §9): the profiler's click headline and the
// ladder, as tracks.
//
//   - `counters.underruns`, `counters.late`: ticks, one per STATUS sample at which the cumulative counter rose
//     (`counterTicks`). The canvas keeps every tick at every zoom (`downsampleTicks` marks a bucket if any tick falls in
//     it), so a recorded underrun is drawn however far out the viewport is; a dense burst shares buckets, never hides one.
//   - `counters.slack`: `minSlackFrames` as a line on one scale, split by `slackLevel` (green > 64, amber 1 to 64, red
//     <= 0: the theme's accent, warning, danger). Negative slack (an underrun) sits on the scale's floor in red.
//   - `counters.ladder`: lanes, the steps in force (`ladderSeries.level`: bed and zone steps plus the loudness step) and
//     the voice cap (`voiceSeries.cap`, the core's `mixedCap`); `counters.ladderSteps`: ticks where the ladder rose or fell.
//
// One `range` over the union of the columns, shared by the five modules; `refresh` re-reads the whole capture (a counter's
// tick needs the sample before it, and a capture's STATUS count is small). Pure TypeScript; the canvas draws.
import { RANGE_SECONDS, type CaptureRangeColumns } from "../../../runtime/capture/reader";
import type { LineSeries, TrackData } from "../drawTimeline";
import { COUNTER_COLUMNS, LADDER_COLUMNS, VOICE_COLUMNS, counterTicks, ladderSeries, rangeColumn, slackLevel, slackSeries, voiceSeries, type Level, type LadderSeries } from "../cpuTrack";
import { statusColumns } from "../profilerSource";
import type { Track } from "../timelineModel";
import { indexAtOrBefore } from "./cpu";
import type { TrackContext, TrackFactory, TrackModule } from "./types";

export const UNDERRUN_TRACK = "counters.underruns";
export const LATE_TRACK = "counters.late";
export const SLACK_TRACK = "counters.slack";
export const LADDER_TRACK = "counters.ladder";
export const LADDER_STEPS_TRACK = "counters.ladderSteps";

const COLUMNS = [...new Set([...COUNTER_COLUMNS, ...LADDER_COLUMNS, ...VOICE_COLUMNS])];
const LEVEL_COLOR = { green: "accent", amber: "warning", red: "danger" } as const;
const LEVELS: readonly Level[] = ["green", "amber", "red"];

/** What one read holds: the raw columns the tooltips quote, and the series the canvas draws. */
interface Read {
  times: Float64Array;
  cols: CaptureRangeColumns;
  underrun: Float64Array;
  late: Float64Array;
  slack: TrackData;
  ladder: LadderSeries;
  cap: Float64Array;
  ladderLines: TrackData;
  ladderSteps: Float64Array;
}

function merge(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length || j < b.length) out[k++] = j >= b.length || (i < a.length && a[i]! <= b[j]!) ? a[i++]! : b[j++]!;
  return out;
}

function build(cols: CaptureRangeColumns): Read {
  const times = rangeColumn(cols, RANGE_SECONDS) as Float64Array;
  const slack = slackSeries(cols);
  const byLevel: Record<Level, { t: number[]; v: number[] }> = { green: { t: [], v: [] }, amber: { t: [], v: [] }, red: { t: [], v: [] } };
  let top = 1;
  for (let i = 0; i < slack.times.length; i++) {
    const v = slack.minSlackFrames[i]!;
    if (v > top) top = v;
    const b = byLevel[slackLevel(v)];
    b.t.push(slack.times[i]!);
    b.v.push(v);
  }
  const slackLines: LineSeries[] = [];
  for (const l of LEVELS) {
    const b = byLevel[l];
    if (b.t.length) slackLines.push({ times: Float64Array.from(b.t), values: Float64Array.from(b.v), color: LEVEL_COLOR[l], yMax: top });
  }
  const ladder = ladderSeries(cols);
  const voices = voiceSeries(cols);
  let maxLevel = 1;
  for (const v of ladder.level) if (v > maxLevel) maxLevel = v;
  let maxCap = 1;
  for (const v of voices.cap) if (v > maxCap) maxCap = v;
  return {
    times, cols,
    underrun: counterTicks(cols, "underruns"),
    late: counterTicks(cols, "lateCommands"),
    slack: { lines: slackLines },
    ladder,
    cap: voices.cap,
    ladderLines: { lines: [{ times: ladder.times, values: ladder.level, color: "warning", yMax: maxLevel }, { times: voices.times, values: voices.cap, color: "accent", yMax: maxCap }] },
    ladderSteps: merge(ladder.shed, ladder.restored),
  };
}

const seconds = (t: number): string => `${t.toFixed(3)} s`;

/** The tracks of one capture's counters and ladder. */
export const counterTracks: TrackFactory = (ctx: TrackContext) => {
  let read: Read | undefined;
  let inflight: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (!inflight) {
      inflight = statusColumns(ctx.source, COLUMNS)
        .then((cols) => {
          read = cols[RANGE_SECONDS] && (cols[RANGE_SECONDS] as Float64Array).length > 0 ? build(cols) : undefined;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
  const column = (name: string, i: number): number => rangeColumn(read!.cols, name)[i]!;

  /** "n so far, the latest at t" for a cumulative counter whose ticks are `ticks`. */
  const counterTip = (what: string, name: string, ticks: Float64Array, t: number): string | null => {
    if (!read) return null;
    const i = indexAtOrBefore(read.times, t);
    if (i < 0) return null;
    const n = indexAtOrBefore(ticks, t);
    return n < 0 ? `No ${what} so far` : `${column(name, i)} ${what} so far; the latest at ${seconds(ticks[n]!)}`;
  };

  const tickTrack = (track: Track, pick: (r: Read) => Float64Array, color: "danger" | "warning", tip: (t: number) => string | null): TrackModule => ({
    track,
    data: () => (read ? { ticks: pick(read), tickColor: color } : undefined),
    refresh,
    tooltipAt: tip,
  });

  return [
    tickTrack({ id: UNDERRUN_TRACK, label: "Underruns", kind: "ticks", height: 24, visible: true }, (r) => r.underrun, "danger", (t) => (read ? counterTip("underruns", "underruns", read.underrun, t) : null)),
    tickTrack({ id: LATE_TRACK, label: "Late commands", kind: "ticks", height: 24, visible: true }, (r) => r.late, "warning", (t) => (read ? counterTip("late commands", "lateCommands", read.late, t) : null)),
    {
      track: { id: SLACK_TRACK, label: "Min slack (frames)", kind: "line", height: 48, visible: true },
      data: () => read?.slack,
      refresh,
      tooltipAt(t) {
        if (!read) return null;
        const i = indexAtOrBefore(read.times, t);
        if (i < 0) return null;
        const v = column("minSlackFrames", i);
        return `Min slack ${v} frames (${slackLevel(v)})`;
      },
    },
    {
      track: { id: LADDER_TRACK, label: "Ladder and voice cap", kind: "lanes", height: 56, visible: true },
      data: () => read?.ladderLines,
      refresh,
      tooltipAt(t) {
        if (!read) return null;
        const i = indexAtOrBefore(read.times, t);
        if (i < 0) return null;
        const level = read.ladder.level[i]!;
        return `Ladder: ${level} ${level === 1 ? "step" : "steps"} (bed and zone ${read.ladder.m3Shed[i]!}, loudness ${read.ladder.loudShed[i]!}); voice cap ${read.cap[i]!}`;
      },
    },
    tickTrack({ id: LADDER_STEPS_TRACK, label: "Ladder steps", kind: "ticks", height: 24, visible: true }, (r) => r.ladderSteps, "warning", (t) => {
      if (!read) return null;
      const i = indexAtOrBefore(read.times, t);
      if (i < 0) return null;
      const s = indexAtOrBefore(read.ladder.shed, t);
      const r = indexAtOrBefore(read.ladder.restored, t);
      if (s < 0 && r < 0) return "No ladder step so far";
      const shedLast = s >= 0 && (r < 0 || read.ladder.shed[s]! >= read.ladder.restored[r]!);
      return shedLast ? `Last step: shed at ${seconds(read.ladder.shed[s]!)}` : `Last step: restored at ${seconds(read.ladder.restored[r]!)}`;
    }),
  ];
};

// ADR 0171 amended by 0172 (M5a, task Pf1; api-and-models §7, architecture §3.7, §4.3, §9): the profiler's STATUS
// series, pure models over `range` columns (`profilerSource.ts`), no DOM or canvas (Pf3a draws them). Each function
// reads named STATUS columns (`STATUS_COLUMNS` in `runtime/capture/reader.ts`) from a raw (un-bucketed) `range` answer:
//
//   - the CPU line (`CpuTrack`): the figure is computed here, from the cumulative `busyMsTotal`, `quantaTotal` and work
//     units, by Cp2's `CpuMeter`, exactly as the live hub does (the wire's `loadPermille` is 0). Before the first window
//     fills, or with a coarse clock, a sample is "not measured" or "hidden", never 0.
//   - voices (`voiceSeries`): live, mixed, virtual (live - mixed), the mixed cap, and the HRTF, bed and fx subsets.
//   - counters (`counterTicks`, `slackSeries`): underruns and late commands are cumulative, so a tick is a sample at
//     which the counter rose; `minSlackFrames` is a line.
//   - the ladder (`ladderSeries`): steps in force (`m3Shed` bed and zone steps + `loudShed`) with the sample at which
//     it rose (a shed) or fell (restored) as ticks.
//
// Times are seconds on the viewport axis (0 = the capture's first record). `statusColumns` (`profilerSource.ts`) already
// rebases the Worker's axis seconds, so `origin` stays 0; pass the source's `startSeconds` only for a raw `range`. Ticks go through `timelineModel`'s `downsampleTicks`, lines through
// `downsampleMinMax`; neither is imported here (the series are plain typed arrays).
import { CpuMeter, type CpuFeed } from "../../runtime/mix/cpuMeter";
import type { AudioCpuDebug } from "../../runtime/backend";
import { RANGE_SECONDS, type CaptureRangeColumns } from "../../runtime/capture/reader";

/** The STATUS columns each series reads (the `range` request). */
export const CPU_COLUMNS = ["busyMsTotal", "quantaTotal", "wuVoices", "wuBuses", "wuSpatial", "wuMusic", "wuLoudness", "clockStepMs", "clockSteps"] as const;
export const VOICE_COLUMNS = ["liveVoices", "mixedVoices", "mixedCap", "hrtfVoices", "bedVoices", "fxVoices"] as const;
export const COUNTER_COLUMNS = ["underruns", "lateCommands", "minSlackFrames", "underrunFrames", "maxLatenessFrames"] as const;
export const LADDER_COLUMNS = ["m3Shed", "loudShed"] as const;

/** A column of a `range` answer; throws when the request left it out (a programming error, not data). */
export function rangeColumn(cols: CaptureRangeColumns, name: string): ArrayLike<number> {
  const c = cols[name];
  if (!c) throw new Error(`range answer has no "${name}" column`);
  return c;
}

function times(cols: CaptureRangeColumns, origin: number): Float64Array {
  const s = rangeColumn(cols, RANGE_SECONDS) as Float64Array;
  if (origin === 0) return s;
  const t = new Float64Array(s.length);
  for (let i = 0; i < s.length; i++) t[i] = s[i]! - origin;
  return t;
}

// --- CPU --------------------------------------------------------------------------------------------------------------

/** Per-sample CPU state. */
export const CpuState = { notMeasured: 0, measured: 1, hidden: 2 } as const;

class F64Buf {
  data = new Float64Array(256);
  length = 0;
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Float64Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  view(): Float64Array {
    return this.data.subarray(0, this.length);
  }
}

/**
 * The CPU series, incremental: `extend` takes a raw `range` answer (every sample after the last one already taken is
 * fed to a `CpuMeter`; earlier ones are ignored, so a live view may re-read from any earlier time). The arrays are views
 * into growing buffers: valid until the next `extend` for reading, never to be written.
 */
export class CpuTrack {
  private readonly meter: CpuMeter;
  private readonly feed: CpuFeed = { busyMsTotal: 0, quantaTotal: 0, wuVoices: 0, wuBuses: 0, wuSpatial: 0, wuMusic: 0, wuLoudness: 0, clockStepMs: 0, clockSteps: 0 };
  private readonly t = new F64Buf();
  private readonly v = new F64Buf();
  private readonly state: number[] = [];
  private readonly mt = new F64Buf();
  private readonly mv = new F64Buf();
  private last = -Infinity;

  /** `sampleRate` fixes a quantum's duration (the capture header's rate; a capture that changes rate mid-way reads at the header's). */
  constructor(sampleRate: number) {
    this.meter = new CpuMeter(sampleRate);
  }

  /** Samples taken. */
  get length(): number {
    return this.t.length;
  }
  /** Sample times, seconds on the viewport axis. */
  get times(): Float64Array {
    return this.t.view();
  }
  /** The figure in permille of a quantum per sample, **NaN where it is not measured or hidden** (never 0). */
  get permille(): Float64Array {
    return this.v.view();
  }
  /** `CpuState` per sample. */
  get states(): readonly number[] {
    return this.state;
  }
  /** The measured samples only (times, permille): what the line draws, so a gap is a gap and not a zero. */
  get line(): { times: Float64Array; values: Float64Array } {
    return { times: this.mt.view(), values: this.mv.view() };
  }
  /** The newest sample's state (`notMeasured` before any). */
  get latestState(): number {
    return this.state.length ? this.state[this.state.length - 1]! : CpuState.notMeasured;
  }
  /** `Audio.debug().cpu` as of the newest sample: window length, hidden reason, estimated sections. */
  debug(): AudioCpuDebug {
    return this.meter.debug();
  }

  /** Takes the samples of `cols` (a raw answer with `seconds` and `CPU_COLUMNS`) later than any taken. Returns how many were new. */
  extend(cols: CaptureRangeColumns, origin = 0): number {
    const ts = times(cols, origin);
    const busy = rangeColumn(cols, "busyMsTotal");
    const quanta = rangeColumn(cols, "quantaTotal");
    const wu = [rangeColumn(cols, "wuVoices"), rangeColumn(cols, "wuBuses"), rangeColumn(cols, "wuSpatial"), rangeColumn(cols, "wuMusic"), rangeColumn(cols, "wuLoudness")];
    const step = rangeColumn(cols, "clockStepMs");
    const steps = rangeColumn(cols, "clockSteps");
    const f = this.feed;
    let added = 0;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]!;
      if (!(t > this.last)) continue;
      this.last = t;
      f.busyMsTotal = busy[i]!;
      f.quantaTotal = quanta[i]!;
      f.wuVoices = wu[0]![i]!;
      f.wuBuses = wu[1]![i]!;
      f.wuSpatial = wu[2]![i]!;
      f.wuMusic = wu[3]![i]!;
      f.wuLoudness = wu[4]![i]!;
      f.clockStepMs = step[i]!;
      f.clockSteps = steps[i]!;
      this.meter.feed(f);
      const fig = this.meter.loadPermille;
      this.t.push(t);
      if (fig !== null) {
        this.v.push(fig);
        this.state.push(CpuState.measured);
        this.mt.push(t);
        this.mv.push(fig);
      } else {
        this.v.push(NaN);
        this.state.push(this.meter.debug().hidden ? CpuState.hidden : CpuState.notMeasured);
      }
      added++;
    }
    return added;
  }
}

// --- voices -----------------------------------------------------------------------------------------------------------

/** Voices by state, per STATUS sample. `virtual` = live - mixed (clamped at 0): voices tracked but not mixed. */
export interface VoiceSeries {
  times: Float64Array;
  live: Float64Array;
  mixed: Float64Array;
  virtual: Float64Array;
  /** The core's `mixedCap`: the most voices it will mix right now (the adaptive cap). */
  cap: Float64Array;
  hrtf: Float64Array;
  bed: Float64Array;
  fx: Float64Array;
}

function copy(src: ArrayLike<number>): Float64Array {
  return Float64Array.from(src as ArrayLike<number>);
}

export function voiceSeries(cols: CaptureRangeColumns, origin = 0): VoiceSeries {
  const live = copy(rangeColumn(cols, "liveVoices"));
  const mixed = copy(rangeColumn(cols, "mixedVoices"));
  const virt = new Float64Array(live.length);
  for (let i = 0; i < live.length; i++) virt[i] = Math.max(0, live[i]! - mixed[i]!);
  return {
    times: times(cols, origin), live, mixed, virtual: virt, cap: copy(rangeColumn(cols, "mixedCap")),
    hrtf: copy(rangeColumn(cols, "hrtfVoices")), bed: copy(rangeColumn(cols, "bedVoices")), fx: copy(rangeColumn(cols, "fxVoices")),
  };
}

// --- counters ---------------------------------------------------------------------------------------------------------

/**
 * Times of the samples at which a cumulative counter rose: one tick per such sample, however much it rose (`downsampleTicks`
 * keeps each). The first sample is a baseline (a ring-truncated capture starts mid-run, so its count is not an event); a
 * counter that falls is a restart (a rebuild's new core counts from 0), and a non-zero value after it is a tick.
 */
export function counterTicks(cols: CaptureRangeColumns, column: string, origin = 0): Float64Array {
  const ts = times(cols, origin);
  const v = rangeColumn(cols, column);
  const out: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    const a = v[i - 1]!;
    const b = v[i]!;
    if (b > a || (b < a && b > 0)) out.push(ts[i]!);
  }
  return Float64Array.from(out);
}

/** The click headline's lines: `minSlackFrames` (signed, frames) and the cumulative `underrunFrames`. */
export function slackSeries(cols: CaptureRangeColumns, origin = 0): { times: Float64Array; minSlackFrames: Float64Array; underrunFrames: Float64Array } {
  return { times: times(cols, origin), minSlackFrames: copy(rangeColumn(cols, "minSlackFrames")), underrunFrames: copy(rangeColumn(cols, "underrunFrames")) };
}

/** Architecture §9's colours. */
export type Level = "green" | "amber" | "red";
/** `minSlackFrames`: > 64 green, 1 to 64 amber, <= 0 red. */
export function slackLevel(minSlackFrames: number): Level {
  return minSlackFrames > 64 ? "green" : minSlackFrames >= 1 ? "amber" : "red";
}
/** CPU permille: < 500 green, 500 to 800 amber, > 800 red; null (not measured) has no colour. */
export function cpuLevel(permille: number | null): Level | null {
  if (permille === null || Number.isNaN(permille)) return null;
  return permille < 500 ? "green" : permille <= 800 ? "amber" : "red";
}

// --- the ladder -------------------------------------------------------------------------------------------------------

/**
 * The shedding ladder. `level` = `m3Shed` (bed and zone steps in force) + `loudShed` (the loudness step, 0 or 1; R21):
 * steps in force. `shed` holds the times at which it rose, `restored` where it fell; a restart of the counters reads as
 * what the values say.
 */
export interface LadderSeries {
  times: Float64Array;
  m3Shed: Float64Array;
  loudShed: Float64Array;
  level: Float64Array;
  shed: Float64Array;
  restored: Float64Array;
}

export function ladderSeries(cols: CaptureRangeColumns, origin = 0): LadderSeries {
  const ts = times(cols, origin);
  const m3 = copy(rangeColumn(cols, "m3Shed"));
  const loud = copy(rangeColumn(cols, "loudShed"));
  const level = new Float64Array(ts.length);
  const shed: number[] = [];
  const restored: number[] = [];
  for (let i = 0; i < ts.length; i++) {
    level[i] = m3[i]! + loud[i]!;
    if (i > 0) {
      if (level[i]! > level[i - 1]!) shed.push(ts[i]!);
      else if (level[i]! < level[i - 1]!) restored.push(ts[i]!);
    }
  }
  return { times: ts, m3Shed: m3, loudShed: loud, level, shed: Float64Array.from(shed), restored: Float64Array.from(restored) };
}

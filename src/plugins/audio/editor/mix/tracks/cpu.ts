// ADR 0171 amended by 0172 (M5a, task Pf3b; api-and-models §7, architecture §4.3, §9): the profiler's CPU tracks.
//
//   - `cpu.load`: the CPU figure over the capture, the window in the label ("CPU 256 ms avg"; the window comes from the
//     meter, so a coarse clock reads "1024 ms"). The line holds measured samples only (`CpuTrack.line`), so a sample
//     that is not measured or hidden leaves a gap, never a 0. It is split into three series by `cpuLevel` (green,
//     amber, red; the theme's accent, warning and danger) on one scale (at least 1000 permille, a whole quantum).
//   - `cpu.sections`: the five sections' shares as lanes, labelled "estimated share" (the refit is an estimate; S2).
//     A lane is the meter's `debug().sections` value at each sample (null until the refit is fitted: no point).
//
// Both read the CPU columns through `statusColumns` and feed `CpuTrack` one sample at a time, so the per-sample sections
// are the model's own (`CpuTrack.debug()` after each sample), not a second computation. `refresh` re-reads only the
// samples after the newest one taken (the meter keeps its window between calls). Pure TypeScript; the canvas draws.
import { CAPTURE_FLAG_MAIN_SIDE_ONLY } from "../../../runtime/capture/format";
import { RANGE_SECONDS, type CaptureRangeColumns } from "../../../runtime/capture/reader";
import { CPU_WINDOW_QUANTA, CPU_QUANTUM_FRAMES } from "../../../runtime/mix/cpuMeter";
import type { TimelineColorKey, TrackData, LineSeries } from "../drawTimeline";
import { CPU_COLUMNS, CpuState, CpuTrack, cpuLevel, type Level } from "../cpuTrack";
import { EMPTY_STATES } from "../emptyStates";
import { statusColumns } from "../profilerSource";
import type { Track } from "../timelineModel";
import type { TrackContext, TrackFactory, TrackModule } from "./types";

export const CPU_LOAD_TRACK = "cpu.load";
export const CPU_SECTIONS_TRACK = "cpu.sections";

/** The five sections in the order `AudioCpuDebug.sections` names them, and each lane's colour. */
export const CPU_SECTION_KEYS = ["voices", "buses", "spatial", "music", "loudness"] as const;
export type CpuSectionKey = (typeof CPU_SECTION_KEYS)[number];
export const CPU_SECTION_COLORS: Readonly<Record<CpuSectionKey, TimelineColorKey>> = {
  voices: "accent", buses: "accent2", spatial: "warning", music: "text", loudness: "muted",
};

/** The load scale never drops below one whole quantum (1000 permille), so a quiet capture reads as quiet. */
export const CPU_SCALE_PERMILLE = 1000;

const LEVEL_COLOR: Readonly<Record<Level, TimelineColorKey>> = { green: "accent", amber: "warning", red: "danger" };
const LEVELS: readonly Level[] = ["green", "amber", "red"];

/** The index of the last sample at or before `t` in ascending `times`, or -1 when `t` precedes them all. */
export function indexAtOrBefore(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** One sample's columns as a one-row answer (a view, no copy), so the model sees samples one by one. */
function sampleRow(cols: CaptureRangeColumns, i: number): CaptureRangeColumns {
  const row: CaptureRangeColumns = {};
  for (const name of [RANGE_SECONDS, ...CPU_COLUMNS]) row[name] = (cols[name] as Float64Array).subarray(i, i + 1);
  return row;
}

/** `CpuTrack` plus the per-sample hidden reason and sections; shared by the two tracks. */
class CpuData {
  private readonly cpu: CpuTrack;
  private readonly hidden: (string | null)[] = [];
  private readonly sections: (Float64Array | null)[] = [];
  private inflight: Promise<void> | null = null;
  private loadCache: TrackData | undefined | null = null;
  private sectionCache: TrackData | undefined | null = null;
  windowMs: number;

  constructor(private readonly ctx: TrackContext) {
    const rate = ctx.source.summary.header.sampleRate;
    this.cpu = new CpuTrack(rate);
    this.windowMs = (CPU_WINDOW_QUANTA * CPU_QUANTUM_FRAMES * 1000) / rate;
  }

  get times(): Float64Array {
    return this.cpu.times;
  }
  get length(): number {
    return this.cpu.length;
  }

  /** Reads the samples after the newest taken; concurrent callers share one read. */
  refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.read().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async read(): Promise<void> {
    const n = this.cpu.length;
    const from = n ? this.cpu.times[n - 1]! : 0;
    const cols = await statusColumns(this.ctx.source, CPU_COLUMNS, from);
    const secs = cols[RANGE_SECONDS] as Float64Array;
    let added = 0;
    for (let i = 0; i < secs.length; i++) {
      if (this.cpu.extend(sampleRow(cols, i)) === 0) continue;
      added++;
      const d = this.cpu.debug();
      this.hidden.push(d.hidden);
      this.sections.push(d.sections ? Float64Array.of(d.sections.voices, d.sections.buses, d.sections.spatial, d.sections.music, d.sections.loudness) : null);
      if (d.loadPermille !== null) this.windowMs = d.windowMs;
    }
    if (added > 0) {
      this.loadCache = null;
      this.sectionCache = null;
    }
  }

  /** The load line, by level; undefined while no sample is measured. */
  loadData(): TrackData | undefined {
    if (this.loadCache !== null) return this.loadCache;
    const { times, values } = this.cpu.line;
    if (times.length === 0) return (this.loadCache = undefined);
    let peak = CPU_SCALE_PERMILLE;
    const byLevel: Record<Level, { t: number[]; v: number[] }> = { green: { t: [], v: [] }, amber: { t: [], v: [] }, red: { t: [], v: [] } };
    for (let i = 0; i < times.length; i++) {
      const v = values[i]!;
      if (v > peak) peak = v;
      const b = byLevel[cpuLevel(v)!];
      b.t.push(times[i]!);
      b.v.push(v);
    }
    const lines: LineSeries[] = [];
    for (const l of LEVELS) {
      const b = byLevel[l];
      if (b.t.length) lines.push({ times: Float64Array.from(b.t), values: Float64Array.from(b.v), color: LEVEL_COLOR[l], yMax: peak });
    }
    return (this.loadCache = { lines });
  }

  /** The five lanes over the samples whose sections are fitted; undefined while none is. */
  sectionData(): TrackData | undefined {
    if (this.sectionCache !== null) return this.sectionCache;
    const ts: number[] = [];
    const lanes: number[][] = CPU_SECTION_KEYS.map(() => []);
    const all = this.cpu.times;
    for (let i = 0; i < this.sections.length; i++) {
      const s = this.sections[i];
      if (!s) continue;
      ts.push(all[i]!);
      for (let k = 0; k < lanes.length; k++) lanes[k]!.push(s[k]!);
    }
    if (ts.length === 0) return (this.sectionCache = undefined);
    const times = Float64Array.from(ts);
    // One scale for every lane, so the lanes compare: the load's, at least a quantum.
    let peak = CPU_SCALE_PERMILLE;
    for (const l of lanes) for (const v of l) if (v > peak) peak = v;
    const lines = CPU_SECTION_KEYS.map((key, k) => ({ times, values: Float64Array.from(lanes[k]!), color: CPU_SECTION_COLORS[key], yMax: peak }));
    return (this.sectionCache = { lines });
  }

  /** The sample at `t`: null before the first. */
  private at(t: number): number {
    return indexAtOrBefore(this.cpu.times, t);
  }

  /** A Babylon-fallback capture has no STATUS, so no CPU samples: both tracks say why they are empty (FU3; was the controller's fallback). */
  private get mainSideOnly(): boolean {
    return (this.ctx.source.summary.header.flags & CAPTURE_FLAG_MAIN_SIDE_ONLY) !== 0;
  }

  loadTooltip(t: number): string | null {
    if (this.mainSideOnly) return EMPTY_STATES.babylonNoCpu;
    const i = this.at(t);
    if (i < 0) return null;
    const permille = this.cpu.permille[i]!;
    if (Number.isNaN(permille)) return this.hidden[i] ?? EMPTY_STATES.cpuNotMeasured;
    return `CPU ${Math.round(permille)}‰ (${Math.round(this.windowMs)} ms average)`;
  }

  sectionTooltip(t: number): string | null {
    if (this.mainSideOnly) return EMPTY_STATES.babylonNoCpu;
    const i = this.at(t);
    if (i < 0) return null;
    if (this.cpu.states[i] !== CpuState.measured) return this.hidden[i] ?? EMPTY_STATES.cpuNotMeasured;
    const s = this.sections[i];
    if (!s) return "Estimated share: not fitted yet";
    return `Estimated share: ${CPU_SECTION_KEYS.map((k, j) => `${k} ${Math.round(s[j]!)}‰`).join(", ")}`;
  }
}

/** The CPU tracks of one capture: `cpu.load` and `cpu.sections`. */
export const cpuTracks: TrackFactory = (ctx) => {
  const d = new CpuData(ctx);
  const sharedRefresh = () => d.refresh();
  const load: TrackModule = {
    get track(): Track {
      return { id: CPU_LOAD_TRACK, label: `CPU (${Math.round(d.windowMs)} ms)`, kind: "line", height: 56, visible: true };
    },
    data: () => d.loadData(),
    refresh: sharedRefresh,
    tooltipAt: (t) => d.loadTooltip(t),
  };
  const sections: TrackModule = {
    get track(): Track {
      return { id: CPU_SECTIONS_TRACK, label: "CPU estimated share", kind: "lanes", height: 90, visible: true };
    },
    data: () => d.sectionData(),
    refresh: sharedRefresh,
    tooltipAt: (t) => d.sectionTooltip(t),
  };
  return [load, sections];
};

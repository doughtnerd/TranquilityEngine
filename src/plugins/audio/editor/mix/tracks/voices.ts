// ADR 0171 amended by 0172 (M5a, task Pf3c; api-and-models §7 "voices by state"): the profiler's voices track. Five lanes
// from STATUS (`voiceSeries`, `cpuTrack.ts`): voices playing (mixed), virtual (live - mixed), the adaptive cap, and the
// HRTF and bed subsets. The counts are the STATUS scalars, so at a keyframe's instant they equal the counts of the voice
// table `voiceTableModel.reconstructVoices` builds from that keyframe (the test holds that). Pure TypeScript, no DOM.
import { VOICE_COLUMNS, voiceSeries, type VoiceSeries } from "../cpuTrack";
import { statusColumns } from "../profilerSource";
import type { LineSeries, TrackData } from "../drawTimeline";
import type { TrackFactory, TrackModule } from "./types";

export const VOICES_TRACK_ID = "voices.counts";

/** The lanes, in draw order: the series each reads, its tooltip label and its theme colour. */
const LANES = [
  { key: "mixed", label: "playing", color: "accent" },
  { key: "virtual", label: "virtual", color: "muted" },
  { key: "cap", label: "cap", color: "warning" },
  { key: "hrtf", label: "HRTF", color: "accent2" },
  { key: "bed", label: "bed", color: "accentSoft" },
] as const satisfies readonly { key: keyof VoiceSeries; label: string; color: LineSeries["color"] }[];

/** The index of the last sample at or before `t` (binary search over ascending `times`), or -1 when `t` precedes them all. */
export function indexAtOrBefore(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The lanes as `TrackData`; `undefined` for a capture with no STATUS. */
export function voiceTrackData(series: VoiceSeries): TrackData | undefined {
  if (series.times.length === 0) return undefined;
  return { lines: LANES.map((l) => ({ times: series.times, values: series[l.key], color: l.color })) };
}

/** One sample's counts by state (what the lanes show). */
export interface VoiceCounts {
  playing: number;
  virtual: number;
  cap: number;
  hrtf: number;
  bed: number;
  /** Voices tracked: playing + virtual. */
  live: number;
}

/** The counts of the STATUS in force at `t` (the last one at or before it), or `null` before the first. */
export function voiceCountsAt(series: VoiceSeries, t: number): VoiceCounts | null {
  const i = indexAtOrBefore(series.times, t);
  if (i < 0) return null;
  return { playing: series.mixed[i]!, virtual: series.virtual[i]!, cap: series.cap[i]!, hrtf: series.hrtf[i]!, bed: series.bed[i]!, live: series.live[i]! };
}

/** The hover text: "playing 3, virtual 1, cap 64, HRTF 0, bed 0 (4 live)". */
export function voiceTooltip(series: VoiceSeries, t: number): string | null {
  const c = voiceCountsAt(series, t);
  if (!c) return null;
  return `playing ${c.playing}, virtual ${c.virtual}, cap ${c.cap}, HRTF ${c.hrtf}, bed ${c.bed} (${c.live} live)`;
}

/** The voices track, read from the whole capture's STATUS. */
export const voicesTracks: TrackFactory = (ctx): readonly TrackModule[] => {
  let series: VoiceSeries | undefined;
  let cached: TrackData | undefined;
  return [{
    track: { id: VOICES_TRACK_ID, label: "Voices", kind: "lanes", height: 90, visible: true },
    data: () => cached,
    async refresh() {
      series = voiceSeries(await statusColumns(ctx.source, VOICE_COLUMNS));
      cached = voiceTrackData(series);
    },
    tooltipAt: (t) => (series ? voiceTooltip(series, t) : null),
  }];
};

// ADR 0171 amended by 0172 (M5a, task Pf3c; api-and-models §7 "voices by state"): the profiler's voices track. Five lanes
// from STATUS (`voiceSeries`, `cpuTrack.ts`): voices playing (mixed), virtual (live - mixed), the adaptive cap, and the
// HRTF and bed subsets. The counts are the STATUS scalars, so at a keyframe's instant they equal the counts of the voice
// table `voiceTableModel.reconstructVoices` builds from that keyframe (the test holds that). Pure TypeScript, no DOM.
import { lastAtOrBefore } from "../../../../../engine/core/sortedSearch";
import { VOICE_COLUMNS, voiceSeries, type VoiceSeries } from "../cpuTrack";
import type { LineSeries, TrackData } from "../drawTimeline";
import { TrackKit } from "./kit";
import type { TrackFactory, TrackModule } from "./types";

const VOICES_TRACK_ID = "voices.counts";

/** The lanes, in draw order: the series each reads, its tooltip label and its theme colour. */
const LANES = [
  { key: "mixed", label: "playing", color: "accent" },
  { key: "virtual", label: "virtual", color: "muted" },
  { key: "cap", label: "cap", color: "warning" },
  { key: "hrtf", label: "HRTF", color: "accent2" },
  { key: "bed", label: "bed", color: "accentSoft" },
] as const satisfies readonly { key: keyof VoiceSeries; label: string; color: LineSeries["color"] }[];

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
function voiceCountsAt(series: VoiceSeries, t: number): VoiceCounts | null {
  const i = lastAtOrBefore(series.times, t);
  if (i < 0) return null;
  return { playing: series.mixed[i]!, virtual: series.virtual[i]!, cap: series.cap[i]!, hrtf: series.hrtf[i]!, bed: series.bed[i]!, live: series.live[i]! };
}

/** The hover text: "playing 3, virtual 1, cap 64, HRTF 0, bed 0 (4 live)". */
function voiceTooltip(series: VoiceSeries, t: number): string | null {
  const c = voiceCountsAt(series, t);
  if (!c) return null;
  return `playing ${c.playing}, virtual ${c.virtual}, cap ${c.cap}, HRTF ${c.hrtf}, bed ${c.bed} (${c.live} live)`;
}

/** The voices track, over the STATUS columns the track kit reads (ADR 0261). */
export const voicesTracks: TrackFactory = (ctx): readonly TrackModule[] => {
  const kit = TrackKit.of(ctx.source);
  const feed = kit.status(VOICE_COLUMNS);
  return [kit.track({
    track: { id: VOICES_TRACK_ID, label: "Voices", kind: "lanes", height: 90, visible: true },
    build: () => {
      const series = voiceSeries(feed.columns());
      return { data: voiceTrackData(series), tooltip: (t) => voiceTooltip(series, t) };
    },
  })];
};

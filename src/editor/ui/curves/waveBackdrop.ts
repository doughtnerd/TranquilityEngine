/**
 * The waveform behind time curves (owner spec §5.1, the prototype's `wave`/`wave-fn` on Samples): a clip's peak levels
 * read as an amplitude per moment of the curve's time axis, faint as the source, brighter as the level the curves give
 * it. A host hands its sample's peaks (`PeakSource`, the shape of the Studio's peak mips) and where the clip starts in
 * them (its trim); the dialog draws the rest.
 *
 * Pure: no DOM.
 */
import { dbToGain } from "../../../engine/audio/decibels";
import type { CurveLane } from "./curveEditorModel";
import type { WaveformFn } from "./CurvePlot";

/** One level of peaks: `[min, max]` int16 pairs per `binFrames` frames, channel after channel. */
export interface PeakLevel {
  readonly binFrames: number;
  readonly bins: number;
  readonly channels: number;
  readonly data: Int16Array;
}

/** A sample's peaks: its rate, length and levels, finest first. */
export interface PeakSource {
  readonly rate: number;
  readonly frames: number;
  readonly levels: readonly PeakLevel[];
}

/** The amplitude (0..1, the louder channel) of the finest level's bins over seconds `t0`..`t1` of the source. */
export function peakAmplitude(src: PeakSource, t0: number, t1: number): number {
  const lv = src.levels[0];
  if (!lv || src.rate <= 0) return 0;
  const first = Math.max(0, Math.floor((t0 * src.rate) / lv.binFrames));
  const end = Math.min(lv.bins, Math.max(first + 1, Math.ceil((t1 * src.rate) / lv.binFrames)));
  let peak = 0;
  for (let c = 0; c < lv.channels; c++) {
    const base = c * lv.bins * 2;
    for (let i = first; i < end; i++) peak = Math.max(peak, Math.abs(lv.data[base + i * 2]!), Math.abs(lv.data[base + i * 2 + 1]!));
  }
  return peak / 32767;
}

/** The lanes that set a level, in dB (Gain, Volume, Level, Output, Makeup): what the brighter "after" shape follows. */
export const levelLanes = (lanes: readonly CurveLane[]): string[] => lanes.filter((l) => l.unit === "dB" && /gain|volume|level|output|makeup/i.test(l.name)).map((l) => l.id);

export interface WaveformOptions {
  /** Where the curve's time 0 sits in the source, seconds (the clip's trim start). */
  readonly start?: number;
  /** The lanes whose dB values scale the brighter shape (`levelLanes`); none: one shape only. */
  readonly levelLanes?: readonly string[];
  /** The span one amplitude reads, seconds (default 1/220 of the source, about one column of the plot). */
  readonly window?: number;
}

/** The dialog's `waveform` from a sample's peaks: before (the source) and after (the level lanes applied). */
export function waveformFromPeaks(src: PeakSource, opts: WaveformOptions = {}): WaveformFn {
  const start = opts.start ?? 0;
  const length = src.rate > 0 ? src.frames / src.rate : 0;
  const half = (opts.window ?? Math.max(1e-3, length / 220)) / 2;
  const lanes = opts.levelLanes ?? [];
  return (t, values) => {
    const s = start + t;
    if (s < 0 || s > length) return 0;
    const before = peakAmplitude(src, s - half, s + half);
    if (lanes.length === 0) return before;
    const db = lanes.reduce((sum, id) => sum + (values[id] ?? 0), 0);
    return [before, before * dbToGain(db)];
  };
}

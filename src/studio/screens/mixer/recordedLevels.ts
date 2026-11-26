// The bus levels a take recorded at one moment (owner's defect list: scrubbing the playhead updates the Mixer): while the
// open take's replay is paused, the Mixer's meters show each bus as the game had it at the playhead, read from the take's
// profile (the Profiler's seek at its cursor, which follows the replay): the STATUS peak in force, and the keyframe's
// runtime and duck lanes. Pure.
import { busFactors } from "../../../plugins/audio/editor/mix/busFactorsModel";
import type { CaptureKeyframe } from "../../../plugins/audio/runtime/capture/reader";
import type { BusReading } from "./boardModel";

/** What the reading needs of a capture seek (`CaptureSeekState`). */
export interface RecordedMoment {
  /** The seek's axis time, seconds (the names' axis). */
  readonly seconds: number;
  /** The STATUS in force: one peak per bus slot, linear; null before the first. */
  readonly status: { readonly peaks: readonly { readonly l: number; readonly r: number }[] } | null;
  readonly keyframe: Pick<CaptureKeyframe, "buses"> | null;
}

/** Bus `name` as the take recorded it at `moment`, or null when the capture has no STATUS yet or never named the bus. */
export function recordedBusReading(moment: RecordedMoment, busName: (slot: number, at: number) => string, name: string): BusReading | null {
  const peaks = moment.status?.peaks;
  if (!peaks) return null;
  const slot = peaks.findIndex((_, s) => busName(s, moment.seconds) === name);
  if (slot < 0) return null;
  const peak = peaks[slot]!;
  const row = moment.keyframe?.buses.find((b) => b.slot === slot);
  const factors = row ? busFactors(row).factors : [];
  const lane = (l: string): number => factors.find((f) => f.lane === l)?.value ?? 1;
  return { volume: lane("runtime"), duckGain: lane("duck"), peak: Math.max(peak.l, peak.r), activeVoices: 0 };
}

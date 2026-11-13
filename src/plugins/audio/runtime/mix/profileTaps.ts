// ADR 0171 amended by 0172 (M5, Rc3; api-and-models §5.6, architecture §3.7): where the event taps that aren't a
// backend's own instance state find the recorder's `ProfileSink`, and how the engine's mixer reports its setters.
//
// The voice table and selection hold the sink in `VoiceTable.profile` (one table per backend). The event runtime and
// the music player are one per page, so they read `taps.sink`. The mixer is the engine's (it imports no plugin): it
// has its own `MixerTap` shape, which `mixerTapFor` adapts to the sink. `wireProfileTaps` sets all three at once; the
// core backend calls it from `setProfileSink` (so one sink reaches every tap, and null restores every null object).
//
// A tap's cost without a recorder: one comparison of `taps.sink` (or `table.profile`) with `NULL_PROFILE_SINK`, and for
// the mixer one null check. Nothing allocates in either case.
import { BUS_MIN_RAMP_MS, type LaneId, type Mixer, type MixerTap } from "../../../../engine/audio/mixer";
import { NULL_PROFILE_SINK, type ProfileSink } from "./profileSink";
import type { ProfileNames, VoiceTable } from "../core/voiceTable";

/** The sink the page-wide taps (events, music) call: the null object until a recorder runs. Read it, compare it, never cache it across frames. */
export const taps: { sink: ProfileSink } = { sink: NULL_PROFILE_SINK };

/** §5.6 busRamp lane names, by the wire's lane id (`Lane` in `mixer.ts`). */
const LANE_NAMES: readonly string[] = ["authored", "runtime", "snapshot", "monitor", "dip", "duck", "automation"];

/**
 * Adapts the sink to the mixer's tap: a ramp's frames are its seconds at `sampleRate()` (an asap write, 0 seconds, is
 * `BUS_MIN_RAMP_MS` long on the wire), a monitor change is both masks in one word (mutes in the low 16 bits, solos in
 * the high 16), a cleared snapshot is the empty name.
 */
export function mixerTapFor(sink: ProfileSink, sampleRate: () => number, busRef: (bus: string) => number): MixerTap {
  return {
    busRamp(bus: string, lane: LaneId, seconds: number, target: number): void {
      const rate = sampleRate();
      const frames = Math.round(Math.max(seconds, BUS_MIN_RAMP_MS / 1000) * (rate > 0 ? rate : 48_000));
      sink.busRamp(busRef(bus), LANE_NAMES[lane] ?? String(lane), frames, target);
    },
    snapshot(name: string | null, seconds: number): void {
      sink.snapshot(name ?? "", seconds);
    },
    monitor(muted: number, soloed: number): void {
      sink.monitor(((soloed & 0xffff) << 16 | (muted & 0xffff)) >>> 0);
    },
  };
}

/** What `wireProfileTaps` reaches: the backend's table, the page's mixer, and the names, bus refs and rate only the backend knows. */
export interface ProfileWiring {
  readonly table: VoiceTable;
  readonly mixer: Mixer;
  readonly names: ProfileNames;
  readonly sampleRate: () => number;
  /** A bus name's `busRef` (`gen << 8 | slot`; the slot table's `busRef(slot)` of the name's slot). */
  readonly busRef: (bus: string) => number;
}

/** Points every tap at `sink` (null: the null object everywhere, the mixer's tap removed). */
export function wireProfileTaps(sink: ProfileSink | null, w: ProfileWiring): void {
  const s = sink ?? NULL_PROFILE_SINK;
  w.table.setProfile(sink, sink ? w.names : null);
  w.mixer._setTap(sink ? mixerTapFor(s, w.sampleRate, w.busRef) : null);
  taps.sink = s;
}

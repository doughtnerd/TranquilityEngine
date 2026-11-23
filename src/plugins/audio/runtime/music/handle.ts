/**
 * The `Audio` clock members of ADR 0166 (api-and-models §1.3): `Audio.horizon` and `Audio.timeAt`. A playlist's
 * `handle.music` (`playlists/handle.ts`) reads its positions through `audioTimeAt` too.
 */
import { audioBackend } from "../backend";

/**
 * P7: `Audio.horizon`: the earliest heard time a stamped start is exact for a decoded clip (now + lookahead). A backend
 * without `horizon` (the Babylon fallback): `Audio.time`.
 */
export function audioHorizon(): number {
  const b = audioBackend();
  return b.clock?.horizon() ?? b.time;
}

/**
 * P7: `Audio.timeAt(performanceTime)`: the raw heard time of a `performance.now()` instant (ms); calibration is never
 * applied (R18). `Audio.time` before the clock has an estimate, and on a backend without a heard clock.
 */
export function audioTimeAt(performanceTime: number): number {
  const b = audioBackend();
  return b.clock?.timeAt(performanceTime) ?? b.time;
}

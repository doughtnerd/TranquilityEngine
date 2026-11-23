// Musical timing (ADR 0372; T72): `at: "beat" | "bar" | "exit"` and `align: "hit"` on plays, travels and requests, read
// through the audio plugin's public API only. Playback (`playback.ts`) and the graph API (`graph.ts`) ask here when an
// option carries `at`; `features/music/register.ts` turns the integration on when the audio plugin is active.
import { notBuilt } from "../notBuilt";
import type { AnimatorMusicTiming } from "../types";

/**
 * @internal Seconds until `timing`'s boundary (0 when it has no `at`). Without the audio plugin, `at` is refused with one
 * warning and the action happens at once (T72).
 */
export function secondsToMusicBoundary(_timing: AnimatorMusicTiming): number {
  return notBuilt("musical timing (`at`)", "T72");
}

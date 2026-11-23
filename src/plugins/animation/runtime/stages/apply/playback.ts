// `animation.Apply` sub-step: playback (T17). Ended plays resolve their promises (`finished`, `interrupted`, `stopped`)
// from the core's state-change records, and the clocks `Animator.state()` reports advance (ADR 0372;
// `features/playback/plays.ts`).
import { animatorsOf } from "../../features/instances";
import { advancePlays, resolveStateChanges } from "../../features/playback/plays";
import type { AnimationFrame } from "../frame";
import { inPass } from "../gather/playback";

/** @internal */
export function applyPlayback(frame: AnimationFrame): void {
  resolveStateChanges(frame);
  for (const rt of animatorsOf(frame.world)) {
    if (!inPass(frame, rt)) continue;
    advancePlays(rt, rt.animator.updateMode === "unscaled" ? frame.unscaledDt : frame.dt);
  }
}

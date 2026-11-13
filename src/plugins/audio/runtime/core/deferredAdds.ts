// ADR 0171 amended by 0172 (M5, contract K0; plan seam): live bus additions that found no free core slot (R10,
// architecture §4.7). Ma3 (W8) fills it: the edit stays in `project.json`, is queued here with `ApplyResult.deferred`
// and its message, and is retried at each tombstone recycle (normally within ≈ 40 ms); a fifth effect on a bus applies
// at the next Play.
import type { ApplyResult, MixOp } from "../../../../engine/audio/mixOps";

export class DeferredAdds {
  /** Live adds deferred so far (`Audio.debug().mix.liveDeferred`). */
  count = 0;

  /** Ma3: queue an add that found no free slot; answers `deferred` with the message. */
  defer(_op: MixOp, _message: string): ApplyResult {
    throw new Error("Ma3");
  }

  /** Ma3: retry the queue after a recycle freed `slots`. */
  retry(_slots: readonly number[]): void {}

  /** Ma3: forget the queue (Stop, the next configure). */
  clear(): void {}

  /** Ops waiting for a slot. */
  get pending(): number {
    return 0;
  }
}

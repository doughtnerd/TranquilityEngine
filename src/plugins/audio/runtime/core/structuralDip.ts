// ADR 0171 amended by 0172 (M5, contract K0; plan seam): structural live edits as one stamped dip sequence
// (api-and-models §6.5, architecture §3.3, R8). Ma2 (W6) fills it: dip-down `BUS_RAMP`s, the `BUS_SLOT` change and
// dip-up `BUS_RAMP`s in one batch from one F0 = now + lookahead, `DIP_FRAMES` each, one `sequenceId`, never split across
// batches; coalescing and queueing (one sequence in flight); the per-voice dip; the rebuild replay as the end state;
// tombstone recycling after `TOMBSTONE_TAIL_FRAMES`.
import type { ApplyResult, MixOp } from "../../../../engine/audio/mixOps";

export class StructuralDip {
  /** Ma2: a sequence is in flight (later structural ops queue). */
  get inFlight(): boolean {
    return false;
  }

  /** Ma2: start (or queue) the dip sequence for a structural op. */
  apply(_op: MixOp): ApplyResult {
    throw new Error("Ma2");
  }

  /** Ma2: per frame: retire a finished sequence, start the next queued one, recycle tombstones past their tail. */
  update(_framesNow: number): void {}

  /** Ma2: a rebuild replays an in-flight dip as its end state (R12). */
  replayEndState(): void {}
}

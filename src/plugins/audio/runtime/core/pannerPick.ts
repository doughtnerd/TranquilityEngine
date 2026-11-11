// The panner kind per voice (ADR 0162; api-and-models §3.2 `panner`, `pannerSince`; architecture §3.1; S14, R13). Runs
// after selection: kind 1 (HRTF) for the top `voices.hrtf` mixed spatial voices by audibility (1.2x hysteresis), kind 2
// (bed) for the other mixed spatial voices whose bus has a bed, kind 0 (equal-power) otherwise; a voice keeps a kind for
// at least 500 ms of game time on top of the hysteresis and selection's 3-frame dwell, except a promotion from bed to
// HRTF (a near source should sharpen). Changes go out as SET_PARAMS `flags` (C1); the core crossfades 45 ms.
//
// A5 fills this file and replaces `hrtfPick.ts` with it (keeping `hrtfPick`'s tests and adding the bed cases). K4 (the
// skeleton): the final signatures, delegating to `HrtfPick`, so kinds are 0 and 1 only, exactly as M2.
import { HrtfPick } from "./hrtfPick";
import type { VoiceTable } from "./voiceTable";

/** @internal The panner kinds (C1, PLAY/SET_PARAMS `flags` bits 5–6). */
export const PannerKind = {
  EQUAL_POWER: 0,
  HRTF: 1,
  /** Mixed into the voice's bus's bed (the core pans equal-power when the bus has none). */
  BED: 2,
} as const;
export type PannerKindCode = (typeof PannerKind)[keyof typeof PannerKind];

/** @internal Where `PannerPick` sends its changes (the backend: SET_PARAMS `flags`). */
export interface PannerSink {
  setPanner(i: number, kind: PannerKindCode): void;
}

/** @internal What a frame's pick needs beyond the table. */
export interface PannerLimits {
  /** `voices.hrtf` (0..32): 0 when HRTF is off (`audio.spatial: "equalPower"`, or the table failed to load). */
  readonly hrtf: number;
  /** Per bus index, its bed slot (`BED_SLOT_NONE` 0xFF: none), from the bed planner (`beds.ts`). */
  readonly bedSlot: ArrayLike<number>;
  /** Game time now, milliseconds (the 500 ms kind dwell, R13). */
  readonly nowMs: number;
}

/** @internal The per-frame panner pick over one voice table. */
export class PannerPick {
  private readonly hrtfPick: HrtfPick;
  private readonly hrtfSink: { setPanner(i: number, hrtf: boolean): void };
  private sink: PannerSink | null = null;

  constructor(readonly table: VoiceTable) {
    this.hrtfPick = new HrtfPick(table);
    this.hrtfSink = { setPanner: (i, hrtf) => this.sink?.setPanner(i, hrtf ? PannerKind.HRTF : PannerKind.EQUAL_POWER) };
  }

  /** 1 while slot `i` is flagged HRTF (what the core was last told). */
  get flag(): Uint8Array {
    return this.hrtfPick.flag;
  }

  /** Voices flagged HRTF after the last `run`. */
  get count(): number {
    return this.hrtfPick.count;
  }

  /** Voices on the bed after the last `run`. K4: 0. */
  get bedCount(): number {
    return 0;
  }

  /** The panner kind the core holds for slot `i`, for a replayed PLAY. */
  panner(i: number): PannerKindCode {
    return this.hrtfPick.panner(i) === 1 ? PannerKind.HRTF : PannerKind.EQUAL_POWER;
  }

  /** The frame step: each spatial voice's kind, changes to `sink`. Returns the voices flagged HRTF. */
  run(limits: PannerLimits, sink: PannerSink): number {
    this.sink = sink;
    const n = this.hrtfPick.run(limits.hrtf, this.hrtfSink);
    this.sink = null;
    return n;
  }

  /** Every voice back to equal-power (HRTF turned off), changes to `sink`. */
  clear(sink: PannerSink): void {
    this.sink = sink;
    this.hrtfPick.clear(this.hrtfSink);
    this.sink = null;
  }

  /** Slot `i` was freed. */
  forget(i: number): void {
    this.hrtfPick.forget(i);
  }
}

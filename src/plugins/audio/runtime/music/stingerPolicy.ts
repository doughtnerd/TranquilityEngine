/**
 * The stinger decision table, pure (ADR 0166 api-and-models §2.5: `ifTooLate`, `dontRepeat`, at most 4 at once).
 *
 * Owner: **R5**'s leaf **L-R5a** (W6). Q2 wrote the skeleton. No engine state: numbers in, a decision out.
 */

/** `ifTooLate` (§2.5): default `nextGrid` (with a warning when it fires). */
export type IfTooLate = "nextGrid" | "playNow" | "skip";

/** What a trigger is decided on. Seconds on the heard clock. */
export interface StingerPolicyInput {
  /** Now (`Audio.time`). */
  readonly now: number;
  /** The earliest stampable start (now + the lead for its segment). */
  readonly earliest: number;
  /** The stinger's quantised point (its `at` resolved after now). */
  readonly point: number;
  /** The quantised point after that one (for `nextGrid`); NaN when there is none. */
  readonly nextPoint: number;
  readonly ifTooLate: IfTooLate;
  /** `dontRepeat` seconds (0: off). */
  readonly dontRepeat: number;
  /** When this trigger last played; NaN: never. */
  readonly lastPlayed: number;
  /** Stingers sounding or stamped now for the instance. */
  readonly sounding: number;
}

/** The decision: play at `at` (stealing the oldest when `steal`), or drop for a reason. */
export type StingerDecision =
  | { readonly play: true; readonly at: number; readonly late: boolean; readonly steal: boolean }
  | { readonly play: false; readonly reason: "dontRepeat" | "skip" | "noPoint" };

/** L-R5a: decide one trigger. */
export function decideStinger(input: StingerPolicyInput): StingerDecision {
  void input;
  return { play: false, reason: "noPoint" }; // STUB(L-R5a)
}

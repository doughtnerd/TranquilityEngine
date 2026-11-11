/**
 * The transition rule engine (ADR 0166 api-and-models §2.4, §3.2 `RuleIndex`; architecture §3.2).
 *
 * Owner: **R1** (W5), with its leaf L-R1a (`transitionRules.test.ts`). Q2 wrote the skeleton. The rule types themselves
 * are the format's (F2, `engine/audio/musicRules.ts`); this file resolves them at runtime.
 *
 * Precedence: tier 1 pair, tier 2 `from` named, tier 3 `to` named, tier 4 `*`->`*` (the always-present default rule is
 * tier 4); the first listed wins inside a tier. A change between segments under different children is matched in the
 * nearest common parent's table. `exit` is clamped to the exit cue; a natural advance always leaves at the exit cue
 * (the rule supplies `enter`, fades and bridge). Fades in beats are converted under the tempo map at their point.
 *
 * **R1's contract amendment (skeleton, before any caller):** Q2's `exitTime`, `enterFrame` and `resolveFades` had no
 * way to reach a segment's tempo map or the heard clock (`MusicNodeRef` is `{ id, type }`), so each now takes the
 * compiled grids (`SegmentGrid`, G1) and, for the playing side, its anchor as a `PlayingGrid`. `RuleMatch` gains
 * `transition` (the rule itself, for its fades and bridge). Names and the `findRule`/`ruleIndexOf` signatures are Q2's.
 *
 * Clocks: *heard* seconds are `Audio.time`'s clock; *file* seconds and ticks are G1's (`musicGrid.ts`). A `PlayingGrid`
 * maps between them inside one pass: heard(t) = `anchorTime` + file(t) - file(`anchorTicks`).
 */
import type { MusicNodeRef } from "./musicSystem";
import { DEFAULT_TRANSITION_RULE, type TransitionRule } from "../../../../engine/audio/musicRules";
import type { SegmentGrid } from "../../../../engine/audio/musicGrid";

/** A resolved fade (seconds, on the heard clock), from a rule's `fadeOut`/`fadeIn` in beats or seconds. */
export interface ResolvedFade {
  /** Seconds the fade lasts. */
  readonly seconds: number;
  /** Seconds from the exit point to the fade's start (negative: before it). */
  readonly offset: number;
  readonly curve: "linear" | "sCurve" | "equalPower";
}

/** The rule a change matched (debug `pending` reads it, §1.6). */
export interface RuleMatch {
  /** Index of the rule in its container's list; -1 for the default rule. */
  readonly rule: number;
  /** `"from>to"` as the rule names them (`*` a wildcard). */
  readonly ruleKey: string;
  readonly tier: 1 | 2 | 3 | 4;
  /** Id of the container whose table supplied it (the nearest common parent); `""` when there is none (a segment root). */
  readonly parent: string;
  /** The rule's `exit` and `enter` as written (`"bar"`, `"nextCue"`, `"cue:outro"`, `"2 bars"`, ...). */
  readonly exit: string;
  readonly enter: string;
  /** Library id of the bridge segment, or null. */
  readonly bridge: string | null;
  /** R1: the rule itself (`DEFAULT_TRANSITION_RULE` for the default), for its fades, exit kind and bridge fades. */
  readonly transition: Readonly<TransitionRule>;
}

/** A container's lazily built pair-to-rule table (§3.2 `RuleIndex`), cached per asset. R1 may add fields here. */
export interface RuleIndex {
  readonly container: string;
  /** `"from>to"` → the winning rule, filled on first lookup. */
  readonly pairs: Map<string, RuleMatch>;
}

/**
 * R1: the playing segment's grid and where it is on the heard clock (P3's `GridAnchor` `ticks`/`time` for the current
 * pass). A point after the playing loop region's end, while the region still loops, is not heard in this pass; R3a/R4b
 * re-ask after the wrap with the new anchor.
 */
export interface PlayingGrid {
  readonly grid: SegmentGrid;
  /** Integer ticks from the segment's `1:1:0` of the anchor. */
  readonly anchorTicks: number;
  /** Heard seconds the anchor's position is at. */
  readonly anchorTime: number;
}

/** R1: a segment's grid and the position (ticks from its `1:1:0`, may be fractional or negative) it is at the exit point T. */
export interface GridAt {
  readonly grid: SegmentGrid;
  readonly ticks: number;
}

/** R1: where the incoming segment starts (`enterPoint`). */
export interface EnterPoint {
  /** File seconds the incoming group starts at (0 for `entryCue`: the whole pre-entry plays). */
  readonly seconds: number;
  /** Seconds of incoming audio before T: the group is stamped at T - `preEntry` (0 for `sameTime` and `{cue}`). */
  readonly preEntry: number;
  /** The incoming position heard at T (ticks from its `1:1:0`): the base of `fadeIn` under its tempo map. */
  readonly ticksAtExit: number;
}

/** R1: which leg of a change the fades are for (§2.4 `bridge`, architecture §3.3). */
export type FadeLeg = "direct" | "toBridge" | "fromBridge";

/** R1: the index of a container's `transitions` (cached per asset and container id). */
export function ruleIndexOf(container: MusicNodeRef): RuleIndex {
  return { container: container.id, pairs: new Map() }; // STUB(R1): cache per asset
}

/**
 * R1: the rule for a change from segment `from` to node `to` under the music root `root` (nearest common parent, tiers,
 * list order; the default rule when nothing matches).
 */
export function findRule(root: MusicNodeRef, from: string, to: string): RuleMatch {
  void root;
  return { rule: -1, ruleKey: `${from}>${to}`, tier: 4, parent: "", exit: "bar", enter: "entryCue", bridge: null, transition: DEFAULT_TRANSITION_RULE }; // STUB(R1)
}

/** R1: heard seconds of `ticks` on the playing segment (this pass). */
export function heardTimeAt(playing: PlayingGrid, ticks: number): number {
  void playing;
  void ticks;
  return Number.NaN; // STUB(R1)
}

/** R1: the playing segment's position (fractional ticks) heard at `time`. */
export function ticksAtHeard(playing: PlayingGrid, time: number): number {
  void playing;
  void time;
  return Number.NaN; // STUB(R1)
}

/**
 * R1: the heard time (seconds) of the exit point of `match` at or after `notBefore` in the playing segment, clamped to
 * the exit cue. `natural` (a playlist advance) always gives the exit cue, even before `notBefore`. NaN when the exit
 * cue is unknown for an exit that needs it, or when no point at or before the exit cue is at or after `notBefore`.
 */
export function exitTime(match: RuleMatch, playing: PlayingGrid, notBefore: number, natural: boolean): number {
  void match;
  void playing;
  void notBefore;
  void natural;
  return Number.NaN; // STUB(R1)
}

/**
 * R1: where the incoming segment `to` starts. `entryCue`: the file start (the pre-entry is everything before the entry
 * cue, which lands on T). `sameTime`: the outgoing's musical time since its entry cue at T (`from`), counted from the
 * incoming's entry cue, wrapping by the incoming's entry-to-exit length when it runs past the exit cue. `{cue}`: that
 * cue; a cue the segment lacks reads as `entryCue`. No pre-entry for either.
 */
export function enterPoint(match: RuleMatch, to: SegmentGrid, from: GridAt): EnterPoint {
  void match;
  void to;
  void from;
  return { seconds: 0, preEntry: 0, ticksAtExit: 0 }; // STUB(R1)
}

/** R1: the file frame the incoming segment enters at (`enterPoint(...).seconds` at `rate`, G1's rounding). */
export function enterFrame(match: RuleMatch, to: SegmentGrid, from: GridAt, rate: number): number {
  void match;
  void to;
  void from;
  void rate;
  return 0; // STUB(R1)
}

/**
 * R1: the rule's fades in seconds relative to T. `out` is the outgoing side at T, `into` the incoming side at T
 * (`enterPoint(...).ticksAtExit`); a fade in beats, and its offset, convert through that side's own tempo map from T
 * plus the offset, so a fade across a tempo change takes the seconds of both spans. `leg`: `direct` and `toBridge` use
 * the rule's `fadeOut`/`fadeIn`; `fromBridge` uses `bridge.fadeOut`/`fadeIn`, each defaulting to the rule's.
 */
export function resolveFades(match: RuleMatch, out: GridAt, into: GridAt, leg: FadeLeg = "direct"): { out: ResolvedFade; in: ResolvedFade } {
  void match;
  void out;
  void into;
  void leg;
  const none: ResolvedFade = { seconds: 0, offset: 0, curve: "equalPower" };
  return { out: none, in: none }; // STUB(R1)
}

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
 */
import type { MusicNodeRef } from "./musicSystem";

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
  /** Id of the container whose table supplied it (the nearest common parent). */
  readonly parent: string;
  /** The rule's `exit` and `enter` as written (`"bar"`, `"nextCue"`, `"cue:outro"`, ...). */
  readonly exit: string;
  readonly enter: string;
  /** Library id of the bridge segment, or null. */
  readonly bridge: string | null;
}

/** A container's lazily built pair-to-rule table (§3.2 `RuleIndex`), cached per asset. R1 may add fields here. */
export interface RuleIndex {
  readonly container: string;
  /** `"from>to"` → the winning rule, filled on first lookup. */
  readonly pairs: Map<string, RuleMatch>;
}

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
  return { rule: -1, ruleKey: `${from}>${to}`, tier: 4, parent: "", exit: "bar", enter: "entryCue", bridge: null }; // STUB(R1)
}

/**
 * R1: the heard time (seconds) of the exit point of `match` after `notBefore` in the playing segment, clamped to the exit
 * cue; NaN when not playing. `natural` (a playlist advance) always gives the exit cue.
 */
export function exitTime(match: RuleMatch, notBefore: number, natural: boolean): number {
  void match;
  void notBefore;
  void natural;
  return Number.NaN; // STUB(R1)
}

/** R1: the file frame the incoming segment enters at (`entryCue` minus pre-entry, `sameTime`, `{cue}`). */
export function enterFrame(match: RuleMatch, to: MusicNodeRef): number {
  void match;
  void to;
  return 0; // STUB(R1)
}

/** R1: the rule's `fadeOut` and `fadeIn` in seconds at the exit point (beats under the tempo map there). */
export function resolveFades(match: RuleMatch, exitAt: number): { out: ResolvedFade; in: ResolvedFade } {
  void match;
  void exitAt;
  const none: ResolvedFade = { seconds: 0, offset: 0, curve: "equalPower" };
  return { out: none, in: none }; // STUB(R1)
}

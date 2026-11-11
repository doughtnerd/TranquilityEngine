/**
 * Transition rules, stingers and the specificity index of the interactive-music format (ADR 0166 / 0167;
 * `docs/design/0166-audio-music/api-and-models.md` §2.4 and §2.5). Pure, no I/O, never throws.
 *
 * ```jsonc
 * "transitions": [ { "from": "explore", "to": "combat", "exit": "exitCue", "enter": "entryCue",
 *                    "fadeOut": { "beats": 1, "curve": "equalPower" }, "fadeIn": { "beats": 1, "curve": "equalPower" },
 *                    "bridge": { "segment": "riser" } } ],
 * "stingers": [ { "trigger": "secret", "segment": "hit", "at": "beat", "dontRepeat": 2, "ifTooLate": "nextGrid" } ]
 * ```
 *
 * **Where things live.** The model, the shape parsers and the writers are here; `musicFormat.ts` calls them from
 * `parseMusicContainerHead` (shapes, limits) and `finishMusicContainer` (dangling ids, duplicates, shadows, which need
 * the children and the `library`) and from `musicNodeToJson`. R1 (`runtime/music/transitionRules.ts`) reads
 * `ruleIndexFor` and `resolveTransition`; R5 (`stingers.ts`) reads `resolveStinger`; Ed6 (`RulesTable`) reads
 * `analyzeTransitionRules` so its highlight equals what R1 resolves.
 *
 * Imports from `musicFormat.ts` are types, plus `MUSIC_LIMITS` read inside functions only (the two modules import each
 * other; no value is used at module load).
 *
 * **Interpretations of the design (F2 report):** a `from`/`to` names a direct child's `id` (not its `value`); `library`
 * references (`bridge.segment`, stinger `segment`) resolve in the library of the container that carries the rule;
 * the library cap is 64 per container and 64 per event; a stinger's `at` defaults to `"beat"`; an absent bridge fade
 * means "the rule's own fade"; pairs for the shadow check are every ordered pair of the container's children, a
 * child with itself included.
 */

import type { MusicContainerNode, SegmentNode } from "./musicFormat";
import type { GridSpec } from "./musicTypes";

// --- constants -----------------------------------------------------------------------------------------------------

/** Fade curves of a transition (§2.4): `equalPower` is power-complementary for a crossfade. */
export const FADE_CURVES = ["linear", "sCurve", "equalPower"] as const;
export type FadeCurve = (typeof FADE_CURVES)[number];

/** What a stinger does when its point has already passed (§2.5). */
export const IF_TOO_LATE = ["nextGrid", "playNow", "skip"] as const;
export type IfTooLate = (typeof IF_TOO_LATE)[number];

/** Stingers sounding at once per music instance; the fifth steals the oldest (§2.5, R20). A format limit. */
export const MAX_CONCURRENT_STINGERS = 4;
/** The fade of a stolen stinger, seconds (5 ms, §2.5). */
export const STINGER_STEAL_FADE_SECONDS = 0.005;
/** A grid spec's `every` count, `n` 2..64 (`GridSpec`, `musicTypes.ts`). */
export const GRID_EVERY_MIN = 2;
export const GRID_EVERY_MAX = 64;
/** Sanity bounds of a fade, in its own unit (not in the spec): amount 0..64 beats or 0..60 s; offset the same, signed. */
export const MAX_FADE_BEATS = 64;
export const MAX_FADE_SECONDS = 60;
/** Largest stinger `dontRepeat`, seconds (a sanity bound, not in the spec). */
export const MAX_DONT_REPEAT = 3600;
/** The wildcard of `from` and `to`. */
export const RULE_WILDCARD = "*";

// --- the model -----------------------------------------------------------------------------------------------------

/** One fade of a transition: `amount` in `unit`, starting `offset` (same unit, may be negative) from the exit point. */
export interface TransitionFade {
  unit: "beats" | "seconds";
  /** >= 0 (0 is a cut). */
  amount: number;
  /** Signed; 0 starts at the exit point. */
  offset: number;
  curve: FadeCurve;
}

/** When to leave the outgoing segment (§2.4): a grid point, now, the next cue, or the exit cue (the default is `"bar"`). */
export type TransitionExit = GridSpec | "immediate" | "nextCue" | "exitCue";
/** Where to enter the incoming segment: its entry cue with the pre-entry, exactly the same musical time, or a named cue. */
export type TransitionEnter = "entryCue" | "sameTime" | { cue: string };

/** A bridge: a library segment played between the two; absent fades mean the rule's own. */
export interface TransitionBridge {
  /** A library id of the container that carries the rule. */
  segment: string;
  fadeOut?: TransitionFade;
  fadeIn?: TransitionFade;
}

/** One transition rule, every default filled (the writer omits the defaults). */
export interface TransitionRule {
  /** The id of a direct child of the container, or `"*"`. */
  from: string;
  to: string;
  exit: TransitionExit;
  enter: TransitionEnter;
  fadeOut: TransitionFade;
  fadeIn: TransitionFade;
  bridge?: TransitionBridge;
}

/** Where a stinger plays: a grid point, now, or the next occurrence of a cue in the playing segment. */
export type StingerAt = GridSpec | "immediate" | { cue: string };

export interface StingerDef {
  /** The trigger name; one namespace per event. */
  trigger: string;
  /** A library id of the container that carries the stinger. */
  segment: string;
  at: StingerAt;
  /** Seconds, >= 0: the same stinger is not played again within this time. */
  dontRepeat: number;
  ifTooLate: IfTooLate;
  /** Linear gain 0..4; absent: the segment's own. */
  volume?: number;
  /** A bus name; absent: the event's. */
  bus?: string;
}

/** Tier 1..4 of a rule (§2.4): 1 pair (`from` and `to` named), 2 `from` named, 3 `to` named, 4 `*` to `*`. */
export type RuleTier = 1 | 2 | 3 | 4;

/** The always-present default rule: tier 4, bar exit, entry-cue enter, 1 beat equal-power fades (§2.4). */
export const DEFAULT_TRANSITION_RULE: Readonly<TransitionRule> = {
  from: RULE_WILDCARD, to: RULE_WILDCARD, exit: "bar", enter: "entryCue",
  fadeOut: { unit: "beats", amount: 1, offset: 0, curve: "equalPower" },
  fadeIn: { unit: "beats", amount: 1, offset: 0, curve: "equalPower" },
};

// --- parsing (shapes and limits; called from `parseMusicContainerHead`) --------------------------------------------

/**
 * A `GridSpec`: `"beat"`, `"bar"`, or `{ every: "beat" | "bar", n }` with n an integer 2..64. Anything else: a problem
 * naming `where` and `fallback`.
 */
export function parseGridSpec(raw: unknown, where: string, fallback: GridSpec, problems: string[]): GridSpec {
  void raw; void where; void problems;
  return fallback; // F2 lead: implement.
}

/**
 * A fade `{ beats | seconds, offset?, curve? }`. Both units: beats wins, with a problem; neither: `fallback`, with a
 * problem. Amount and offset are clamped to the unit's bounds with a problem. `curve` defaults to `equalPower`.
 */
export function parseTransitionFade(raw: unknown, where: string, fallback: TransitionFade, problems: string[]): TransitionFade {
  void raw; void where; void problems;
  return fallback; // F2 lead: implement.
}

/**
 * The `transitions` list of a container: <= `MUSIC_LIMITS.rules` (the rest dropped with a problem), each rule's keys
 * read leniently with the §2.4 defaults. A rule that is not an object, or has a bad `from`/`to` (not a string), is
 * dropped. Dangling ids are not checked here (`checkMusicRules`).
 */
export function parseTransitions(raw: unknown, where: string, problems: string[]): TransitionRule[] {
  void raw; void where; void problems;
  return []; // F2 lead: implement.
}

/**
 * The `stingers` list of a container: <= `MUSIC_LIMITS.stingers`, each `{ trigger, segment, at, dontRepeat, ifTooLate,
 * volume?, bus? }` read leniently with the §2.5 defaults. A stinger with no trigger or no segment is dropped.
 */
export function parseStingers(raw: unknown, where: string, problems: string[]): StingerDef[] {
  void raw; void where; void problems;
  return []; // F2 lead: implement.
}

/**
 * The event-wide library budget: `ids` is the event's shared id set, the key of a per-event counter. Returns how many of
 * `count` library segments may still be read (<= 64 per event, §2.5); the rest are dropped by the caller with the
 * problem this pushes.
 */
export function admitLibrarySegments(ids: Set<string>, count: number, where: string, problems: string[]): number {
  void ids; void where; void problems;
  return count; // F2 lead: implement.
}

// --- checks that need the children and the library (called from `finishMusicContainer`) ----------------------------

/**
 * Dangling ids and shadowing, in place. Drops (each with a problem naming the path) a rule whose `from` or `to` is
 * neither `"*"` nor a direct child's id, a rule whose `bridge.segment` is not in `node.library`, and a stinger whose
 * `segment` is not; warns (keeping the rule) on a duplicate rule (same `from` and `to` as an earlier one), on a rule
 * shadowed by an earlier or a more specific one (`analyzeTransitionRules`), and on an `enter.cue` that the incoming
 * segment child does not have.
 */
export function checkMusicRules(node: MusicContainerNode, where: string, problems: string[]): void {
  void node; void where; void problems; // F2 lead: implement.
}

// --- the specificity index -----------------------------------------------------------------------------------------

/** The tier of a rule (§2.4). */
export function ruleTier(rule: Pick<TransitionRule, "from" | "to">): RuleTier {
  void rule;
  return 4; // F2 lead: implement.
}

/** `"from>to"`: the key the debug row (`ruleKey`) and the editor show. */
export const ruleKey = (rule: Pick<TransitionRule, "from" | "to">): string => `${rule.from}>${rule.to}`;

/** What `analyzeTransitionRules` found, rule indices into the list it was given. */
export interface RuleAnalysis {
  /** Rules with the same `from` and `to` as an earlier rule: `index` repeats `of`. */
  duplicates: { index: number; of: number }[];
  /** Rules that win no pair of the children (not duplicates): `by` is a rule that wins one of the pairs they match. */
  shadowed: { index: number; by: number }[];
  /** Rules that win at least one pair, ascending. */
  effective: number[];
}

/**
 * Which rules can ever apply, over every ordered pair of `childIds` (a child with itself included): the winner of a pair
 * is the first listed rule of the best tier (§2.4), else the default rule. A duplicate is reported as one and not as
 * shadowed. A rule that names an id not in `childIds` is ignored (it is dangling). Pure.
 */
export function analyzeTransitionRules(rules: readonly TransitionRule[], childIds: readonly string[]): RuleAnalysis {
  void rules; void childIds;
  return { duplicates: [], shadowed: [], effective: [] }; // F2 lead: implement.
}

/** The pair-to-winner tables of one container, tier recorded (`RuleIndex` of §3.2). Build with `buildRuleIndex`. */
export interface RuleIndex {
  readonly rules: readonly TransitionRule[];
  /** `from>to` to the first rule index (tier 1). */
  readonly byPair: ReadonlyMap<string, number>;
  /** `from` to the first rule with `to` `"*"` (tier 2). */
  readonly byFrom: ReadonlyMap<string, number>;
  /** `to` to the first rule with `from` `"*"` (tier 3). */
  readonly byTo: ReadonlyMap<string, number>;
  /** First `*`>`*` rule (tier 4), or -1 for the default rule. */
  readonly wildcard: number;
}

/** The rule a change resolves to. */
export interface ResolvedTransition {
  rule: Readonly<TransitionRule>;
  /** Index into the container's `transitions`; -1 for the always-present default rule. */
  index: number;
  tier: RuleTier;
  /** `"from>to"` of the rule (`"*>*"` for the default). */
  key: string;
}

/** Build the index of a rule list (cheap: one pass). */
export function buildRuleIndex(rules: readonly TransitionRule[]): RuleIndex {
  return { rules, byPair: new Map(), byFrom: new Map(), byTo: new Map(), wildcard: -1 }; // F2 lead: implement.
}

/**
 * The cached index of a container, keyed by its `transitions` array (treat parsed nodes as immutable; a fresh array
 * means a fresh index). R1 calls this once per change.
 */
export function ruleIndexFor(container: Pick<MusicContainerNode, "transitions">): RuleIndex {
  return buildRuleIndex(container.transitions); // F2 lead: implement the cache.
}

/**
 * The winning rule for a change from the child `from` to the child `to` of the container the index was built for:
 * tier 1 pair, then tier 2 `from`, tier 3 `to`, then tier 4, then the default; the first listed wins inside a tier.
 * Ids that match no rule fall through to the wildcard tiers. Pure, allocation free on a hit.
 */
export function resolveTransition(index: RuleIndex, from: string, to: string): ResolvedTransition {
  void index; void from; void to;
  return { rule: DEFAULT_TRANSITION_RULE, index: -1, tier: 4, key: "*>*" }; // F2 lead: implement.
}

// --- stingers ------------------------------------------------------------------------------------------------------

/** A stinger a trigger resolves to, with its segment looked up in the library of the container that carries it. */
export interface ResolvedStinger {
  stinger: Readonly<StingerDef>;
  container: MusicContainerNode;
  /** Index into `container.stingers`. */
  index: number;
  /** The library segment. */
  segment: SegmentNode;
}

/**
 * `trigger`'s stinger: `containers` is the chain of containers above the playing segment, outermost first. The deepest
 * container with a matching stinger wins, then list order (§2.5). Null when none matches or its segment is missing.
 */
export function resolveStinger(containers: readonly MusicContainerNode[], trigger: string): ResolvedStinger | null {
  void containers; void trigger;
  return null; // F2 lead: implement.
}

/** Every trigger name of an event's music tree (one namespace per event), sorted, once each. */
export function musicTriggers(root: { type: string }): string[] {
  void root;
  return []; // F2 lead: implement.
}

// --- writing (called from `musicNodeToJson`) -----------------------------------------------------------------------

/** One rule as JSON, defaults omitted (`from`/`to` `"*"`, `exit` `"bar"`, `enter` `"entryCue"`, the default fades). */
export function transitionToJson(rule: TransitionRule): Record<string, unknown> {
  void rule;
  return {}; // F2 lead: implement.
}

/** One stinger as JSON, defaults omitted (`at` `"beat"`, `dontRepeat` 0, `ifTooLate` `"nextGrid"`, absent volume and bus). */
export function stingerToJson(stinger: StingerDef): Record<string, unknown> {
  void stinger;
  return {}; // F2 lead: implement.
}

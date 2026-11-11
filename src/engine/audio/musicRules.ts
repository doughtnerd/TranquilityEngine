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

import { MUSIC_LIMITS, type MusicContainerNode, type SegmentNode } from "./musicFormat";
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

// --- small readers -------------------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A list cut at `max` entries with one problem; a non-list is a problem and gives none. */
function cappedList(raw: unknown, where: string, max: number, problems: string[]): unknown[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { problems.push(`${where}: must be a list.`); return []; }
  if (raw.length <= max) return raw;
  problems.push(`${where}: at most ${max} entries; the rest are dropped.`);
  return raw.slice(0, max);
}

function clamped(raw: number, where: string, min: number, max: number, problems: string[]): number {
  if (raw >= min && raw <= max) return raw;
  const c = Math.min(max, Math.max(min, raw));
  problems.push(`${where}: ${raw} is outside ${min}..${max}; using ${c}.`);
  return c;
}

const gridText = (g: GridSpec): string => (typeof g === "string" ? `"${g}"` : JSON.stringify(g));

// --- parsing (shapes and limits; called from `parseMusicContainerHead`) --------------------------------------------

/**
 * A `GridSpec`: `"beat"`, `"bar"`, or `{ every: "beat" | "bar", n }` with n an integer 2..64. Anything else: a problem
 * naming `where` and `fallback`.
 */
export function parseGridSpec(raw: unknown, where: string, fallback: GridSpec, problems: string[]): GridSpec {
  if (raw === "beat" || raw === "bar") return raw;
  if (isRecord(raw) && (raw.every === "beat" || raw.every === "bar") && typeof raw.n === "number" && Number.isInteger(raw.n)
    && raw.n >= GRID_EVERY_MIN && raw.n <= GRID_EVERY_MAX) {
    return { every: raw.every, n: raw.n };
  }
  problems.push(`${where}: must be "beat", "bar" or { every: "beat" | "bar", n: ${GRID_EVERY_MIN}..${GRID_EVERY_MAX} }; using ${gridText(fallback)}.`);
  return fallback;
}

/**
 * A fade `{ beats | seconds, offset?, curve? }`. Both units: beats wins, with a problem; neither: `fallback`, with a
 * problem. Amount and offset are clamped to the unit's bounds with a problem. `curve` defaults to `equalPower`.
 */
export function parseTransitionFade(raw: unknown, where: string, fallback: TransitionFade, problems: string[]): TransitionFade {
  if (!isRecord(raw)) { problems.push(`${where}: must be { beats | seconds, offset?, curve? }; using the default.`); return { ...fallback }; }
  const hasB = raw.beats !== undefined, hasS = raw.seconds !== undefined;
  if (!hasB && !hasS) { problems.push(`${where}: needs beats or seconds; using the default.`); return { ...fallback }; }
  if (hasB && hasS) problems.push(`${where}: has both beats and seconds; using beats.`);
  const unit = hasB ? "beats" : "seconds";
  const max = unit === "beats" ? MAX_FADE_BEATS : MAX_FADE_SECONDS;
  const amountRaw = raw[unit];
  if (!finite(amountRaw)) { problems.push(`${where}.${unit}: must be a number; using the default.`); return { ...fallback }; }
  const amount = clamped(amountRaw, `${where}.${unit}`, 0, max, problems);
  let offset = 0;
  if (raw.offset !== undefined) {
    if (finite(raw.offset)) offset = clamped(raw.offset, `${where}.offset`, -max, max, problems);
    else problems.push(`${where}.offset: must be a number; using 0.`);
  }
  let curve: FadeCurve = "equalPower";
  if (raw.curve !== undefined) {
    if (typeof raw.curve === "string" && (FADE_CURVES as readonly string[]).includes(raw.curve)) curve = raw.curve as FadeCurve;
    else problems.push(`${where}.curve: must be one of ${FADE_CURVES.join(", ")}; using "equalPower".`);
  }
  return { unit, amount, offset, curve };
}

const EXIT_WORDS = ["immediate", "nextCue", "exitCue"] as const;

/**
 * The `transitions` list of a container: <= `MUSIC_LIMITS.rules` (the rest dropped with a problem), each rule's keys
 * read leniently with the §2.4 defaults. A rule that is not an object, or has a bad `from`/`to` (not a string), is
 * dropped. Dangling ids are not checked here (`checkMusicRules`).
 */
export function parseTransitions(raw: unknown, where: string, problems: string[]): TransitionRule[] {
  const out: TransitionRule[] = [];
  const d = DEFAULT_TRANSITION_RULE;
  cappedList(raw, where, MUSIC_LIMITS.rules, problems).forEach((r, i) => {
    const w = `${where}[${i}]`;
    if (!isRecord(r)) return void problems.push(`${w}: a rule must be an object; dropped.`);
    const ends: string[] = [];
    for (const key of ["from", "to"] as const) {
      const v = r[key];
      if (v === undefined) ends.push(RULE_WILDCARD);
      else if (nonEmpty(v)) ends.push(v);
      else return void problems.push(`${w}.${key}: must be a child id or "*"; the rule is dropped.`);
    }
    let exit: TransitionExit = d.exit;
    if (r.exit !== undefined) {
      if (typeof r.exit === "string" && (EXIT_WORDS as readonly string[]).includes(r.exit)) exit = r.exit as TransitionExit;
      else exit = parseGridSpec(r.exit, `${w}.exit`, d.exit as GridSpec, problems);
    }
    let enter: TransitionEnter = d.enter;
    if (r.enter !== undefined) {
      if (r.enter === "entryCue" || r.enter === "sameTime") enter = r.enter;
      else if (isRecord(r.enter) && nonEmpty(r.enter.cue)) enter = { cue: r.enter.cue };
      else problems.push(`${w}.enter: must be "entryCue", "sameTime" or { cue }; using "entryCue".`);
    }
    const rule: TransitionRule = {
      from: ends[0], to: ends[1], exit, enter,
      fadeOut: r.fadeOut === undefined ? { ...d.fadeOut } : parseTransitionFade(r.fadeOut, `${w}.fadeOut`, d.fadeOut, problems),
      fadeIn: r.fadeIn === undefined ? { ...d.fadeIn } : parseTransitionFade(r.fadeIn, `${w}.fadeIn`, d.fadeIn, problems),
    };
    if (r.bridge !== undefined) {
      if (!isRecord(r.bridge) || !nonEmpty(r.bridge.segment)) problems.push(`${w}.bridge: needs a library segment id; the bridge is ignored.`);
      else {
        const bridge: TransitionBridge = { segment: r.bridge.segment };
        if (r.bridge.fadeOut !== undefined) bridge.fadeOut = parseTransitionFade(r.bridge.fadeOut, `${w}.bridge.fadeOut`, d.fadeOut, problems);
        if (r.bridge.fadeIn !== undefined) bridge.fadeIn = parseTransitionFade(r.bridge.fadeIn, `${w}.bridge.fadeIn`, d.fadeIn, problems);
        rule.bridge = bridge;
      }
    }
    out.push(rule);
  });
  return out;
}

/**
 * The `stingers` list of a container: <= `MUSIC_LIMITS.stingers`, each `{ trigger, segment, at, dontRepeat, ifTooLate,
 * volume?, bus? }` read leniently with the §2.5 defaults. A stinger with no trigger or no segment is dropped.
 */
export function parseStingers(raw: unknown, where: string, problems: string[]): StingerDef[] {
  const out: StingerDef[] = [];
  cappedList(raw, where, MUSIC_LIMITS.stingers, problems).forEach((s, i) => {
    const w = `${where}[${i}]`;
    if (!isRecord(s)) return void problems.push(`${w}: a stinger must be an object; dropped.`);
    if (!nonEmpty(s.trigger)) return void problems.push(`${w}.trigger: must be a non-empty name; the stinger is dropped.`);
    if (!nonEmpty(s.segment)) return void problems.push(`${w}.segment: must be a library segment id; the stinger is dropped.`);
    let at: StingerAt = "beat";
    if (s.at !== undefined) {
      if (s.at === "immediate") at = "immediate";
      else if (isRecord(s.at) && s.at.cue !== undefined) {
        if (nonEmpty(s.at.cue)) at = { cue: s.at.cue };
        else problems.push(`${w}.at: cue must be a cue name; using "beat".`);
      } else at = parseGridSpec(s.at, `${w}.at`, "beat", problems);
    }
    let ifTooLate: IfTooLate = "nextGrid";
    if (s.ifTooLate !== undefined) {
      if (typeof s.ifTooLate === "string" && (IF_TOO_LATE as readonly string[]).includes(s.ifTooLate)) ifTooLate = s.ifTooLate as IfTooLate;
      else problems.push(`${w}.ifTooLate: must be one of ${IF_TOO_LATE.join(", ")}; using "nextGrid".`);
    }
    let dontRepeat = 0;
    if (s.dontRepeat !== undefined) {
      if (finite(s.dontRepeat)) dontRepeat = clamped(s.dontRepeat, `${w}.dontRepeat`, 0, MAX_DONT_REPEAT, problems);
      else problems.push(`${w}.dontRepeat: must be a number of seconds; using 0.`);
    }
    const stinger: StingerDef = { trigger: s.trigger, segment: s.segment, at, dontRepeat, ifTooLate };
    if (s.volume !== undefined) {
      if (finite(s.volume)) stinger.volume = clamped(s.volume, `${w}.volume`, 0, 4, problems);
      else problems.push(`${w}.volume: must be a number; ignored.`);
    }
    if (s.bus !== undefined) {
      if (typeof s.bus !== "string") problems.push(`${w}.bus: must be a bus name; ignored.`);
      else if (s.bus !== "") stinger.bus = s.bus;
    }
    out.push(stinger);
  });
  return out;
}

const libraryUsed = new WeakMap<Set<string>, number>();

/**
 * The event-wide library budget: `ids` is the event's shared id set, the key of a per-event counter. Returns how many of
 * `count` library segments may still be read (<= 64 per event, §2.5); the rest are dropped by the caller with the
 * problem this pushes.
 */
export function admitLibrarySegments(ids: Set<string>, count: number, where: string, problems: string[]): number {
  const used = libraryUsed.get(ids) ?? 0;
  const allowed = Math.max(0, Math.min(count, MUSIC_LIMITS.library - used));
  libraryUsed.set(ids, used + allowed);
  if (allowed < count) problems.push(`${where}: at most ${MUSIC_LIMITS.library} library segments per event; the rest are dropped.`);
  return allowed;
}

// --- the specificity index -----------------------------------------------------------------------------------------

/** The tier of a rule (§2.4). */
export function ruleTier(rule: Pick<TransitionRule, "from" | "to">): RuleTier {
  const f = rule.from !== RULE_WILDCARD, t = rule.to !== RULE_WILDCARD;
  return f && t ? 1 : f ? 2 : t ? 3 : 4;
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

/** Build the index of a rule list (cheap: one pass). The first listed rule of each key wins. */
export function buildRuleIndex(rules: readonly TransitionRule[]): RuleIndex {
  const byPair = new Map<string, number>(), byFrom = new Map<string, number>(), byTo = new Map<string, number>();
  let wildcard = -1;
  rules.forEach((r, i) => {
    switch (ruleTier(r)) {
      case 1: if (!byPair.has(ruleKey(r))) byPair.set(ruleKey(r), i); break;
      case 2: if (!byFrom.has(r.from)) byFrom.set(r.from, i); break;
      case 3: if (!byTo.has(r.to)) byTo.set(r.to, i); break;
      default: if (wildcard < 0) wildcard = i;
    }
  });
  return { rules, byPair, byFrom, byTo, wildcard };
}

const indexCache = new WeakMap<readonly TransitionRule[], RuleIndex>();

/**
 * The cached index of a container, keyed by its `transitions` array (treat parsed nodes as immutable; a fresh array
 * means a fresh index). R1 calls this once per change.
 */
export function ruleIndexFor(container: Pick<MusicContainerNode, "transitions">): RuleIndex {
  let index = indexCache.get(container.transitions);
  if (!index) { index = buildRuleIndex(container.transitions); indexCache.set(container.transitions, index); }
  return index;
}

/**
 * The winning rule for a change from the child `from` to the child `to` of the container the index was built for:
 * tier 1 pair, then tier 2 `from`, tier 3 `to`, then tier 4, then the default; the first listed wins inside a tier.
 * Ids that match no rule fall through to the wildcard tiers. Pure.
 */
export function resolveTransition(index: RuleIndex, from: string, to: string): ResolvedTransition {
  const hit = (i: number, tier: RuleTier): ResolvedTransition => ({ rule: index.rules[i], index: i, tier, key: ruleKey(index.rules[i]) });
  const pair = index.byPair.get(`${from}>${to}`);
  if (pair !== undefined) return hit(pair, 1);
  const f = index.byFrom.get(from);
  if (f !== undefined) return hit(f, 2);
  const t = index.byTo.get(to);
  if (t !== undefined) return hit(t, 3);
  if (index.wildcard >= 0) return hit(index.wildcard, 4);
  return { rule: DEFAULT_TRANSITION_RULE, index: -1, tier: 4, key: ruleKey(DEFAULT_TRANSITION_RULE) };
}

/**
 * Which rules can ever apply, over every ordered pair of `childIds` (a child with itself included): the winner of a pair
 * is the first listed rule of the best tier (§2.4), else the default rule. A duplicate is reported as one and not as
 * shadowed. A rule that names an id not in `childIds` is ignored (it is dangling). Pure.
 */
export function analyzeTransitionRules(rules: readonly TransitionRule[], childIds: readonly string[]): RuleAnalysis {
  const index = buildRuleIndex(rules);
  const duplicates: RuleAnalysis["duplicates"] = [];
  const firstOf = new Map<string, number>();
  rules.forEach((r, i) => {
    const k = ruleKey(r), of = firstOf.get(k);
    if (of === undefined) firstOf.set(k, i);
    else duplicates.push({ index: i, of });
  });
  const dup = new Set(duplicates.map((d) => d.index));
  const known = new Set(childIds);
  const dangling = (r: TransitionRule): boolean => (r.from !== RULE_WILDCARD && !known.has(r.from)) || (r.to !== RULE_WILDCARD && !known.has(r.to));
  const wins = new Set<number>();
  for (const f of childIds) for (const t of childIds) wins.add(resolveTransition(index, f, t).index);
  const shadowed: RuleAnalysis["shadowed"] = [];
  rules.forEach((r, i) => {
    if (wins.has(i) || dup.has(i) || dangling(r) || childIds.length === 0) return;
    const f = r.from === RULE_WILDCARD ? childIds[0] : r.from, t = r.to === RULE_WILDCARD ? childIds[0] : r.to;
    shadowed.push({ index: i, by: resolveTransition(index, f, t).index });
  });
  return { duplicates, shadowed, effective: [...wins].filter((i) => i >= 0).sort((a, b) => a - b) };
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
  const childIds = node.children.map((c) => c.id);
  const known = new Set(childIds);
  const library = new Set(node.library.map((s) => s.id));
  const origin: number[] = [];
  const kept: TransitionRule[] = [];
  node.transitions.forEach((r, i) => {
    const w = `${where}.transitions[${i}]`;
    for (const key of ["from", "to"] as const) {
      if (r[key] !== RULE_WILDCARD && !known.has(r[key])) return void problems.push(`${w}.${key}: "${r[key]}" is not a direct child of this container; the rule is dropped.`);
    }
    if (r.bridge && !library.has(r.bridge.segment)) return void problems.push(`${w}.bridge.segment: "${r.bridge.segment}" is not in this container's library; the rule is dropped.`);
    if (typeof r.enter === "object" && r.to !== RULE_WILDCARD) {
      const target = node.children.find((c) => c.id === r.to);
      const cue = r.enter.cue;
      if (target?.type === "segment" && !target.cues.some((c) => c.name === cue)) problems.push(`${w}.enter: segment "${r.to}" has no cue named "${cue}".`);
    }
    origin.push(i);
    kept.push(r);
  });
  node.transitions = kept;
  const a = analyzeTransitionRules(kept, childIds);
  for (const d of a.duplicates) {
    problems.push(`${where}.transitions[${origin[d.index]}]: duplicates rule ${origin[d.of]} (same from and to "${ruleKey(kept[d.index])}"); the first wins.`);
  }
  for (const s of a.shadowed) {
    problems.push(`${where}.transitions[${origin[s.index]}]: shadowed by rule ${s.by < 0 ? "(the default)" : origin[s.by]}; it never applies.`);
  }
  node.stingers = node.stingers.filter((s, i) => {
    if (library.has(s.segment)) return true;
    problems.push(`${where}.stingers[${i}].segment: "${s.segment}" is not in this container's library; the stinger is dropped.`);
    return false;
  });
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
  for (let c = containers.length - 1; c >= 0; c--) {
    const container = containers[c];
    for (let i = 0; i < container.stingers.length; i++) {
      const stinger = container.stingers[i];
      if (stinger.trigger !== trigger) continue;
      const segment = container.library.find((s) => s.id === stinger.segment);
      if (segment) return { stinger, container, index: i, segment };
    }
  }
  return null;
}

/** Every trigger name of an event's music tree (one namespace per event), sorted, once each. */
export function musicTriggers(root: { type: string }): string[] {
  const out = new Set<string>();
  const walk = (n: { type: string }): void => {
    const c = n as Partial<MusicContainerNode>;
    if (!Array.isArray(c.stingers) || !Array.isArray(c.children)) return;
    for (const s of c.stingers) out.add(s.trigger);
    c.children.forEach(walk);
  };
  walk(root);
  return [...out].sort();
}

// --- writing (called from `musicNodeToJson`) -----------------------------------------------------------------------

function fadeToJson(f: TransitionFade): Record<string, unknown> {
  const out: Record<string, unknown> = { [f.unit]: f.amount };
  if (f.offset !== 0) out.offset = f.offset;
  if (f.curve !== "equalPower") out.curve = f.curve;
  return out;
}

/** One rule as JSON, defaults omitted (`from`/`to` `"*"`, `exit` `"bar"`, `enter` `"entryCue"`, the default fades). */
export function transitionToJson(rule: TransitionRule): Record<string, unknown> {
  const d = DEFAULT_TRANSITION_RULE;
  const out: Record<string, unknown> = {};
  if (rule.from !== RULE_WILDCARD) out.from = rule.from;
  if (rule.to !== RULE_WILDCARD) out.to = rule.to;
  if (!sameJson(rule.exit, d.exit)) out.exit = rule.exit;
  if (!sameJson(rule.enter, d.enter)) out.enter = rule.enter;
  if (!sameJson(rule.fadeOut, d.fadeOut)) out.fadeOut = fadeToJson(rule.fadeOut);
  if (!sameJson(rule.fadeIn, d.fadeIn)) out.fadeIn = fadeToJson(rule.fadeIn);
  if (rule.bridge) {
    out.bridge = {
      segment: rule.bridge.segment,
      ...(rule.bridge.fadeOut ? { fadeOut: fadeToJson(rule.bridge.fadeOut) } : {}),
      ...(rule.bridge.fadeIn ? { fadeIn: fadeToJson(rule.bridge.fadeIn) } : {}),
    };
  }
  return out;
}

/** One stinger as JSON, defaults omitted (`at` `"beat"`, `dontRepeat` 0, `ifTooLate` `"nextGrid"`, absent volume and bus). */
export function stingerToJson(stinger: StingerDef): Record<string, unknown> {
  const out: Record<string, unknown> = { trigger: stinger.trigger, segment: stinger.segment };
  if (stinger.at !== "beat") out.at = stinger.at;
  if (stinger.dontRepeat !== 0) out.dontRepeat = stinger.dontRepeat;
  if (stinger.ifTooLate !== "nextGrid") out.ifTooLate = stinger.ifTooLate;
  if (stinger.volume !== undefined) out.volume = stinger.volume;
  if (stinger.bus !== undefined) out.bus = stinger.bus;
  return out;
}

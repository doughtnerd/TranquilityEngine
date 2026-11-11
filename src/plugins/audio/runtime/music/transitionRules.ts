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
import {
  DEFAULT_TRANSITION_RULE, buildRuleIndex, resolveTransition, ruleIndexFor, ruleKey as formatRuleKey,
  type RuleIndex as FormatRuleIndex, type TransitionExit, type TransitionFade, type TransitionRule,
} from "../../../../engine/audio/musicRules";
import { isMusicContainer, type MusicContainerNode, type MusicNode } from "../../../../engine/audio/musicFormat";
import {
  cueTicks, entrySeconds, exitSeconds, nextGridSeconds, secondsToFrames, secondsToTicks, ticksToSeconds,
  type SegmentGrid,
} from "../../../../engine/audio/musicGrid";
import { MUSIC_TICKS_PER_BEAT } from "../../../../engine/audio/musicPosition";

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
  /** R1: F2's specificity index of the same `transitions` array (`ruleIndexFor`). */
  readonly rules: FormatRuleIndex;
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

/** Float noise allowed when comparing file seconds (far under a frame at 192 kHz, 5.2e-6 s). */
const SECONDS_EPSILON = 1e-9;

// --- rule lookup ----------------------------------------------------------------------------------------------------

const EMPTY_RULES: readonly TransitionRule[] = [];
/** Keyed by the container's `transitions` array: a reparsed or hot-reloaded asset has fresh arrays, so a fresh index. */
const indexCache = new WeakMap<readonly TransitionRule[], RuleIndex>();

/** `exit` as the debug row and the editor show it. */
function exitText(exit: TransitionExit): string {
  if (typeof exit === "string") return exit;
  return `${exit.n} ${exit.every}s`;
}

/** `enter` as the debug row and the editor show it. */
function enterText(enter: TransitionRule["enter"]): string {
  return typeof enter === "string" ? enter : `cue:${enter.cue}`;
}

/** R1: the index of a container's `transitions` (cached per asset and container id). */
export function ruleIndexOf(container: MusicNodeRef): RuleIndex {
  const transitions = isMusicContainer(container) ? (container as MusicContainerNode).transitions : EMPTY_RULES;
  let index = indexCache.get(transitions);
  if (!index || index.container !== container.id) {
    const rules = transitions === EMPTY_RULES ? buildRuleIndex(EMPTY_RULES) : ruleIndexFor({ transitions: transitions as TransitionRule[] });
    index = { container: container.id, pairs: new Map(), rules };
    if (transitions !== EMPTY_RULES) indexCache.set(transitions, index);
  }
  return index;
}

/**
 * R1: the rule a change from the direct child `fromChild` to the direct child `toChild` of `container` resolves to in
 * that container's own table (F2's `resolveTransition`, cached per pair). The editor's rules table (Ed6) reads the same.
 */
export function matchInContainer(container: MusicNodeRef, fromChild: string, toChild: string): RuleMatch {
  const index = ruleIndexOf(container);
  const key = `${fromChild}>${toChild}`;
  let match = index.pairs.get(key);
  if (!match) {
    match = toMatch(resolveTransition(index.rules, fromChild, toChild), container.id);
    index.pairs.set(key, match);
  }
  return match;
}

function toMatch(r: ReturnType<typeof resolveTransition>, parent: string): RuleMatch {
  return {
    rule: r.index, ruleKey: r.key, tier: r.tier, parent,
    exit: exitText(r.rule.exit), enter: enterText(r.rule.enter),
    bridge: r.rule.bridge?.segment ?? null, transition: r.rule,
  };
}

/** The default rule's match, `parent` the container whose table it stands for (`""`: none). */
function defaultMatch(parent: string): RuleMatch {
  const d = DEFAULT_TRANSITION_RULE;
  return {
    rule: -1, ruleKey: formatRuleKey(d), tier: 4, parent,
    exit: exitText(d.exit), enter: enterText(d.enter), bridge: null, transition: d,
  };
}

/** Each node id of a music tree (children only; `library` segments are not children) to its parent, null for the root. */
const parentsCache = new WeakMap<object, Map<string, MusicNode | null>>();

function parentsOf(root: MusicNode): Map<string, MusicNode | null> {
  let parents = parentsCache.get(root);
  if (parents) return parents;
  parents = new Map();
  const walk = (node: MusicNode, parent: MusicNode | null): void => {
    if (!parents!.has(node.id)) parents!.set(node.id, parent);
    if (isMusicContainer(node)) for (const child of node.children) walk(child, node);
  };
  walk(root, null);
  parentsCache.set(root, parents);
  return parents;
}

/** The strict ancestors of `id`, root first; null when `id` is not in the tree. */
function ancestors(root: MusicNode, parents: Map<string, MusicNode | null>, id: string): MusicNode[] | null {
  if (id === root.id) return [];
  if (!parents.has(id)) return null;
  const chain: MusicNode[] = [];
  for (let p = parents.get(id) ?? null; p; p = parents.get(p.id) ?? null) chain.push(p);
  chain.reverse();
  return chain;
}

/**
 * R1: the rule for a change from segment `from` to node `to` under the music root `root` (nearest common parent, tiers,
 * list order; the default rule when nothing matches). The nearest common parent is the deepest container that is a
 * strict ancestor of both; only its table is read (its default rule wins over an outer table's rules). A change from a
 * node to itself, or to a container that holds it, names the same child on both sides. An unknown id, or a segment
 * root, gives the default rule with parent `""`.
 */
export function findRule(root: MusicNodeRef, from: string, to: string): RuleMatch {
  const tree = root as MusicNode;
  if (!isMusicContainer(tree)) return defaultMatch("");
  const parents = parentsOf(tree);
  const a = ancestors(tree, parents, from), b = ancestors(tree, parents, to);
  if (!a || !b || a.length === 0 || b.length === 0) return defaultMatch("");
  let k = 0;
  while (k + 1 < a.length && k + 1 < b.length && a[k + 1] === b[k + 1]) k++;
  const parent = a[k];
  const fromChild = a[k + 1]?.id ?? from;
  const toChild = b[k + 1]?.id ?? to;
  return matchInContainer(parent, fromChild, toChild);
}

// --- the heard clock ------------------------------------------------------------------------------------------------

/** File seconds of the anchor. */
const anchorFile = (p: PlayingGrid): number => ticksToSeconds(p.grid, p.anchorTicks);
/** Heard seconds of file seconds `file` (this pass). */
const heardOfFile = (p: PlayingGrid, file: number): number => p.anchorTime + (file - anchorFile(p));
/** File seconds heard at `time` (this pass). */
const fileOfHeard = (p: PlayingGrid, time: number): number => anchorFile(p) + (time - p.anchorTime);

/** R1: heard seconds of `ticks` on the playing segment (this pass). */
export function heardTimeAt(playing: PlayingGrid, ticks: number): number {
  return heardOfFile(playing, ticksToSeconds(playing.grid, ticks));
}

/** R1: the playing segment's position (fractional ticks) heard at `time`. */
export function ticksAtHeard(playing: PlayingGrid, time: number): number {
  return secondsToTicks(playing.grid, fileOfHeard(playing, time));
}

// --- exit -----------------------------------------------------------------------------------------------------------

/** File seconds of the first cue at or after file seconds `at`, or NaN. */
function nextCueSeconds(grid: SegmentGrid, at: number): number {
  let best = Number.NaN;
  for (let i = 0; i < grid.cueTicks.length; i++) {
    const t = grid.cueTicks[i];
    if (Number.isNaN(t)) continue;
    const s = ticksToSeconds(grid, t);
    if (s >= at - SECONDS_EPSILON && !(s >= best)) best = s;
  }
  return best;
}

/**
 * R1: the heard time (seconds) of the exit point of `match` at or after `notBefore` in the playing segment, clamped to
 * the exit cue. `natural` (a playlist advance) always gives the exit cue, even before `notBefore`. NaN when the exit
 * cue is unknown for an exit that needs it, or when no point at or before the exit cue is at or after `notBefore`.
 */
export function exitTime(match: RuleMatch, playing: PlayingGrid, notBefore: number, natural: boolean): number {
  const grid = playing.grid;
  const exitFile = exitSeconds(grid) ?? Number.NaN;
  if (natural) return Number.isFinite(exitFile) ? heardOfFile(playing, exitFile) : Number.NaN;
  if (!Number.isFinite(notBefore)) return Number.NaN;
  const nb = fileOfHeard(playing, notBefore);
  if (exitFile < nb - SECONDS_EPSILON) return Number.NaN; // past the exit cue: the tail; nothing to leave from
  const exit = match.transition.exit;
  let point: number;
  if (exit === "immediate") point = nb;
  else if (exit === "exitCue") point = exitFile;
  else if (exit === "nextCue") point = nextCueSeconds(grid, nb);
  else point = nextGridSeconds(grid, nb, exit);
  if (Number.isFinite(exitFile) && !(point <= exitFile)) point = exitFile; // the clamp (also: no cue left before it)
  if (!Number.isFinite(point)) return Number.NaN;
  return point === nb ? notBefore : heardOfFile(playing, point);
}

// --- enter ----------------------------------------------------------------------------------------------------------

/**
 * R1: where the incoming segment `to` starts. `entryCue`: the file start (the pre-entry is everything before the entry
 * cue, which lands on T). `sameTime`: the outgoing's musical time since its entry cue at T (`from`), counted from the
 * incoming's entry cue, wrapping by the incoming's entry-to-exit length when it runs past the exit cue. `{cue}`: that
 * cue; a cue the segment lacks reads as `entryCue`. No pre-entry for either. A start before the file (a `sameTime`
 * before the outgoing's entry, beyond the incoming's pickup) starts at the file start.
 */
export function enterPoint(match: RuleMatch, to: SegmentGrid, from: GridAt): EnterPoint {
  const enter = match.transition.enter;
  let ticks: number | null = null;
  if (enter === "sameTime") {
    const elapsed = from.ticks - from.grid.entryTicks;
    ticks = to.entryTicks + elapsed;
    const length = to.exitTicks - to.entryTicks;
    if (Number.isFinite(length) && length > 0 && ticks >= to.exitTicks) ticks = to.entryTicks + (elapsed % length);
  } else if (typeof enter === "object") {
    ticks = cueTicks(to, enter.cue);
  }
  if (ticks === null) {
    return { seconds: 0, preEntry: Math.max(0, entrySeconds(to)), ticksAtExit: to.entryTicks };
  }
  const seconds = ticksToSeconds(to, ticks);
  if (seconds < 0) return { seconds: 0, preEntry: 0, ticksAtExit: secondsToTicks(to, 0) };
  return { seconds, preEntry: 0, ticksAtExit: ticks };
}

/** R1: the file frame the incoming segment enters at (`enterPoint(...).seconds` at `rate`, G1's rounding). */
export function enterFrame(match: RuleMatch, to: SegmentGrid, from: GridAt, rate: number): number {
  return secondsToFrames(enterPoint(match, to, from).seconds, rate);
}

// --- fades ----------------------------------------------------------------------------------------------------------

/** One fade relative to T, a fade in beats converted through `side`'s tempo map from its position at T. */
function resolveFade(fade: TransitionFade, side: GridAt): ResolvedFade {
  if (fade.unit === "seconds") return { seconds: fade.amount, offset: fade.offset, curve: fade.curve };
  const base = side.ticks;
  const start = base + fade.offset * MUSIC_TICKS_PER_BEAT;
  const end = start + fade.amount * MUSIC_TICKS_PER_BEAT;
  const t0 = ticksToSeconds(side.grid, base), ts = ticksToSeconds(side.grid, start);
  return { seconds: ticksToSeconds(side.grid, end) - ts, offset: ts - t0, curve: fade.curve };
}

/**
 * R1: the rule's fades in seconds relative to T. `out` is the outgoing side at T, `into` the incoming side at T
 * (`enterPoint(...).ticksAtExit`); a fade in beats, and its offset, convert through that side's own tempo map from T
 * plus the offset, so a fade across a tempo change takes the seconds of both spans. `leg`: `direct` and `toBridge` use
 * the rule's `fadeOut`/`fadeIn`; `fromBridge` uses `bridge.fadeOut`/`fadeIn`, each defaulting to the rule's.
 */
export function resolveFades(match: RuleMatch, out: GridAt, into: GridAt, leg: FadeLeg = "direct"): { out: ResolvedFade; in: ResolvedFade } {
  const rule = match.transition;
  const bridge = leg === "fromBridge" ? rule.bridge : undefined;
  return {
    out: resolveFade(bridge?.fadeOut ?? rule.fadeOut, out),
    in: resolveFade(bridge?.fadeIn ?? rule.fadeIn, into),
  };
}


/**
 * Transition execution and bridges (ADR 0166 api-and-models §2.4, §3.2 `Transition`; architecture §3.2, §3.3, §2.1
 * "Pending").
 *
 * Owners: **R3a** (W6) fills execution and exports `planImmediate` (hook H5, which R7's `seek.ts` uses); **R3b** (W7)
 * fills bridges (A to bridge to B as two chained plans with sequential priming; decoded bridges need no ring). Q2 wrote
 * the skeleton.
 *
 * The incoming group is stamped at exit minus pre-entry; the outgoing is faded in the voice (R5: on the `fade` ramp, a
 * shaped FADE); a post-exit tail rings on under the next segment; rings are accounted for both sets. At most one pending
 * transition per container; a newer target replaces an unstarted one until T - L (its rings closed, its SCHEDULED voices
 * STOPped), after which it becomes the next transition.
 *
 * **R3a's execution.** R1's call order, through P2's planner:
 * - `findRule(root, playing, to)` → the match; T is the planner's point from `exitTime(match, playing, t, natural)`
 *   (unrolled over loop passes: a point past the playing region's next wrap is asked again in the pass after it); the
 *   start frame is `enterFrame` at T; the group starts at T - preEntry; the fades are `resolveFades` at T.
 * - **Incoming:** stamped by the planner when primed. A fade-in (seconds > 0, or an offset after the group's start)
 *   starts the members silent (a 0-second FADE to 0 at the group's start, the same frame as the PLAY; see "fadeZero"
 *   below) and opens them with a shaped FADE to 1 at T + offset (`equalPowerIn`, `sCurve`, `linear`). A fade-in that
 *   starts before the group starts its ramp at the group's start with the phase u₀ it has there. No fade: full level
 *   from the first sample (a cut).
 * - **Outgoing:** a shaped FADE to 0 with `stopAtEnd` at T + offset (`equalPowerOut`, ...); 0 seconds is a STOP on that
 *   exact sample (a cut). An exit at the exit cue (a natural advance, an `exitCue` exit, or a clamp) doesn't fade the
 *   outgoing at all: its post-exit tail rings on under the next segment, ramp-free, until its voices end (§2.4).
 * - **The cancel point** is min(group start, outgoing fade start) - L. A core FADE with `stopAtEnd` can't be taken back
 *   (`voices::fade`: "a stop under way stays a stop"), so the outgoing fade is stamped not in the incoming's frame but
 *   in the last frame before the cancel point (now + Δ̄ ≥ cancel point), still ≥ L ahead of its start; until then a
 *   newer target replaces the transition (`cancelRun`: rings closed, SCHEDULED voices STOPped) and the outgoing plays
 *   on untouched. After it the newer target is queued (`after`) and planned from the incoming segment when this one lands.
 * - **Landing** at T: the incoming run becomes `player.run` with `anchorRun(run, run.startAt)` (P3), and the outgoing,
 *   while it still sounds (fade-out or tail), is kept as `player.next` so the instance counts its voices, pauses and
 *   stops it (P6's "run and next run") until it ends.
 *
 * **fadeZero.** The member flag is read at admission from `MusicGroupRequest.members` (`segmentRun.groupRequest`, P1's
 * file), which a plan can't reach, so R3a starts a fading-in member silent with a 0-second FADE to 0 stamped on its
 * start frame, in front of the fade-in (the core's pending queue is stable for equal frames, and Z2b's due list applies
 * a voice's records in frame order). Output is the same as `fadeZero`; see the R3a report for the one-line change that
 * would make it the PLAY flag.
 *
 * **R3b: bridges** (architecture §3.3). A change whose rule names a `bridge` runs as two *legs*, each one plan through
 * the planner (which holds one plan per player, so they are chained, never concurrent):
 * - **Leg 1, A → bridge:** the bridge segment (the `library` segment of the container whose table matched,
 *   `match.parent`) is planned on A's exit point exactly as a direct change would be (the rule's `exit`; a natural
 *   advance leaves at A's exit cue), entering at its own entry cue with its pre-entry, with the rule's `fadeOut` on A and
 *   `fadeIn` on the bridge (R1's leg `toBridge`). `Transition.bridge` is this plan.
 * - **Leg 2, bridge → B:** asked of the planner as soon as the bridge is stamped (sequential priming: the bridge's group
 *   is admitted first; a decoded bridge takes no ring), at the bridge's exit cue, entering B under the rule's `enter`,
 *   with `bridge.fadeOut` on the bridge and `bridge.fadeIn` on B (each defaulting to the rule's; R1's leg `fromBridge`).
 *   Unlike a direct exit at the exit cue, the bridge's fade-out is applied (the bridge's own fades are what the format
 *   gives a bridge for). `Transition.incoming` is this plan; until it is asked, null.
 * - **States:** `pending` (the bridge priming), `stamped` (the bridge stamped, B priming; still replaceable before the
 *   cancel point, which is leg 1's), `running` (A's fade stamped, until the bridge lands at T1), `bridging` (the bridge
 *   is `player.run`; `exitAt` is now T2, B's point on the bridge), `done` once B lands at T2.
 * - **Pool full keeps A.** At leg 1's cancel point (the last moment A can be kept) B must be admitted: when the pool
 *   can't hold B (a temporary refusal still waiting) or never can (a permanent one), the whole change is dropped, the
 *   bridge's group cancelled and A plays on untouched, with one warning (`options.onDropped("poolFull")`). The one
 *   exception is a **streamed bridge** that leaves room for B once A's rings return (pool ≥ bridge + B streamed stems,
 *   and the bridge long enough for A's fade-out, one STATUS and B's prime lead): A is committed and B is asked again
 *   when A's voices end (architecture §3.3). A bridge shorter than that is the "degrade": the change is refused as above.
 *   A refusal of the bridge itself is R3a's (a temporary one retries at A's next point, a permanent one drops; A plays on).
 * - **After the commit** B is never refused silently: if its plan is dropped (primed too late for the bridge's exit cue,
 *   or the deferred retry finds no room) it is asked again as soon as the lead allows, with the same fades, and the
 *   bridge plays until then.
 *
 * **Natural advances** (P4, `options.natural`) take the matched rule's `enter`, fades and bridge; R3b's reading: when no
 * rule was written (the always-present default rule, `match.rule` -1) a natural advance is a gapless cut (the incoming at
 * full level, the outgoing's tail ringing), not the default rule's 1-beat fade-in from silence on every item.
 *
 * **Target resolution** goes through P4's `enterPlaylist` for a playlist target (the item its order picks first; that
 * playlist becomes `player.playlist` once its leaf plays) and through the parameter for a `musicSwitch`.
 */
import type { FadeLaw, MusicGroupStamp, ShapedFade } from "../backend";
import type { MusicSwitchNode, SegmentNode } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid, exitSeconds, type SegmentGrid } from "../../../../engine/audio/musicGrid";
import type { MusicFrame, MusicNodeRef, MusicPlayer } from "./musicSystem";
import {
  cancelPlanned, frameIntervalSeconds, lookaheadSeconds, primeLeadSeconds, requestStart, type PlanGrid, type PlannedStart,
  type PlanReason, type PlanRequest,
} from "./planner";
import {
  enterFrame, enterPoint, exitTime, findRule, resolveFades, type FadeLeg, type GridAt, type PlayingGrid, type ResolvedFade,
  type RuleMatch,
} from "./transitionRules";
import { advanceAnchor, anchorRun, playingGridOf, predictWrap, ticksAt, type GridAnchor } from "./anchors";
import { cancelRun, segmentClipSource, type SegmentRun } from "./segmentRun";
import { enterPlaylist } from "./playlist";

/** Where a transition is. */
export type TransitionState = "pending" | "stamped" | "running" | "bridging" | "done" | "cancelled";

/** §3.2 `Transition`. R3a and R3b may add fields here. */
export interface Transition {
  /** Target node (the child the switch, playlist or seek asked for). */
  readonly to: MusicNodeRef;
  /** R3a: the matched rule (a queued transition's is matched from the incoming segment it will leave). */
  match: RuleMatch;
  /**
   * `pending`: planned, priming or waiting; `stamped`: the incoming group (with a bridge: the bridge's) is stamped,
   * still cancellable; `running`: past the cancel point (the outgoing fade is stamped) until it lands at T (with a
   * bridge: until the bridge lands); `bridging`: the bridge plays, until B lands; `done` once landed; `cancelled`.
   */
  state: TransitionState;
  /** Heard time (seconds) of the exit point T from the playing segment (while bridging: from the bridge); NaN until planned. */
  exitAt: number;
  /** Heard time (seconds) until which it can still be replaced (T - L). */
  cancelBy: number;
  /** The incoming start (B's; with a bridge, null until the bridge is stamped and B is asked for). */
  incoming: PlannedStart | null;
  /** R3b: the bridge's start (leg 1); null without a bridge. */
  bridge: PlannedStart | null;
  /** R3a: the run playing when it was planned (faded out, or its tail left ringing, at T). */
  outgoing: SegmentRun | null;
  /** R3a: a change asked for after the cancel point; planned from the incoming segment when this one lands. */
  after: Transition | null;
  /** R3a (H5): an immediate change (seek, reload): its start frame and crossfade; null for a rule's change. */
  readonly immediate: { readonly startFrame: number; readonly fadeSeconds: number } | null;
  /** R3a: a natural advance (a playlist item finished its plays): it leaves at the exit cue. */
  readonly natural: boolean;
  readonly reason: PlanReason;
  /** R3b: why it was dropped (`noPoint`, `refused`, `poolFull`, `noTrack`, ...); null while it lives or once landed. */
  cause: string | null;
}

/** Options of `requestTransition` (R3a). */
export interface TransitionOptions {
  /** A natural advance (P4): leave at the exit cue whatever the rule's `exit` (§2.4). */
  readonly natural?: boolean;
  /** Why (the planner's re-plan and refusal counters). Default `"transition"`. */
  readonly reason?: PlanReason;
  /**
   * R3b: called once when the change is dropped by a refusal or for want of a point (the music plays on), with the
   * cause (`noPoint`, `refused`, `poolFull`, `noTrack`, ...); not when a newer change replaces it or a stop drops it. May
   * be called before `requestTransition` returns (which then returns null).
   */
  readonly onDropped?: (cause: string) => void;
}

/** Float noise allowed when comparing heard seconds (far under one frame at 192 kHz). */
const EPS = 1e-7;
/** How far past a loop wrap a re-asked point starts (seconds; the mapping stays exact, this only picks the pass). */
const PAST_WRAP = 1e-6;
/** Loop passes a point search walks before it gives up (a forever loop never reaches a point past it). */
const MAX_PASSES = 1024;
/** Nested containers a target resolves through. */
const MAX_DEPTH = 16;
/** The clip rate when no stem has facts yet (as `anchors.ts`). */
const FALLBACK_RATE = 48_000;
/** Ê before a backend reports one, ms (the planner's seed). */
const PRIME_EMA_FALLBACK_MS = 40;

/**
 * One plan of a transition: the direct change (one leg), or A → bridge and bridge → B (two). `from` is the run the leg
 * leaves (A; for leg 2, the bridge's run once stamped).
 */
interface Leg {
  readonly index: 0 | 1;
  readonly target: MusicNodeRef;
  readonly grid: SegmentGrid;
  readonly rate: number;
  /** The match whose `enter` places the target (the bridge enters at its entry cue). */
  readonly enter: RuleMatch;
  readonly fadeLeg: FadeLeg;
  from: SegmentRun | null;
  request: PlanRequest | null;
  planned: PlannedStart | null;
  stamped: boolean;
  committed: boolean;
  landed: boolean;
  /** Leg 2 of a streamed bridge: B is asked again when A's voices end (its rings return). */
  deferred: boolean;
  /** Leg 2 refused for good after the commit: the bridge lands and the change ends there. */
  failed: boolean;
}

/** What a plan needs again at the stamp and the commit (one per planned transition). */
interface PlanContext {
  readonly legs: Leg[];
  readonly onDropped: ((cause: string) => void) | null;
  /** The last frame the transition saw (planner callbacks carry none). */
  frame: MusicFrame;
}

const contexts = new WeakMap<Transition, PlanContext>();
/** Outgoing runs left as `player.next` after a landing, until their voices end. */
const ringing = new WeakSet<SegmentRun>();
/** Outgoing fades waiting for a backend without stamped fades (`fadeShaped`): applied at their start. */
const unstamped = new WeakMap<Leg, { at: number; seconds: number }>();

// --- Small readers ---------------------------------------------------------------------------------------------------

const grids = new WeakMap<object, SegmentGrid | null>();

/** A segment's compiled grid (G1), cached per node object (the clip's length, when known, resolves an `"end"` exit). */
function gridOf(node: MusicNodeRef): SegmentGrid | null {
  const cached = grids.get(node);
  if (cached) return cached;
  const seg = node as Partial<SegmentNode>;
  if (node.type !== "segment" || !Array.isArray(seg.tempo)) return null;
  const clip = seg.tracks?.find((t) => t.clip)?.clip;
  const facts = clip ? segmentClipSource().facts(clip) : undefined;
  const grid = compileSegmentGrid({ ...seg, cues: seg.cues ?? [] } as SegmentNode, facts && facts.rate > 0 ? { endSeconds: facts.frames / facts.rate } : {});
  if (facts) grids.set(node, grid); // recompiled until the facts arrive
  return grid;
}

/** The clip rate (Hz) of a segment's file frames: its first stem's facts, else 48 kHz (as `anchors.ts`). */
function rateOf(node: MusicNodeRef): number {
  for (const t of (node as Partial<SegmentNode>).tracks ?? []) {
    const f = t.clip ? segmentClipSource().facts(t.clip) : undefined;
    if (f && f.rate > 0) return f.rate;
  }
  return FALLBACK_RATE;
}

/** Seconds of a segment's file (its first stem with facts), NaN when unknown. */
function fileSecondsOf(node: MusicNodeRef): number {
  for (const t of (node as Partial<SegmentNode>).tracks ?? []) {
    const f = t.clip ? segmentClipSource().facts(t.clip) : undefined;
    if (f && f.rate > 0) return f.frames / f.rate;
  }
  return Number.NaN;
}

/**
 * The segment a target starts: itself; for a `musicSwitch`, the child its parameter picks (else its default, else the
 * first); for a `playlist`, the first item its order picks (P4's `enterPlaylist`). Null when none is a segment.
 */
function resolveSegment(player: MusicPlayer, node: MusicNodeRef, depth = 0): MusicNodeRef | null {
  if (node.type === "segment") return node;
  if (depth >= MAX_DEPTH) return null;
  if (node.type === "playlist") return enterPlaylist(player, node);
  const children = (node as { children?: MusicNodeRef[] }).children;
  if (!Array.isArray(children) || children.length === 0) return null;
  let child: MusicNodeRef | undefined = children[0];
  if (node.type === "musicSwitch") {
    const sw = node as MusicSwitchNode;
    const value = player.instance.getParameter?.(sw.parameter);
    const byValue = (v: unknown): MusicNodeRef | undefined => (v === undefined ? undefined : sw.children.find((c) => c.value === String(v)));
    child = byValue(value) ?? byValue(sw.default) ?? child;
  }
  return child ? resolveSegment(player, child, depth + 1) : null;
}

/** The container with id `id` in the music tree under `node` (children only), or null. */
function containerById(node: MusicNodeRef, id: string, depth = 0): MusicNodeRef | null {
  if (node.id === id) return node;
  if (depth >= MAX_DEPTH) return null;
  for (const c of (node as { children?: MusicNodeRef[] }).children ?? []) {
    const found = containerById(c, id, depth + 1);
    if (found) return found;
  }
  return null;
}

/** R3b: the bridge segment a match names, from the `library` of the container whose table matched; null for none. */
function bridgeOf(player: MusicPlayer, match: RuleMatch): MusicNodeRef | null {
  if (!match.bridge || !match.parent) return null;
  const container = containerById(player.root, match.parent);
  const library = (container as { library?: MusicNodeRef[] } | null)?.library ?? [];
  return library.find((s) => s.id === match.bridge && s.type === "segment") ?? null;
}

/** The playing run's anchor (the player's when it is that run's, else one from the run's stamp). */
function anchorOf(player: MusicPlayer): GridAnchor | null {
  const run = player.run;
  if (!run) return null;
  const a = player.anchor;
  if (a && a.segment === run.node.id) return a;
  return Number.isFinite(run.startAt) ? anchorRun(run, run.startAt) : null;
}

/** The anchor of `run` while it plays (the player's, when `run` is the playing one). */
function anchorFor(player: MusicPlayer, run: SegmentRun): GridAnchor | null {
  if (player.run === run) return anchorOf(player);
  return Number.isFinite(run.startAt) ? anchorRun(run, run.startAt) : null;
}

/** The anchor's mapping for the pass after the wrap heard at `wrap`. */
function passAfter(anchor: GridAnchor, base: PlayingGrid, wrap: number): PlayingGrid {
  const t = wrap + PAST_WRAP;
  return { grid: base.grid, anchorTicks: ticksAt(anchor, t), anchorTime: t };
}

/**
 * The exit point of `match` at or after heard `notBefore` on the playing segment (R1's `exitTime`), over its loop
 * passes: a point the linear mapping puts after the playing region's next wrap is asked again in the next pass. NaN
 * when there is none (past the exit cue, or a region looping forever before it).
 */
function pointOf(player: MusicPlayer, anchor: GridAnchor, match: RuleMatch, notBefore: number, natural: boolean): number {
  const base = playingGridOf(anchor);
  if (!base) return Number.NaN;
  let pg = base;
  let cursor = anchor.time;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const wrap = predictWrap(player, cursor);
    if (Number.isFinite(wrap) && wrap <= notBefore + EPS) {
      pg = passAfter(anchor, base, wrap); // `notBefore` is in a later pass than the mapping's
      cursor = wrap + PAST_WRAP;
      continue;
    }
    const p = exitTime(match, pg, notBefore, natural);
    if (!Number.isFinite(wrap) || !(p > wrap + EPS)) return p;
    pg = passAfter(anchor, base, wrap);
    cursor = wrap + PAST_WRAP;
  }
  return Number.NaN;
}

/** The position of a segment anchored at `anchor` at heard `t` (loop passes unrolled), as R1's `GridAt`. */
function outAt(anchor: GridAnchor, t: number): GridAt | null {
  const pg = playingGridOf(anchor);
  return pg ? { grid: pg.grid, ticks: ticksAt(anchor, t) } : null;
}

/** A cut both ways (a natural advance under the default rule). */
const NO_FADES: { out: ResolvedFade; in: ResolvedFade } = {
  out: { seconds: 0, offset: 0, curve: "linear" },
  in: { seconds: 0, offset: 0, curve: "linear" },
};

const lawIn = (c:ResolvedFade["curve"]): FadeLaw => (c === "equalPower" ? "equalPowerIn" : c);
const lawOut = (c: ResolvedFade["curve"]): FadeLaw => (c === "equalPower" ? "equalPowerOut" : c);

function contextOf(t: Transition): PlanContext | null {
  return contexts.get(t) ?? null;
}

/** The leg the transition is at: the first that hasn't landed. */
function currentLeg(ctx: PlanContext): Leg {
  return ctx.legs.find((l) => !l.landed) ?? ctx.legs[ctx.legs.length - 1]!;
}

const lastLeg = (ctx: PlanContext): Leg => ctx.legs[ctx.legs.length - 1]!;

/** The leg's two fades at T (seconds relative to T), or the immediate crossfade. Null without a grid. */
function fadesAt(player: MusicPlayer, t: Transition, leg: Leg, T: number): { out: ResolvedFade; in: ResolvedFade } | null {
  if (t.immediate) {
    const x: ResolvedFade = { seconds: Math.max(0, t.immediate.fadeSeconds), offset: 0, curve: "equalPower" };
    return { out: x, in: x };
  }
  if (t.natural && leg.index === 0 && t.match.rule < 0) return NO_FADES; // a playlist's own sequence: gapless (R3b reading)
  const anchor = leg.from ? anchorFor(player, leg.from) : null;
  const out = anchor ? outAt(anchor, T) : null;
  if (!out) return null;
  const into = enterPoint(leg.enter, leg.grid, out);
  return resolveFades(t.match, out, { grid: leg.grid, ticks: into.ticksAtExit }, leg.fadeLeg);
}

/** True when leg 1 leaves A at its exit cue (in its pass): A's tail rings on, unfaded. A bridge's exit is faded (R3b). */
function ringsOn(player: MusicPlayer, t: Transition, leg: Leg, T: number): boolean {
  if (t.immediate || leg.index !== 0 || !leg.from) return false;
  const anchor = anchorFor(player, leg.from);
  if (!anchor) return false;
  const cue = pointOf(player, anchor, t.match, T, true);
  return Number.isFinite(cue) && Math.abs(cue - T) <= 1e-6;
}

/** Heard time the leg's outgoing fade starts at for exit T (+Infinity: no fade, the tail rings on). */
function outStart(player: MusicPlayer, t: Transition, leg: Leg, T: number): number {
  if (ringsOn(player, t, leg, T)) return Number.POSITIVE_INFINITY;
  const fades = fadesAt(player, t, leg, T);
  return fades ? T + fades.out.offset : T;
}

/** The leg's cancel point: min(group start, outgoing fade start) - L. */
function legCancelBy(player: MusicPlayer, t: Transition, leg: Leg, f: MusicFrame): number {
  const p = leg.planned;
  if (!p || !Number.isFinite(p.point)) return Number.NaN;
  return Math.min(p.at, outStart(player, t, leg, p.point)) - lookaheadSeconds(f);
}

/** A shaped fade starting at `start` over `seconds`, moved to `earliest` with the phase it has there (null: over by then). */
function clampFade(start: number, seconds: number, earliest: number): { at: number; seconds: number; startPhase: number } | null {
  if (start >= earliest - EPS) return { at: start, seconds, startPhase: 0 };
  const late = earliest - start;
  if (!(seconds > late + EPS)) return null;
  return { at: earliest, seconds: seconds - late, startPhase: late / seconds };
}

function streamedCount(run: SegmentRun | null): number {
  if (!run) return 0;
  let n = 0;
  for (const s of run.stems) if (s.streamed) n++;
  return n;
}

/** True while any of the run's voices still sounds. */
function sounding(run: SegmentRun): boolean {
  if (run.state === "cancelled" || run.state === "new") return false;
  for (const s of run.stems) if (s.voice && (s.voice.alive ?? s.voice.playing)) return true;
  return false;
}

const warned = new WeakMap<MusicPlayer, Set<string>>();

/** One warning per cause per instance (§1.6). */
function warnOnce(player: MusicPlayer, cause: string, message: string): void {
  let set = warned.get(player);
  if (!set) warned.set(player, (set = new Set()));
  if (set.has(cause)) return;
  set.add(cause);
  console.warn(`[myco] Music "${player.instance.path}": ${message}`);
}

// --- Planning --------------------------------------------------------------------------------------------------------

/** The planner's kind for a rule's exit (its re-plans and warnings): the points themselves come from `pointOf`. */
function planGrid(t: Transition): PlanGrid {
  if (t.natural) return "exitCue";
  const exit = t.match.transition.exit;
  if (exit === "immediate" || exit === "nextCue" || exit === "exitCue") return exit;
  return "grid";
}

function isOpen(t: Transition | null): t is Transition {
  return t !== null && t.state !== "done" && t.state !== "cancelled";
}

function newTransition(to: MusicNodeRef, match: RuleMatch, immediate: Transition["immediate"], natural: boolean, reason: PlanReason): Transition {
  return {
    to, match, state: "pending", exitAt: Number.NaN, cancelBy: Number.NaN, incoming: null, bridge: null, outgoing: null,
    after: null, immediate, natural, reason, cause: null,
  };
}

/** The player is playing (or committed) a segment a change can leave. */
function canLeave(player: MusicPlayer): boolean {
  if (player.state === "stopping" || player.state === "stopped" || player.state === "refused") return false;
  const run = player.run;
  return run !== null && run.state !== "cancelled" && run.state !== "new" && anchorOf(player) !== null;
}

function newLeg(index: 0 | 1, target: MusicNodeRef, grid: SegmentGrid, enter: RuleMatch, fadeLeg: FadeLeg, from: SegmentRun | null): Leg {
  return {
    index, target, grid, rate: rateOf(target), enter, fadeLeg, from, request: null, planned: null, stamped: false,
    committed: false, landed: false, deferred: false, failed: false,
  };
}

/** The bridge enters at its own entry cue (with its pre-entry); the rule's `enter` places B. */
function entryCueMatch(match: RuleMatch): RuleMatch {
  return { ...match, enter: "entryCue", transition: { ...match.transition, enter: "entryCue" } };
}

/**
 * Plan `t` from the playing segment through the planner (`requestStart`): its first leg (the target, or the bridge).
 * True while it lives (priming, waiting for a temporary refusal's retry, or stamped); false when it was refused or has
 * no point (the music plays on).
 */
function plan(player: MusicPlayer, t: Transition, f: MusicFrame, onDropped: ((cause: string) => void) | null): boolean {
  if (!canLeave(player)) return false;
  advanceAnchor(player, f.now);
  const target = resolveSegment(player, t.to);
  const grid = target ? gridOf(target) : null;
  if (!target || !grid) {
    player.counters.refusals.noTrack = (player.counters.refusals.noTrack ?? 0) + 1;
    t.cause = "noTrack";
    onDropped?.("noTrack");
    return false;
  }
  t.outgoing = player.run;
  const legs: Leg[] = [];
  const bridge = t.immediate ? null : bridgeOf(player, t.match);
  const bridgeGrid = bridge ? gridOf(bridge) : null;
  if (bridge && bridgeGrid) {
    legs.push(newLeg(0, bridge, bridgeGrid, entryCueMatch(t.match), "toBridge", player.run));
    legs.push(newLeg(1, target, grid, t.match, "fromBridge", null));
  } else {
    legs.push(newLeg(0, target, grid, t.match, "direct", player.run));
  }
  contexts.set(t, { legs, onDropped, frame: f });
  t.state = "pending";
  player.transition = t;
  const leg = legs[0]!;
  const request = legRequest(player, t, leg, f, false);
  leg.request = request;
  requestStart(player, request, f);
  const p = player.planned;
  if (!p || p.request !== request || (t.state as TransitionState) === "cancelled") return false;
  leg.planned = p;
  if (legs.length === 2) t.bridge = p;
  else t.incoming = p;
  refresh(player, t, f);
  if (player.state === "playing" || player.state === "committed") player.state = "pending";
  return true;
}

/**
 * The planner request of a leg. Leg 1 leaves the playing segment on the rule's exit points; leg 2 leaves the bridge at
 * its exit cue. `asap`: as soon as the lead allows (leg 2's fallback after a drop).
 */
function legRequest(player: MusicPlayer, t: Transition, leg: Leg, f: MusicFrame, asap: boolean): PlanRequest {
  const onStamped = (p: PlannedStart, fr: MusicFrame): void => stamped(player, t, leg, p, fr);
  const onDropped = (_p: PlannedStart, cause: string): void => dropped(player, t, leg, cause);
  const fades = (p: PlannedStart): MusicGroupStamp["fades"] => incomingFades(player, t, leg, p);
  if (t.immediate) {
    return {
      to: leg.target, reason: t.reason, grid: "immediate", notBefore: Number.NaN, startFrame: Math.max(0, Math.round(t.immediate.startFrame)),
      preEntry: 0, fades, onStamped, onDropped,
    };
  }
  const anchor = leg.index === 0 ? anchorOf(player) : leg.from ? anchorFor(player, leg.from) : null;
  const now = anchor ? outAt(anchor, f.now) : null;
  const startFrameAt = (T: number): number => {
    const out = anchor ? outAt(anchor, T) : null;
    return out ? enterFrame(leg.enter, leg.grid, out, leg.rate) : 0;
  };
  const enter0 = now ? enterPoint(leg.enter, leg.grid, now) : null;
  const fades0 = fadesAt(player, t, leg, f.now);
  const base = {
    to: leg.target, reason: t.reason, notBefore: Number.NaN,
    startFrame: now ? enterFrame(leg.enter, leg.grid, now, leg.rate) : 0,
    preEntry: enter0?.preEntry ?? 0,
    fadeLead: fades0 ? Math.max(0, -fades0.out.offset) : 0,
    fades, onStamped, onDropped,
  };
  if (asap) return { ...base, grid: "immediate" };
  if (leg.index === 0) {
    return { ...base, grid: planGrid(t), points: (nb) => pointOf(player, anchor!, t.match, nb, t.natural), startFrameAt };
  }
  // Leg 2: the bridge's exit cue (a bridge's loop regions aren't unrolled: it isn't the playing run when this is asked).
  const points = (nb: number): number => {
    const pg = anchor ? playingGridOf(anchor) : null;
    return pg ? exitTime(t.match, pg, nb, true) : Number.NaN;
  };
  return { ...base, grid: "exitCue", points, startFrameAt };
}

/** The incoming members' first fades (the planner asks just before the stamp): silent from the start, then the fade-in. */
function incomingFades(player: MusicPlayer, t: Transition, leg: Leg, p: PlannedStart): MusicGroupStamp["fades"] {
  const T = p.point;
  const fades = fadesAt(player, t, leg, T);
  if (!fades) return undefined;
  const fin = fades.in;
  const start = T + fin.offset;
  if (!(fin.seconds > 0) && start <= p.at + EPS) return undefined; // a cut: full level from the first sample
  const silent: ShapedFade = { to: 0, seconds: 0, law: "linear", at: p.at };
  const open = fin.seconds > 0 ? clampFade(start, fin.seconds, p.at) : { at: start, seconds: 0, startPhase: 0 };
  if (!open) return undefined; // the fade-in is over before the group starts: full level
  const rise: ShapedFade = open.startPhase > 0
    ? { to: 1, seconds: open.seconds, law: lawIn(fin.curve), at: open.at, startPhase: open.startPhase }
    : { to: 1, seconds: open.seconds, law: lawIn(fin.curve), at: open.at };
  const out: NonNullable<MusicGroupStamp["fades"]> = [];
  for (let member = 0; member < p.run.stems.length; member++) {
    out.push({ member, fade: silent }, { member, fade: rise });
  }
  return out;
}

/** T and the cancel point from the plans as they stand (a re-plan moves both). */
function refresh(player: MusicPlayer, t: Transition, f: MusicFrame): void {
  const ctx = contextOf(t);
  if (!ctx) return;
  const leg = currentLeg(ctx);
  const p = leg.planned;
  if (leg.index === 1) {
    t.exitAt = p && Number.isFinite(p.point) ? p.point : Number.NaN;
    return; // the change is committed: the cancel point is leg 1's, passed
  }
  if (!p) return;
  t.exitAt = p.point;
  t.cancelBy = legCancelBy(player, t, leg, f);
}

/** The planner stamped a leg's group (same frame, same batch). */
function stamped(player: MusicPlayer, t: Transition, leg: Leg, p: PlannedStart, f: MusicFrame): void {
  const ctx = contextOf(t);
  if (!ctx || player.transition !== t || !isOpen(t)) return;
  ctx.frame = f;
  leg.planned = p;
  leg.stamped = true;
  if (leg.index === 1) {
    t.incoming = p;
    refresh(player, t, f);
    if (ctx.legs[0]!.committed && f.now + frameIntervalSeconds(f) >= legCancelBy(player, t, leg, f) - EPS) commit(player, t, leg, f);
    return;
  }
  if (t.state !== "pending") return;
  if (ctx.legs.length === 2) t.bridge = p;
  else t.incoming = p;
  t.state = "stamped";
  if (player.state === "pending" || player.state === "playing") player.state = "transitioning";
  if (ctx.legs.length === 2) {
    askLeg2(player, t, ctx, f);
    if (!isOpen(t)) return; // B was refused for good: the change is dropped, A plays on
  }
  refresh(player, t, f);
  if (f.now + frameIntervalSeconds(f) >= t.cancelBy - EPS) commit(player, t, ctx.legs[0]!, f);
}

/** R3b: ask the planner for B, leaving the stamped bridge at its exit cue (or as soon as the lead allows: `asap`). */
function askLeg2(player: MusicPlayer, t: Transition, ctx: PlanContext, f: MusicFrame, asap = false): void {
  const leg = ctx.legs[1]!;
  leg.from = ctx.legs[0]!.planned!.run;
  leg.planned = null;
  leg.deferred = false;
  const request = legRequest(player, t, leg, f, asap);
  leg.request = request;
  requestStart(player, request, f);
  const p = player.planned;
  if (p && p.request === request && leg.request === request) {
    leg.planned = p;
    t.incoming = p;
  }
}

/** The planner dropped a leg's plan (refused, no point left): the music plays on. */
function dropped(player: MusicPlayer, t: Transition, leg: Leg, cause: string): void {
  const ctx = contextOf(t);
  if (!ctx || !isOpen(t) || leg.request === null) return;
  if (leg.index === 1) {
    if (!ctx.legs[0]!.committed) {
      // Before A's fade is stamped: drop the whole change, A plays on (pool full keeps A).
      if (cause === "refused") warnOnce(player, "bridgeRefused", `no music rings for "${leg.target.id}" after the bridge "${ctx.legs[0]!.target.id}"; the change is dropped and "${t.outgoing?.node.id ?? "?"}" plays on.`);
      abandon(player, t, ctx.frame, cause);
      return;
    }
    leg.planned = null;
    t.incoming = null;
    if (cause !== "noPoint" || leg.request.grid === "immediate") {
      // Refused for good after the commit (or no track): the bridge lands and the change ends there.
      leg.failed = true;
      warnOnce(player, "bridgeRefused", `"${leg.target.id}" can't start after the bridge "${ctx.legs[0]!.target.id}" (${cause}); the bridge plays on.`);
      return;
    }
    // Primed too late for the bridge's exit cue, or no room yet: B as soon as the lead allows, the bridge plays on.
    warnOnce(player, "bridgeLate", `"${leg.target.id}" wasn't ready at the end of the bridge "${ctx.legs[0]!.target.id}"; it starts as soon as it can.`);
    askLeg2(player, t, ctx, ctx.frame, true);
    return;
  }
  t.state = "cancelled";
  t.cause = cause;
  if (player.transition === t) {
    player.transition = null;
    if (player.state === "pending" || player.state === "transitioning") player.state = "playing";
  }
  ctx.onDropped?.(cause);
}

/**
 * R3b: at leg 1's cancel point B must be admitted (pool full keeps A), unless the bridge is streamed and leaves room
 * for B once A's rings return. True when the change may commit.
 */
function leg2Ready(player: MusicPlayer, t: Transition, ctx: PlanContext, f: MusicFrame): boolean {
  if (ctx.legs.length < 2) return true;
  const leg = ctx.legs[1]!;
  const p = leg.planned;
  if (leg.stamped || (p && player.planned === p && p.status === "priming")) return true;
  if (p && player.planned === p && p.status === "waiting" && deferrable(player, t, ctx, p, f)) {
    leg.deferred = true;
    return true;
  }
  return false;
}

/**
 * A streamed bridge: B fits once A's rings return (pool ≥ bridge + B streamed stems) and the bridge is long enough for
 * A's fade-out (or tail), one STATUS and B's prime lead before B's start.
 */
function deferrable(player: MusicPlayer, t: Transition, ctx: PlanContext, p: PlannedStart, f: MusicFrame): boolean {
  const pool = f.music?.ringPool;
  const out = t.outgoing;
  const bridge = ctx.legs[0]!.planned?.run ?? null;
  if (!out || !bridge || pool === undefined || !(pool > 0) || streamedCount(out) === 0 || streamedCount(bridge) === 0) return false;
  if (streamedCount(bridge) + streamedCount(p.run) > pool) return false;
  const leg = ctx.legs[0]!;
  const T = leg.planned!.point;
  let freed: number;
  if (ringsOn(player, t, leg, T)) {
    const g = gridOf(out.node);
    const exit = g ? exitSeconds(g) : null;
    const file = fileSecondsOf(out.node);
    freed = exit !== null && Number.isFinite(file) ? T + Math.max(0, file - exit) : Number.NaN;
  } else {
    const fades = fadesAt(player, t, leg, T);
    freed = fades ? T + fades.out.offset + Math.max(0, fades.out.seconds) : T;
  }
  const status = frameIntervalSeconds(f);
  const lead = primeLeadSeconds(f.music?.primeEmaMs ?? PRIME_EMA_FALLBACK_MS, lookaheadSeconds(f), status, true);
  return Number.isFinite(freed) && freed + status + lead <= p.at + EPS;
}

/** Past the leg's cancel point: stamp its outgoing fade (or leave the tail ringing). */
function commit(player: MusicPlayer, t: Transition, leg: Leg, f: MusicFrame): void {
  const ctx = contextOf(t);
  if (!ctx || leg.committed) return;
  if (leg.index === 0 && !leg2Ready(player, t, ctx, f)) {
    warnOnce(player, "bridgePoolFull", `no music rings for "${ctx.legs[1]!.target.id}" after the bridge "${leg.target.id}" (pool full); the change is dropped and "${t.outgoing?.node.id ?? "?"}" plays on.`);
    abandon(player, t, f, "poolFull");
    return;
  }
  leg.committed = true;
  if (leg.index === 0) t.state = "running";
  const out = leg.from;
  const p = leg.planned;
  if (!out || !p || out.state === "cancelled") return;
  const T = p.point;
  if (ringsOn(player, t, leg, T)) return; // the post-exit tail rings on, ramp-free
  const fades = fadesAt(player, t, leg, T);
  const fo = fades?.out ?? { seconds: 0, offset: 0, curve: "linear" as const };
  const horizon = f.now + lookaheadSeconds(f);
  const shaped = clampFade(T + fo.offset, Math.max(0, fo.seconds), horizon) ?? { at: horizon, seconds: 0, startPhase: 0 };
  const law = lawOut(fo.curve);
  for (const s of out.stems) {
    const v = s.voice;
    if (!v) continue;
    if (v.fadeShaped) {
      const fade: ShapedFade = { to: 0, seconds: shaped.seconds, law, at: shaped.at, stopAtEnd: true };
      if (shaped.startPhase > 0) fade.startPhase = shaped.startPhase;
      v.fadeShaped(fade);
    } else {
      unstamped.set(leg, { at: shaped.at, seconds: shaped.seconds });
    }
  }
}

/** A backend without stamped fades: the leg's outgoing fade starts at the first frame at or after its time. */
function applyUnstamped(leg: Leg, f: MusicFrame): void {
  const u = unstamped.get(leg);
  if (!u || f.now + EPS < u.at) return;
  unstamped.delete(leg);
  for (const s of leg.from?.stems ?? []) s.voice?.stop(u.seconds);
}

/** At a leg's T: its run plays, the run it leaves rings out as `player.next`; after the last leg, a queued change is planned. */
function land(player: MusicPlayer, t: Transition, leg: Leg, f: MusicFrame): void {
  const ctx = contextOf(t)!;
  leg.landed = true;
  const inc = leg.planned?.run;
  if (inc) {
    const out = leg.from;
    player.run = inc;
    player.anchor = anchorRun(inc, inc.startAt);
    player.regions = null; // the new segment's regions start fresh (R4b)
    if (player.next === inc) player.next = null;
    if (out && out !== inc && sounding(out) && (player.next === null || (ringing.has(player.next) && !sounding(player.next)))) {
      player.next = out;
      ringing.add(out);
    }
  }
  if (leg !== lastLeg(ctx) && !ctx.legs[1]!.failed) {
    t.state = "bridging";
    if (player.state === "pending" || player.state === "playing" || player.state === "committed") player.state = "transitioning";
    refresh(player, t, f);
    return;
  }
  t.state = "done";
  if (player.transition === t) player.transition = null;
  if (player.state === "pending" || player.state === "transitioning" || player.state === "committed") player.state = "playing";
  const after = t.after;
  t.after = null;
  if (after && isOpen(after)) {
    after.match = findRule(player.root, player.run?.node.id ?? "", after.to.id);
    const actx = contextOf(after);
    if (!plan(player, after, f, actx?.onDropped ?? queuedDrops.get(after) ?? null)) {
      after.state = "cancelled";
      if (player.transition === after) player.transition = null;
    }
  }
}

/** A queued change's `onDropped` until it is planned. */
const queuedDrops = new WeakMap<Transition, (cause: string) => void>();

/**
 * Drop an uncommitted transition: each leg's plan is cancelled, or its stamped group's rings close and voices STOP.
 * `cause` (a refusal) is reported through `onDropped`; none for a replacement or a cancel.
 */
function abandon(player: MusicPlayer, t: Transition, f: MusicFrame, cause: string | null = null): void {
  const ctx = contextOf(t);
  for (const leg of ctx?.legs ?? []) {
    const p = leg.planned;
    leg.request = null; // late planner callbacks for it are ignored
    if (!p || leg.landed) continue;
    if (player.planned === p) cancelPlanned(player, f);
    else if (leg.stamped) {
      cancelRun(p.run, f);
      if (player.next === p.run) player.next = null;
    }
    unstamped.delete(leg);
  }
  t.state = "cancelled";
  t.cause = cause;
  if (player.transition === t) player.transition = null;
  if (player.state === "pending" || player.state === "transitioning") player.state = "playing";
  if (cause) ctx?.onDropped?.(cause);
}

/** Before its cancel point (and not yet committed). */
function replaceable(t: Transition, f: MusicFrame): boolean {
  if (t.state === "pending") return true;
  return t.state === "stamped" && f.now < t.cancelBy - EPS;
}

/** Queue `t` behind the committed `cur`: the latest asked wins. */
function queueAfter(player: MusicPlayer, cur: Transition, t: Transition): Transition {
  if (cur.after) cur.after.state = "cancelled";
  cur.after = t;
  const ctx = contextOf(cur);
  const from = ctx ? lastLeg(ctx).target.id : cur.incoming?.run.node.id ?? player.run?.node.id ?? "";
  t.match = findRule(player.root, from, t.to.id);
  return t;
}

// --- The API ---------------------------------------------------------------------------------------------------------

/**
 * R3a: ask for a change to `to` under its rule (switch, playlist, stinger-free change). Replaces a pending one before its
 * cancel point; after it, queues behind it. Returns the transition, or null when refused (the music plays on).
 *
 * `to` may be a container (a switch child that is a playlist or a switch): it starts the segment that container picks
 * (a playlist through P4's `enterPlaylist`); the rule is matched for `to` itself. The same target as the open
 * transition returns it unchanged. `options.natural` (P4's natural advance) leaves at the exit cue. A temporary
 * refusal still returns the transition: the planner retries it at each allowed point. A rule with a `bridge` plays
 * A → bridge → B (R3b, see the file header).
 */
export function requestTransition(player: MusicPlayer, to: MusicNodeRef, f: MusicFrame, options: TransitionOptions = {}): Transition | null {
  if (!canLeave(player)) return null;
  const natural = options.natural === true;
  const reason = options.reason ?? "transition";
  const onDropped = options.onDropped ?? null;
  const cur = player.transition;
  if (isOpen(cur)) {
    if (cur.to.id === to.id && !cur.immediate && cur.natural === natural) {
      if (cur.after) cur.after.state = "cancelled";
      cur.after = null;
      return cur;
    }
    if (!replaceable(cur, f)) {
      if (cur.after && isOpen(cur.after) && cur.after.to.id === to.id && !cur.after.immediate) return cur.after;
      const q = queueAfter(player, cur, newTransition(to, cur.match, null, natural, reason));
      if (onDropped) queuedDrops.set(q, onDropped);
      return q;
    }
    abandon(player, cur, f);
  }
  const t = newTransition(to, findRule(player.root, player.run!.node.id, to.id), null, natural, reason);
  if (plan(player, t, f, onDropped)) return t;
  t.state = "cancelled";
  if (player.transition === t) player.transition = null;
  return null;
}

/**
 * R3a (H5): an immediate transition into `to` at file frame `startFrame` with a `fadeMs` crossfade, stamped at now plus
 * the lead (R7's seek, P8's reload). Null when refused; the reason is on the player's counters.
 *
 * Equal-power crossfade (both sides start at T = now + lead); `fadeMs` 0 is a cut. A pending change is replaced before
 * its cancel point; after it, this is queued and planned (from now + lead then) when that change lands, in the incoming
 * segment. `startFrame` is in `to`'s clip frames, pre-entry included (no extra pre-entry is added). Never bridged.
 */
export function planImmediate(player: MusicPlayer, to: MusicNodeRef, startFrame: number, fadeMs: number, f: MusicFrame): Transition | null {
  if (!canLeave(player)) return null;
  const immediate = { startFrame: Math.max(0, startFrame), fadeSeconds: Math.max(0, fadeMs) / 1000 };
  const reason: PlanReason = "seek";
  const cur = player.transition;
  if (isOpen(cur)) {
    if (!replaceable(cur, f)) return queueAfter(player, cur, newTransition(to, cur.match, immediate, false, reason));
    abandon(player, cur, f);
  }
  const t = newTransition(to, findRule(player.root, player.run!.node.id, to.id), immediate, false, reason);
  if (plan(player, t, f, null)) return t;
  t.state = "cancelled";
  if (player.transition === t) player.transition = null;
  return null;
}

/**
 * R3a: cancel the pending transition (before its cancel point): its group's rings close and its voices STOP. After the
 * cancel point the change is committed and this only drops a change queued behind it (R2: the switch asks for the old
 * child again once it lands).
 */
export function cancelTransition(player: MusicPlayer, f: MusicFrame): void {
  const t = player.transition;
  if (!isOpen(t)) return;
  if (replaceable(t, f)) {
    abandon(player, t, f);
    return;
  }
  if (t.after) t.after.state = "cancelled";
  t.after = null;
}

/** R3b: true while `player.next` is only an outgoing run ringing out after a landing (no change is in flight). */
export function ringingOut(player: MusicPlayer): boolean {
  return player.next !== null && ringing.has(player.next);
}

/** A stop drops what isn't committed; a committed change's legs that haven't started are cancelled, the rest is the stop's. */
function stopTransition(player: MusicPlayer, t: Transition, f: MusicFrame): void {
  if (replaceable(t, f) || t.state === "stamped") {
    abandon(player, t, f);
    return;
  }
  const ctx = contextOf(t);
  for (const leg of ctx?.legs ?? []) {
    const p = leg.planned;
    leg.request = null;
    if (!p || leg.landed) continue;
    if (player.planned === p) cancelPlanned(player, f);
    else if (leg.stamped && p.run !== player.run && p.run !== player.next) cancelRun(p.run, f); // the stop fades run and next
  }
  t.state = "cancelled";
  player.transition = null;
}

/** R3a, R3b, step 9: stamp the incoming group when primed, fade the outgoing, chain the bridge, end the outgoing run. */
export function tickTransition(player: MusicPlayer, f: MusicFrame): void {
  // An outgoing left ringing as `player.next` leaves once its voices end.
  const next = player.next;
  if (next && ringing.has(next) && !sounding(next)) {
    ringing.delete(next);
    player.next = null;
  }
  const t = player.transition;
  if (!t) return;
  if (!isOpen(t)) {
    player.transition = null;
    return;
  }
  const ctx = contextOf(t);
  if (!ctx) return;
  ctx.frame = f;
  if (player.state === "stopping" || player.state === "stopped") {
    // `handle.stop` fades the run and the next run (P1's `stopPlayerRuns`); an uncommitted change is dropped.
    stopTransition(player, t, f);
    return;
  }
  const first = ctx.legs[0]!;
  if (t.state === "pending") {
    // Another start replaced the plan (the planner holds one per player): the change is gone.
    if (first.planned && player.planned !== first.planned) return abandon(player, t, f);
    refresh(player, t, f);
    return;
  }
  if (t.state === "stamped") {
    const second = ctx.legs[1];
    // B's plan replaced by another start before the commit: the change is gone, A plays on.
    if (second && !second.stamped && second.planned && player.planned !== second.planned) return abandon(player, t, f);
    refresh(player, t, f);
    if (f.now + frameIntervalSeconds(f) >= t.cancelBy - EPS) commit(player, t, first, f);
  }
  if (t.state !== "running" && t.state !== "bridging") return;
  for (const leg of ctx.legs) applyUnstamped(leg, f);
  const second = ctx.legs[1];
  if (second && !second.failed && !second.stamped) {
    if (second.deferred) {
      // A streamed bridge: B is asked again once A's voices end (its rings are back).
      if (!t.outgoing || !sounding(t.outgoing)) askLeg2(player, t, ctx, f);
    } else if (!second.planned || player.planned !== second.planned) {
      // B's plan is gone (replaced by another start): ask again as soon as the lead allows.
      askLeg2(player, t, ctx, f, true);
    }
  }
  if (!first.landed && f.now + EPS >= first.planned!.point) land(player, t, first, f);
  if (!second || !isOpen(t)) return;
  if (second.failed) {
    if (first.landed && isOpen(t)) land(player, t, second, f);
    return;
  }
  if (second.stamped && !second.committed && f.now + frameIntervalSeconds(f) >= legCancelBy(player, t, second, f) - EPS) commit(player, t, second, f);
  if (first.landed && second.committed && f.now + EPS >= second.planned!.point) land(player, t, second, f);
}

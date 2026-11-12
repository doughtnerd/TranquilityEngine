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
 */
import type { FadeLaw, MusicGroupStamp, ShapedFade } from "../backend";
import type { MusicSwitchNode, SegmentNode } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid, type SegmentGrid } from "../../../../engine/audio/musicGrid";
import type { MusicFrame, MusicNodeRef, MusicPlayer } from "./musicSystem";
import {
  cancelPlanned, frameIntervalSeconds, lookaheadSeconds, requestStart, type PlanGrid, type PlannedStart, type PlanReason, type PlanRequest,
} from "./planner";
import {
  enterFrame, enterPoint, exitTime, findRule, resolveFades, type GridAt, type PlayingGrid, type ResolvedFade, type RuleMatch,
} from "./transitionRules";
import { advanceAnchor, anchorRun, playingGridOf, predictWrap, ticksAt, type GridAnchor } from "./anchors";
import { cancelRun, segmentClipSource, type SegmentRun } from "./segmentRun";

/** Where a transition is. */
export type TransitionState = "pending" | "stamped" | "running" | "bridging" | "done" | "cancelled";

/** §3.2 `Transition`. R3a and R3b may add fields here. */
export interface Transition {
  /** Target node (the child the switch, playlist or seek asked for). */
  readonly to: MusicNodeRef;
  /** R3a: the matched rule (a queued transition's is matched from the incoming segment it will leave). */
  match: RuleMatch;
  /**
   * `pending`: planned, priming or waiting; `stamped`: the incoming group is stamped, still cancellable; `running`:
   * past the cancel point (the outgoing fade is stamped) until it lands at T; `done` once landed; `cancelled`.
   */
  state: TransitionState;
  /** Heard time (seconds) of the exit point T; NaN until planned. */
  exitAt: number;
  /** Heard time (seconds) until which it can still be replaced (T - L). */
  cancelBy: number;
  /** The incoming start (and the bridge's, while bridging). */
  incoming: PlannedStart | null;
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
}

/** Options of `requestTransition` (R3a). */
export interface TransitionOptions {
  /** A natural advance (P4): leave at the exit cue whatever the rule's `exit` (§2.4). */
  readonly natural?: boolean;
  /** Why (the planner's re-plan and refusal counters). Default `"transition"`. */
  readonly reason?: PlanReason;
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

/** What a plan needs again at the stamp and the commit (one per planned transition). */
interface PlanContext {
  readonly target: MusicNodeRef;
  readonly grid: SegmentGrid;
  readonly request: PlanRequest;
}

const contexts = new WeakMap<Transition, PlanContext>();
/** Outgoing runs left as `player.next` after a landing, until their voices end. */
const ringing = new WeakSet<SegmentRun>();
/** Outgoing fades waiting for a backend without stamped fades (`fadeShaped`): applied at their start. */
const unstamped = new WeakMap<Transition, { at: number; seconds: number }>();

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

/**
 * The segment a target starts: itself; for a `musicSwitch`, the child its parameter picks (else its default, else the
 * first); for a `playlist`, its first child (P4 passes the item its order picks). Null when none is a segment.
 */
function resolveSegment(player: MusicPlayer, node: MusicNodeRef, depth = 0): MusicNodeRef | null {
  if (node.type === "segment") return node;
  if (depth >= MAX_DEPTH) return null;
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

/** The playing run's anchor (the player's when it is that run's, else one from the run's stamp). */
function anchorOf(player: MusicPlayer): GridAnchor | null {
  const run = player.run;
  if (!run) return null;
  const a = player.anchor;
  if (a && a.segment === run.node.id) return a;
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

/** The playing segment's position at heard `t` (loop passes unrolled), as R1's `GridAt`. */
function outAt(anchor: GridAnchor, t: number): GridAt | null {
  const pg = playingGridOf(anchor);
  return pg ? { grid: pg.grid, ticks: ticksAt(anchor, t) } : null;
}

const lawIn = (c: ResolvedFade["curve"]): FadeLaw => (c === "equalPower" ? "equalPowerIn" : c);
const lawOut = (c: ResolvedFade["curve"]): FadeLaw => (c === "equalPower" ? "equalPowerOut" : c);

/** The rule's two fades at T (seconds relative to T), or the immediate crossfade. Null without a grid. */
function fadesAt(t: Transition, grid: SegmentGrid, anchor: GridAnchor | null, T: number): { out: ResolvedFade; in: ResolvedFade } | null {
  if (t.immediate) {
    const x: ResolvedFade = { seconds: Math.max(0, t.immediate.fadeSeconds), offset: 0, curve: "equalPower" };
    return { out: x, in: x };
  }
  const out = anchor ? outAt(anchor, T) : null;
  if (!out) return null;
  const into = enterPoint(t.match, grid, out);
  return resolveFades(t.match, out, { grid, ticks: into.ticksAtExit });
}

/** True when T is the playing segment's exit cue (in its pass): the outgoing's tail rings on, unfaded. */
function atExitCue(player: MusicPlayer, t: Transition, anchor: GridAnchor | null, T: number): boolean {
  if (t.immediate || !anchor) return false;
  const cue = pointOf(player, anchor, t.match, T, true);
  return Number.isFinite(cue) && Math.abs(cue - T) <= 1e-6;
}

/** Heard time the outgoing fade starts at for exit T (+Infinity: no fade, the tail rings on). */
function outStart(player: MusicPlayer, t: Transition, ctx: PlanContext, T: number): number {
  const anchor = t.outgoing ? anchorFor(player, t.outgoing) : null;
  if (atExitCue(player, t, anchor, T)) return Number.POSITIVE_INFINITY;
  const fades = fadesAt(t, ctx.grid, anchor, T);
  return fades ? T + fades.out.offset : T;
}

/** The anchor of `run` while it plays (the player's, when `run` is the playing one). */
function anchorFor(player: MusicPlayer, run: SegmentRun): GridAnchor | null {
  if (player.run === run) return anchorOf(player);
  return Number.isFinite(run.startAt) ? anchorRun(run, run.startAt) : null;
}

/** A shaped fade starting at `start` over `seconds`, moved to `earliest` with the phase it has there (null: over by then). */
function clampFade(start: number, seconds: number, earliest: number): { at: number; seconds: number; startPhase: number } | null {
  if (start >= earliest - EPS) return { at: start, seconds, startPhase: 0 };
  const late = earliest - start;
  if (!(seconds > late + EPS)) return null;
  return { at: earliest, seconds: seconds - late, startPhase: late / seconds };
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
    after: null, immediate, natural, reason,
  };
}

/** The player is playing (or committed) a segment a change can leave. */
function canLeave(player: MusicPlayer): boolean {
  if (player.state === "stopping" || player.state === "stopped" || player.state === "refused") return false;
  const run = player.run;
  return run !== null && run.state !== "cancelled" && run.state !== "new" && anchorOf(player) !== null;
}

/**
 * Plan `t` from the playing segment through the planner (`requestStart`). True while it lives (priming, waiting for a
 * temporary refusal's retry, or stamped); false when it was refused or has no point (the music plays on).
 */
function plan(player: MusicPlayer, t: Transition, f: MusicFrame): boolean {
  if (!canLeave(player)) return false;
  advanceAnchor(player, f.now);
  const anchor = anchorOf(player)!;
  const target = resolveSegment(player, t.to);
  const grid = target ? gridOf(target) : null;
  if (!target || !grid) {
    player.counters.refusals.noTrack = (player.counters.refusals.noTrack ?? 0) + 1;
    return false;
  }
  t.outgoing = player.run;
  const rate = rateOf(target);
  const onStamped = (p: PlannedStart, fr: MusicFrame): void => stamped(player, t, p, fr);
  const onDropped = (): void => dropped(player, t);
  let request: PlanRequest;
  if (t.immediate) {
    request = {
      to: target, reason: t.reason, grid: "immediate", notBefore: Number.NaN, startFrame: Math.max(0, Math.round(t.immediate.startFrame)),
      preEntry: 0, fades: (p) => incomingFades(player, t, p), onStamped, onDropped,
    };
  } else {
    const now = outAt(anchor, f.now);
    const enter0 = now ? enterPoint(t.match, grid, now) : null;
    const fades0 = fadesAt(t, grid, anchor, f.now);
    request = {
      to: target, reason: t.reason, grid: planGrid(t), notBefore: Number.NaN,
      startFrame: now ? enterFrame(t.match, grid, now, rate) : 0,
      preEntry: enter0?.preEntry ?? 0,
      fadeLead: fades0 ? Math.max(0, -fades0.out.offset) : 0,
      points: (nb) => pointOf(player, anchor, t.match, nb, t.natural),
      startFrameAt: (T) => {
        const out = outAt(anchor, T);
        return out ? enterFrame(t.match, grid, out, rate) : 0;
      },
      fades: (p) => incomingFades(player, t, p),
      onStamped,
      onDropped,
    };
  }
  contexts.set(t, { target, grid, request });
  t.state = "pending";
  player.transition = t;
  requestStart(player, request, f);
  const p = player.planned;
  if (!p || p.request !== request || (t.state as TransitionState) === "cancelled") return false;
  t.incoming = p;
  refresh(player, t, f);
  if (player.state === "playing" || player.state === "committed") player.state = "pending";
  return true;
}

/** The incoming members' first fades (the planner asks just before the stamp): silent from the start, then the fade-in. */
function incomingFades(player: MusicPlayer, t: Transition, p: PlannedStart): MusicGroupStamp["fades"] {
  const ctx = contexts.get(t);
  if (!ctx) return undefined;
  const T = p.point;
  const anchor = t.outgoing ? anchorFor(player, t.outgoing) : null;
  const fades = fadesAt(t, ctx.grid, anchor, T);
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

/** T and the cancel point from the plan as it stands (a re-plan moves both). */
function refresh(player: MusicPlayer, t: Transition, f: MusicFrame): void {
  const p = t.incoming;
  const ctx = contexts.get(t);
  if (!p || !ctx) return;
  t.exitAt = p.point;
  const start = Number.isFinite(p.point) ? outStart(player, t, ctx, p.point) : Number.NaN;
  t.cancelBy = Math.min(p.at, start) - lookaheadSeconds(f);
}

/** The planner stamped the incoming group (same frame, same batch). */
function stamped(player: MusicPlayer, t: Transition, p: PlannedStart, f: MusicFrame): void {
  if (player.transition !== t || t.state !== "pending") return;
  t.incoming = p;
  t.state = "stamped";
  if (player.state === "pending" || player.state === "playing") player.state = "transitioning";
  refresh(player, t, f);
  if (f.now + frameIntervalSeconds(f) >= t.cancelBy - EPS) commit(player, t, f);
}

/** The planner dropped the plan (refused, no point left): the music plays on. */
function dropped(player: MusicPlayer, t: Transition): void {
  if (t.state === "done" || t.state === "cancelled") return;
  t.state = "cancelled";
  if (player.transition === t) {
    player.transition = null;
    if (player.state === "pending" || player.state === "transitioning") player.state = "playing";
  }
}

/** Past the cancel point: stamp the outgoing fade (or leave the tail ringing). */
function commit(player: MusicPlayer, t: Transition, f: MusicFrame): void {
  const ctx = contexts.get(t);
  t.state = "running";
  const out = t.outgoing;
  if (!ctx || !out || out.state === "cancelled") return;
  const T = t.exitAt;
  const anchor = anchorFor(player, out);
  if (atExitCue(player, t, anchor, T)) return; // the post-exit tail rings on, ramp-free
  const fades = fadesAt(t, ctx.grid, anchor, T);
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
      unstamped.set(t, { at: shaped.at, seconds: shaped.seconds });
    }
  }
}

/** A backend without stamped fades: the outgoing's fade starts at the first frame at or after its time. */
function applyUnstamped(t: Transition, f: MusicFrame): void {
  const u = unstamped.get(t);
  if (!u || f.now + EPS < u.at) return;
  unstamped.delete(t);
  for (const s of t.outgoing?.stems ?? []) s.voice?.stop(u.seconds);
}

/** True while any of the run's voices still sounds. */
function sounding(run: SegmentRun): boolean {
  if (run.state === "cancelled" || run.state === "new") return false;
  for (const s of run.stems) if (s.voice && (s.voice.alive ?? s.voice.playing)) return true;
  return false;
}

/** At T: the incoming run plays, the outgoing rings out as `player.next`, and a queued change is planned. */
function land(player: MusicPlayer, t: Transition, f: MusicFrame): void {
  const inc = t.incoming?.run;
  t.state = "done";
  if (player.transition === t) player.transition = null;
  if (inc) {
    const out = t.outgoing;
    player.run = inc;
    player.anchor = anchorRun(inc, inc.startAt);
    if (player.next === inc) player.next = null;
    if (out && out !== inc && sounding(out) && player.next === null) {
      player.next = out;
      ringing.add(out);
    }
  }
  if (player.state === "pending" || player.state === "transitioning" || player.state === "committed") player.state = "playing";
  const after = t.after;
  t.after = null;
  if (after && isOpen(after)) {
    after.match = findRule(player.root, player.run?.node.id ?? "", after.to.id);
    if (!plan(player, after, f)) {
      after.state = "cancelled";
      if (player.transition === after) player.transition = null;
    }
  }
}

/** Drop an uncommitted transition: its plan is cancelled, or its stamped group's rings close and voices STOP. */
function abandon(player: MusicPlayer, t: Transition, f: MusicFrame): void {
  const p = t.incoming;
  if (t.state === "pending") {
    if (p && player.planned === p) cancelPlanned(player, f);
  } else if (t.state === "stamped" && p) {
    cancelRun(p.run, f);
    if (player.next === p.run) player.next = null;
  }
  unstamped.delete(t);
  t.state = "cancelled";
  if (player.transition === t) player.transition = null;
  if (player.state === "pending" || player.state === "transitioning") player.state = "playing";
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
  t.match = findRule(player.root, cur.incoming?.run.node.id ?? player.run?.node.id ?? "", t.to.id);
  return t;
}

// --- The API ---------------------------------------------------------------------------------------------------------

/**
 * R3a: ask for a change to `to` under its rule (switch, playlist, stinger-free change). Replaces a pending one before its
 * cancel point; after it, queues behind it. Returns the transition, or null when refused (the music plays on).
 *
 * `to` may be a container (a switch child that is a playlist or a switch): it starts the segment that container picks;
 * the rule is matched for `to` itself. The same target as the open transition returns it unchanged. `options.natural`
 * (P4's natural advance) leaves at the exit cue. A temporary refusal still returns the transition: the planner retries
 * it at each allowed point.
 */
export function requestTransition(player: MusicPlayer, to: MusicNodeRef, f: MusicFrame, options: TransitionOptions = {}): Transition | null {
  if (!canLeave(player)) return null;
  const natural = options.natural === true;
  const reason = options.reason ?? "transition";
  const cur = player.transition;
  if (isOpen(cur)) {
    if (cur.to.id === to.id && !cur.immediate && cur.natural === natural) {
      if (cur.after) cur.after.state = "cancelled";
      cur.after = null;
      return cur;
    }
    if (!replaceable(cur, f)) {
      if (cur.after && isOpen(cur.after) && cur.after.to.id === to.id && !cur.after.immediate) return cur.after;
      return queueAfter(player, cur, newTransition(to, cur.match, null, natural, reason));
    }
    abandon(player, cur, f);
  }
  const t = newTransition(to, findRule(player.root, player.run!.node.id, to.id), null, natural, reason);
  if (plan(player, t, f)) return t;
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
 * segment. `startFrame` is in `to`'s clip frames, pre-entry included (no extra pre-entry is added).
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
  if (plan(player, t, f)) return t;
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
  if (player.state === "stopping" || player.state === "stopped") {
    // `handle.stop` fades the run and the next run (P1's `stopPlayerRuns`); an uncommitted change is dropped.
    if (replaceable(t, f) || t.state === "stamped") abandon(player, t, f);
    else {
      t.state = "cancelled";
      player.transition = null;
    }
    return;
  }
  if (t.state === "pending") {
    // Another start replaced the plan (the planner holds one per player): the change is gone.
    if (t.incoming && player.planned !== t.incoming) return abandon(player, t, f);
    refresh(player, t, f);
    return;
  }
  if (t.state === "stamped") {
    refresh(player, t, f);
    if (f.now + frameIntervalSeconds(f) >= t.cancelBy - EPS) commit(player, t, f);
  }
  if (t.state === "running") {
    applyUnstamped(t, f);
    if (f.now + EPS >= t.exitAt) land(player, t, f);
  }
}

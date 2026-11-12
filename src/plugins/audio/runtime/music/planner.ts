/**
 * The planner (ADR 0166 api-and-models §3.2 `PlannedStart`; architecture §4.1; ADR 0167 §1: lead = 1.25 Ê + L + Δ̄).
 *
 * Owner: **P2** (W4). Q2 wrote the skeleton. Pure decisions over player state plus the step-9 tick that applies them.
 *
 * - **Lead:** `primeLeadSeconds`: 1.25 Ê + L + Δ̄ for a group with unprimed streamed members, L otherwise. Ê is the
 *   backend's `MusicBackend.primeEmaMs` (seeded at 40 ms; P1's `musicOps` samples it and skips samples while hidden):
 *   the planner only reads it, fresh at every plan. L is `horizon() - now`; Δ̄ is the backend's `frameInterval()` when it
 *   has one, else L / 2 (exact while L is the unclamped 2 Δ̄, as at 60 Hz).
 * - **Grid point:** the first point of the rule's `exit` kind (`PlanRequest.points`, else the playing segment's grid
 *   through its anchor) with T - preEntry ≥ now + lead and the outgoing fade start ≥ now + L; `immediate` takes
 *   now + lead exactly; the first segment anchors the grid at its earliest stampable frame ≥ `Audio.play`'s `at`
 *   (closer than the lead: now + lead with one warning).
 * - **Deadline:** every member primed in its epoch and T_start ≥ F_now + L: stamp now; not primed and
 *   T_start < F_now + L + Δ̄ (or primed but already inside L): re-plan. The rule's own kind picks the next point; when
 *   the prime so far took more than half the gap it aims at the point after next; a start frame that moved with T
 *   re-targets (new epochs); three re-plans in a row warn `replanStorm` once.
 * - **Refusals (R14):** permanent (the pool can never hold it, alone or beside the playing group: F3's
 *   `segmentRingNeed`, or the backend's own permanent answer): dropped with one warning naming the numbers; temporary:
 *   evict another player's primed-but-unstarted successor planned later than this start, else keep the plan `waiting`
 *   and retry admission once at each allowed point (each frame for an `immediate` or first start). The playing music
 *   is never touched by a refusal.
 */
import type { MusicAdmitResult, MusicBackend, MusicGroupStamp } from "../backend";
import {
  compileSegmentGrid, entrySeconds, exitSeconds, nextGridSeconds, spanAtTicks, ticksToSeconds, type SegmentGrid,
} from "../../../../engine/audio/musicGrid";
import type { SegmentNode } from "../../../../engine/audio/musicFormat";
import { segmentRingNeed } from "../../../../engine/audio/musicValidate";
import { musicPlayers, type MusicFrame, type MusicNodeRef, type MusicPlayer } from "./musicSystem";
import { anchorRun } from "./anchors";
import {
  cancelRun, createSegmentRun, groupRequest, pollPrimed, primeRun, segmentClipSource, stampRun, type SegmentRun,
} from "./segmentRun";

/** The margin on Ê in the lead (ADR 0167 §1). */
export const PRIME_LEAD_FACTOR = 1.25;
/** Re-plans in a row that warn `replanStorm` once. */
export const REPLAN_STORM = 3;
/** Ê before a backend reports one, ms (architecture §4.1's seed). */
const PRIME_EMA_FALLBACK_MS = 40;
/** L when the backend has no `horizon` or its clock has no estimate yet: 2 Δ̄ at 60 Hz. */
const DEFAULT_LOOKAHEAD_SECONDS = 2 / 60;
/** Float noise allowed when comparing heard seconds (far under one frame at 192 kHz). */
const EPS = 1e-7;
/** How far past the old point a re-plan asks for the next one (grid points are a beat or more apart). */
const NEXT_POINT_SECONDS = 1e-3;

/** Why a start was (re-)planned. */
export type PlanReason = "start" | "transition" | "playlist" | "switch" | "seek" | "reload" | "recovery" | "deadline" | "retry";

/** A grid kind a start may land on (the rule's `exit` kind, §2.4), or `immediate`. */
export type PlanGrid = "immediate" | "beat" | "bar" | "grid" | "nextCue" | "exitCue";

/** What a container asks the planner for. P2 added the optional fields after `startFrame`. */
export interface PlanRequest {
  /** The node to start (a segment, or a container the transition resolves to one). */
  readonly to: MusicNodeRef;
  readonly reason: PlanReason;
  readonly grid: PlanGrid;
  /** Earliest heard time (seconds) wanted for T (the entry point); NaN: as soon as the lead allows. */
  readonly notBefore: number;
  /** File frame the incoming segment starts at (entry - pre-entry, or a seek offset). */
  readonly startFrame: number;
  /** Seconds of incoming audio before T (the pre-entry): the group starts at T - preEntry. Default 0. */
  readonly preEntry?: number;
  /** Seconds before T the outgoing fade starts (a fade-out with a negative offset); it must be ≥ now + L. Default 0. */
  readonly fadeLead?: number;
  /**
   * The next allowed point (heard seconds of T) at or after `notBefore`, of the rule's kind; NaN when there is none
   * (past the exit cue). R3a passes `(t) => exitTime(match, playing, t, false)`. Absent: the playing segment's grid
   * through `player.anchor` (beat, bar, `grid` as bar, the next cue, the exit cue), or `immediate` when nothing plays.
   */
  readonly points?: (notBefore: number) => number;
  /** The start frame for a T (a `sameTime` or position entry); a re-plan that moves it re-targets. Absent: `startFrame`. */
  readonly startFrameAt?: (point: number) => number;
  /** First in-voice fades of the incoming members (absolute `at`s), asked for just before the stamp. */
  readonly fades?: (planned: PlannedStart) => MusicGroupStamp["fades"];
  /** Called right after the group is stamped (same frame, same batch): R3a fades the outgoing here. */
  readonly onStamped?: (planned: PlannedStart, f: MusicFrame) => void;
  /** Called when the plan is dropped (a permanent refusal, no point left, no playable track); the music plays on. */
  readonly onDropped?: (planned: PlannedStart, cause: string) => void;
}

/** Where a plan is: admitted and priming (or decoded, waiting for its stamp), or refused for now and retrying. */
export type PlanStatus = "priming" | "waiting";

/** The next planned start (§3.2 `PlannedStart`). P2 may add fields here. */
export interface PlannedStart {
  readonly request: PlanRequest;
  /** The run being primed for it (a fresh one after an eviction). */
  run: SegmentRun;
  /** Heard time (seconds) the group starts (T - preEntry). */
  at: number;
  /** Heard time (seconds) by which every member must be primed, else re-plan (T_start - L - Δ̄ when planned). */
  deadline: number;
  /** The lead this plan used, seconds. */
  leadSeconds: number;
  /** Re-plans of this request in a row. */
  replans: number;
  /** P2: heard time (seconds) of the point T itself (the entry). */
  point: number;
  /** P2: priming, or waiting after a temporary refusal. */
  status: PlanStatus;
  /** P2: the last temporary refusal's cause (`poolFull`, `groupTableFull`, `evicted`), null once admitted. */
  refusal: string | null;
  /** P2: the player's first segment: no grid yet, so every point is "immediate" and the stamp anchors the grid. */
  readonly first: boolean;
}

// --- Clock inputs ----------------------------------------------------------------------------------------------------

/**
 * P2: the lead in seconds (architecture §4.1): `needsPrime` (unprimed streamed members) gives 1.25 Ê + L + Δ̄, else L.
 * `primeEmaMs` Ê, `lookaheadSeconds` L, `frameIntervalSeconds` Δ̄.
 */
export function primeLeadSeconds(primeEmaMs: number, lookaheadSeconds: number, frameIntervalSeconds: number, needsPrime: boolean): number {
  return needsPrime ? (PRIME_LEAD_FACTOR * primeEmaMs) / 1000 + lookaheadSeconds + frameIntervalSeconds : lookaheadSeconds;
}

/** P2: L, seconds: the backend's `horizon() - now`, or 2 Δ̄ at 60 Hz without one (or before its clock has an estimate). */
export function lookaheadSeconds(f: MusicFrame): number {
  const h = f.backend.horizon?.();
  if (h === undefined || !Number.isFinite(h) || !(h - f.now > EPS)) return DEFAULT_LOOKAHEAD_SECONDS;
  return h - f.now;
}

/**
 * P2: Δ̄, seconds: the backend's `frameInterval()` (the clock's frame-interval EMA) when it has one, else L / 2 (L is
 * clamp(2 Δ̄, 1,024 frames, 100 ms), so this is exact at 60 Hz and errs long, the safe side, at high refresh rates).
 */
export function frameIntervalSeconds(f: MusicFrame): number {
  const fi = f.backend.frameInterval?.();
  if (fi !== undefined && Number.isFinite(fi) && fi > 0) return fi;
  return lookaheadSeconds(f) / 2;
}

/** F_now + L in heard seconds: the earliest stampable start. */
function horizonOf(f: MusicFrame): number {
  return f.now + lookaheadSeconds(f);
}

function needsPrime(run: SegmentRun): boolean {
  for (const s of run.stems) if (s.streamed && !s.primed) return true;
  return false;
}

/** The lead for `run` now (Ê read fresh from the backend). */
function leadFor(run: SegmentRun, f: MusicFrame): number {
  return primeLeadSeconds(f.music?.primeEmaMs ?? PRIME_EMA_FALLBACK_MS, lookaheadSeconds(f), frameIntervalSeconds(f), needsPrime(run));
}

// --- Grids -----------------------------------------------------------------------------------------------------------

const grids = new WeakMap<object, SegmentGrid | null>();

/** A segment's compiled grid (G1), cached per node object; null for a node that isn't a segment. */
function gridOf(node: MusicNodeRef): SegmentGrid | null {
  const cached = grids.get(node);
  if (cached !== undefined) return cached;
  let grid: SegmentGrid | null = null;
  const seg = node as Partial<SegmentNode>;
  if (node.type === "segment" && Array.isArray(seg.tempo) && Array.isArray(seg.cues)) {
    const clip = seg.tracks?.[0]?.clip;
    const facts = clip ? segmentClipSource().facts(clip) : undefined;
    grid = compileSegmentGrid(node as SegmentNode, facts && facts.rate > 0 ? { endSeconds: facts.frames / facts.rate } : {});
  }
  grids.set(node, grid);
  return grid;
}

/** Seconds of one beat at the segment's entry, NaN without a grid. */
function beatSecondsOf(node: MusicNodeRef): number {
  const g = gridOf(node);
  if (!g) return Number.NaN;
  const bpm = g.bpm[spanAtTicks(g, Number.isFinite(g.entryTicks) ? g.entryTicks : 0)] ?? 0;
  return bpm > 0 ? 60 / bpm : Number.NaN;
}

/**
 * The next point of `kind` at or after heard `notBefore` on the playing segment, through `player.anchor` (heard(t) =
 * anchor.time + file(t) - file(anchor.ticks)), clamped to the exit cue; NaN past it. `notBefore` itself when nothing
 * plays or the segment has no grid.
 */
function defaultPoint(player: MusicPlayer, kind: PlanGrid, notBefore: number): number {
  const run = player.run;
  const a = player.anchor;
  const g = run ? gridOf(run.node) : null;
  if (!run || !a || !g || kind === "immediate") return notBefore;
  const base = ticksToSeconds(g, a.ticks);
  const file = base + (notBefore - a.time);
  const exit = exitSeconds(g) ?? Number.NaN;
  if (exit < file - EPS) return Number.NaN;
  let point: number;
  if (kind === "beat") point = nextGridSeconds(g, file, "beat");
  else if (kind === "bar" || kind === "grid") point = nextGridSeconds(g, file, "bar");
  else if (kind === "exitCue") point = exit;
  else {
    point = Number.NaN;
    for (let i = 0; i < g.cueTicks.length; i++) {
      const t = g.cueTicks[i]!;
      if (Number.isNaN(t)) continue;
      const s = ticksToSeconds(g, t);
      if (s >= file - EPS && !(s >= point)) point = s;
    }
  }
  if (Number.isFinite(exit) && !(point <= exit)) point = exit;
  if (!Number.isFinite(point)) return Number.NaN;
  return a.time + (point - base);
}

/** True when the plan lands on points of a kind (re-plans move to the next point), false for "now + lead" plans. */
function onGrid(p: PlannedStart): boolean {
  return !p.first && p.request.grid !== "immediate";
}

// --- Per-instance warnings and counters --------------------------------------------------------------------------------

const warned = new WeakMap<MusicPlayer, Set<string>>();

/** One warning per cause per instance (§1.6). */
function warnPlayer(player: MusicPlayer, cause: string, message: string): void {
  let set = warned.get(player);
  if (!set) warned.set(player, (set = new Set()));
  if (set.has(cause)) return;
  set.add(cause);
  console.warn(`[myco] Music "${player.instance.path}": ${message}`);
}

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

// --- Admission ---------------------------------------------------------------------------------------------------------

/**
 * `primeRun` (P1) answers only true or false; this wrapper of the frame's `MusicBackend` keeps the admission's answer
 * so the planner can tell a permanent refusal from a temporary one. One object, rewritten per call.
 */
const probe = {
  inner: null as MusicBackend | null,
  last: null as MusicAdmitResult | null,
};
const probeMusic: MusicBackend = {
  get caps() { return probe.inner!.caps; },
  admitGroup(req) {
    const r = probe.inner!.admitGroup(req);
    probe.last = r;
    return r;
  },
  primeGroup(req, options) { probe.inner!.primeGroup(req, options); },
  primedState(group) { return probe.inner!.primedState(group); },
  stampGroup(stamp) { return probe.inner!.stampGroup(stamp); },
  cancelGroup(group) { probe.inner!.cancelGroup(group); },
  releaseInstance(instance) { probe.inner!.releaseInstance(instance); },
  protect(instance, paths) { probe.inner!.protect(instance, paths); },
  get onGroupEvent() { return probe.inner!.onGroupEvent; },
  set onGroupEvent(fn) { probe.inner!.onGroupEvent = fn; },
  get primeEmaMs() { return probe.inner!.primeEmaMs; },
  get ringPool() { return probe.inner!.ringPool; },
};
const probeFrame = { backend: null as unknown as MusicFrame["backend"], music: probeMusic as MusicBackend | null, now: 0, dt: 0, hidden: false };

const ADMITTED: MusicAdmitResult = { ok: true };
const NO_GROUP_ID: MusicAdmitResult = { ok: false, reason: "groupTableFull", permanent: false };

/** Admit and prime `run` (P1's `primeRun`), returning the backend's answer. */
function tryPrime(player: MusicPlayer, run: SegmentRun, f: MusicFrame): MusicAdmitResult {
  probe.inner = f.music;
  probe.last = null;
  probeFrame.backend = f.backend;
  probeFrame.now = f.now;
  probeFrame.dt = f.dt;
  probeFrame.hidden = f.hidden;
  const ok = primeRun(player, run, probeFrame);
  const last = probe.last as MusicAdmitResult | null;
  probe.inner = null;
  if (ok) return ADMITTED;
  return last && !last.ok ? last : NO_GROUP_ID;
}

/** The pool size (`MusicBackend.ringPool`), or undefined when the backend has none (0: no priming, nothing to check). */
function ringPoolOf(music: MusicBackend): number | undefined {
  const n = music.ringPool;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function streamedCount(run: SegmentRun | null): number {
  if (!run || run.state === "cancelled" || run.state === "ending") return 0;
  let n = 0;
  for (const s of run.stems) if (s.streamed) n++;
  return n;
}

/**
 * R14's permanent test before admission: the segment's peak need alone (F3's `segmentRingNeed`, with the run's own
 * streamed count as a floor) or its group beside the playing one exceeds the pool. Null when it fits or the pool is unknown.
 */
function neverFits(player: MusicPlayer, run: SegmentRun, music: MusicBackend): { need: number; pool: number; beside: boolean } | null {
  const pool = ringPoolOf(music);
  if (pool === undefined) return null;
  const own = streamedCount(run);
  const alone = Math.max(own, segmentRingNeed(run.node as SegmentNode, segmentClipSource().facts).rings);
  if (alone > pool) return { need: alone, pool, beside: false };
  const playing = player.run !== run ? streamedCount(player.run) : 0;
  if (own + playing > pool) return { need: own + playing, pool, beside: true };
  return null;
}

/** Other players' unstamped successors planned after `at`, latest first: what a temporary refusal may evict. */
function evictionCandidates(player: MusicPlayer, at: number): MusicPlayer[] {
  const out: MusicPlayer[] = [];
  for (const q of musicPlayers()) {
    const qp = q.planned;
    if (q === player || !qp || qp.status !== "priming" || !(qp.at > at + EPS) || streamedCount(qp.run) === 0) continue;
    if (qp.run.state !== "priming" && qp.run.state !== "admitted") continue;
    out.push(q);
  }
  return out.sort((x, y) => y.planned!.at - x.planned!.at);
}

/** Evict `q`'s successor: its rings close and it retries at its next allowed point. */
function evict(q: MusicPlayer, f: MusicFrame): void {
  const qp = q.planned!;
  cancelRun(qp.run, f);
  if (q.next === qp.run) q.next = null;
  qp.status = "waiting";
  qp.refusal = "evicted";
  bump(q.counters.refusals, "evicted");
}

type AdmitOutcome = "ok" | "temporary" | "permanent";

/** Admit and prime the plan's run (a fresh run when the last one was cancelled), evicting a later successor if needed. */
function admit(player: MusicPlayer, p: PlannedStart, f: MusicFrame): AdmitOutcome {
  const music = f.music;
  if (!music) return "permanent";
  if (p.run.state !== "new") {
    const fresh = createSegmentRun(player, p.request.to, p.run.startFrame);
    if (!fresh) return "permanent";
    p.run = fresh;
  }
  const run = p.run;
  const nf = neverFits(player, run, music);
  if (nf) {
    bump(player.counters.refusals, "neverFits");
    warnPlayer(player, "neverFits", `segment "${run.node.id}" needs ${nf.need} music rings${nf.beside ? " beside the playing segment" : ""}; this preset has ${nf.pool}. The change is dropped.`);
    return "permanent";
  }
  let res = tryPrime(player, run, f);
  if (!res.ok && !res.permanent) {
    for (const q of evictionCandidates(player, p.at)) {
      evict(q, f);
      res = tryPrime(player, run, f);
      if (res.ok || res.permanent) break;
    }
  }
  if (res.ok) {
    p.status = "priming";
    p.refusal = null;
    player.next = run;
    return "ok";
  }
  bump(player.counters.refusals, res.reason);
  if (res.permanent) {
    const need = streamedCount(run);
    warnPlayer(player, res.reason, res.reason === "noMusicRings"
      ? `segment "${run.node.id}" streams ${need} stems, and this preset has no music rings (audio.music.rings). The change is dropped.`
      : `segment "${run.node.id}" needs ${need} music rings, more than this preset's music pool. The change is dropped.`);
    return "permanent";
  }
  p.status = "waiting";
  p.refusal = res.reason;
  return "temporary";
}

// --- Placing a plan on a point -------------------------------------------------------------------------------------------

/**
 * Put `p` on its point: the first allowed point (after `after` when finite) with T - preEntry ≥ now + lead and
 * T - fadeLead ≥ now + L, at or after `notBefore`. Sets point, at, deadline, lead; the run's start frame follows T.
 */
function place(player: MusicPlayer, p: PlannedStart, f: MusicFrame, after: number): void {
  const req = p.request;
  const L = lookaheadSeconds(f);
  const lead = leadFor(p.run, f);
  const preEntry = Math.max(0, req.preEntry ?? 0);
  const earliest = Math.max(f.now + lead + preEntry, f.now + L + Math.max(0, req.fadeLead ?? 0));
  let nb = earliest;
  if (Number.isFinite(req.notBefore) && req.notBefore > nb) nb = req.notBefore;
  if (onGrid(p) && Number.isFinite(after)) nb = Math.max(nb, after + NEXT_POINT_SECONDS);
  let point = nb;
  if (onGrid(p)) {
    point = req.points ? req.points(nb) : defaultPoint(player, req.grid, nb);
    // A points source that answers before what was asked (a clamp) can't be stamped: treat it as no point.
    if (point < earliest - EPS) point = Number.NaN;
  }
  p.point = point;
  p.at = point - preEntry;
  p.leadSeconds = lead;
  p.deadline = p.at - L - frameIntervalSeconds(f);
  player.counters.leadMs = lead * 1000;
  const beat = beatSecondsOf(player.run?.node ?? req.to);
  if (lead > beat) warnPlayer(player, "leadOverBeat", `the prime lead (${Math.round(lead * 1000)} ms) is longer than one beat (${Math.round(beat * 1000)} ms); beat-quantised changes land late.`);
}

/** The start frame for the plan's point; true when it moved (a primed group must re-target). */
function followStartFrame(p: PlannedStart): boolean {
  const at = p.request.startFrameAt;
  if (!at || !Number.isFinite(p.point)) return false;
  const frame = Math.max(0, Math.round(at(p.point)));
  if (frame === p.run.startFrame) return false;
  p.run.startFrame = frame;
  return true;
}

/** Re-prime the admitted run from its new start frame (new epochs, C8). */
function retarget(player: MusicPlayer, p: PlannedStart, f: MusicFrame): void {
  const run = p.run;
  const music = f.music;
  if (!music || (run.state !== "priming" && run.state !== "admitted")) return;
  const protect: string[] = [];
  for (const r of [player.run, run]) if (r) for (const s of r.stems) if (s.streamed && !protect.includes(s.clip)) protect.push(s.clip);
  music.primeGroup(groupRequest(player, run), { retarget: true, protect });
  let decoded = 0;
  for (const s of run.stems) {
    if (s.streamed) s.primed = false;
    else decoded++;
  }
  if (run.state === "priming") {
    run.prime = { group: run.group, requestedAt: f.now, postedMs: performance.now(), primed: decoded, of: run.stems.length, readyMs: Number.NaN };
  }
}

/** Drop the plan (the music plays on); a first start that is dropped leaves the player `refused`. */
function drop(player: MusicPlayer, p: PlannedStart, cause: string, f: MusicFrame): void {
  cancelRun(p.run, f);
  if (player.next === p.run) player.next = null;
  if (player.planned === p) player.planned = null;
  if (p.first) player.state = "refused";
  p.request.onDropped?.(p, cause);
}

// --- The API ---------------------------------------------------------------------------------------------------------------

/**
 * P2: plan `req` for `player`: picks T, makes and primes the run (P1), records `player.planned` (replacing an unstamped
 * one, whose group is cancelled) and `player.next`. Null when refused now: a permanent refusal drops it (one warning,
 * `onDropped`), a temporary one leaves `player.planned` `waiting`, retried by `planTick` at each allowed point. A
 * refusal never touches the playing segment.
 */
export function requestStart(player: MusicPlayer, req: PlanRequest, f: MusicFrame): PlannedStart | null {
  if (player.planned) cancelPlanned(player, f);
  const first = player.run === null;
  const run = createSegmentRun(player, req.to, req.startFrame);
  const p: PlannedStart = {
    request: req, run: run as SegmentRun, at: Number.NaN, deadline: Number.NaN, leadSeconds: 0, replans: 0,
    point: Number.NaN, status: "waiting", refusal: null, first,
  };
  if (!run) {
    bump(player.counters.refusals, "noTrack");
    warnPlayer(player, `noTrack:${req.to.id}`, `"${req.to.id}" has no playable track; the change is dropped.`);
    if (first) player.state = "refused";
    req.onDropped?.(p, "noTrack");
    return null;
  }
  if (!f.music) {
    warnPlayer(player, "noMusic", "this audio backend has no music support; the music plays nothing.");
    if (first) player.state = "refused";
    req.onDropped?.(p, "noMusic");
    return null;
  }
  place(player, p, f, Number.NaN);
  if (first && Number.isFinite(player.requestedAt) && player.requestedAt + EPS < p.point && req.notBefore === player.requestedAt) {
    warnPlayer(player, "atInsideLead", `Audio.play's at (${player.requestedAt.toFixed(3)} s) is closer than the prime lead (${Math.round(p.leadSeconds * 1000)} ms); it starts at ${p.point.toFixed(3)} s.`);
  }
  if (!Number.isFinite(p.point)) {
    bump(player.counters.replans, "noPoint");
    drop(player, p, "noPoint", f);
    return null;
  }
  followStartFrame(p);
  player.planned = p;
  player.next = run;
  const outcome = admit(player, p, f);
  if (outcome === "permanent") {
    drop(player, p, "refused", f);
    return null;
  }
  if (outcome === "temporary") {
    if (first) player.state = "waiting";
    return null;
  }
  if (first) player.state = "starting";
  return p;
}

/** P2: drop the player's planned start (its group is cancelled). */
export function cancelPlanned(player: MusicPlayer, f: MusicFrame): void {
  const p = player.planned;
  if (!p) return;
  player.planned = null;
  cancelRun(p.run, f);
  if (player.next === p.run) player.next = null;
}

/** Stamp the primed plan at its start; the first segment becomes the player's run and anchors the grid. */
function stamp(player: MusicPlayer, p: PlannedStart, f: MusicFrame): void {
  const fades = p.request.fades?.(p);
  stampRun(player, p.run, p.at, f, fades);
  player.planned = null;
  if (p.first) {
    player.run = p.run;
    if (player.next === p.run) player.next = null;
    player.anchor = anchorRun(p.run, p.at);
    player.state = "committed";
  }
  p.request.onStamped?.(p, f);
}

/** The deadline missed: the rule's own kind picks the next point (the point after next when the prime is slow). */
function replan(player: MusicPlayer, p: PlannedStart, f: MusicFrame): void {
  p.replans++;
  bump(player.counters.replans, "deadline");
  if (p.replans === REPLAN_STORM) {
    bump(player.counters.replans, "replanStorm");
    warnPlayer(player, "replanStorm", `${REPLAN_STORM} re-plans in a row for "${p.run.node.id}": the stems aren't primed in time (prime lead ${Math.round(p.leadSeconds * 1000)} ms).`);
  }
  const old = p.point;
  const spent = f.now - (p.run.prime?.requestedAt ?? f.now);
  place(player, p, f, old);
  if (onGrid(p) && Number.isFinite(p.point) && Number.isFinite(old) && spent > (p.point - old) / 2) {
    place(player, p, f, p.point); // far re-target (est.): aim at the point after next
  }
  if (!Number.isFinite(p.point)) {
    bump(player.counters.replans, "noPoint");
    drop(player, p, "noPoint", f);
    return;
  }
  if (onGrid(p) && (p.request.grid === "nextCue" || p.request.grid === "exitCue")) {
    warnPlayer(player, "primeLateCue", `"${p.run.node.id}" wasn't primed in time for its cue; the change moves to ${p.point.toFixed(3)} s.`);
  }
  if (followStartFrame(p)) retarget(player, p, f);
}

/**
 * P2, step 9: the player's first start (state `starting`/`waiting`), then the deadline of `player.planned`: stamp when
 * primed in time, re-plan when late, retry a temporary refusal at the next allowed point.
 */
export function planTick(player: MusicPlayer, f: MusicFrame): void {
  if (player.state === "committed" && player.run && f.now + EPS >= player.run.startAt) player.state = "playing";
  if (player.state === "stopping" || player.state === "stopped" || player.state === "refused") return;
  if (!player.planned && player.run === null && player.state === "starting" && player.root.type === "segment") {
    const g = gridOf(player.root);
    requestStart(player, {
      to: player.root, reason: "start", grid: "immediate", notBefore: player.requestedAt, startFrame: 0,
      preEntry: g ? Math.max(0, entrySeconds(g)) : 0,
    }, f);
    // A decoded first segment is primed now: it stamps in this frame's batch (below). A refusal waits for the next frame.
    const started = player.planned as PlannedStart | null; // requestStart set it (TS narrowed it to null above)
    if (started?.status !== "priming") return;
  }
  const p = player.planned;
  if (!p) return;
  if (p.status === "waiting") {
    // Retry once per allowed point: an "immediate" (or first) plan every frame, a grid plan when its point is out of reach.
    if (onGrid(p) && Number.isFinite(p.at) && p.at >= f.now + leadFor(p.run, f) - EPS) return;
    if (p.run.state !== "new") {
      const fresh = createSegmentRun(player, p.request.to, p.run.startFrame);
      if (!fresh) return drop(player, p, "noTrack", f);
      p.run = fresh;
    }
    place(player, p, f, onGrid(p) ? p.point : Number.NaN);
    if (!Number.isFinite(p.point)) {
      bump(player.counters.replans, "noPoint");
      return drop(player, p, "noPoint", f);
    }
    followStartFrame(p);
    bump(player.counters.replans, "retry");
    const outcome = admit(player, p, f);
    if (outcome === "permanent") return drop(player, p, "refused", f);
    if (outcome === "ok" && p.first) player.state = "starting";
    return;
  }
  const ready = pollPrimed(p.run, f);
  const horizon = horizonOf(f);
  if (ready && p.at >= horizon - EPS) {
    stamp(player, p, f);
    return;
  }
  if ((!ready && p.at < horizon + frameIntervalSeconds(f) - EPS) || (ready && p.at < horizon - EPS)) {
    replan(player, p, f);
    // A primed group re-planned with the short lead (now + L) stamps in this frame, or it would be inside L again.
    if (ready && player.planned === p && p.run.state !== "cancelled" && p.at >= horizon - EPS && pollPrimed(p.run, f)) stamp(player, p, f);
  }
}

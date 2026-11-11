/**
 * The planner (ADR 0166 api-and-models §3.2 `PlannedStart`; architecture §4.1; ADR 0167 §1: lead = 1.25 Ê + L + Δ̄).
 *
 * Owner: **P2** (W4). Q2 wrote the skeleton. Pure decisions over player state plus the step-9 tick that applies them.
 *
 * - **Lead:** `primeLeadSeconds`: 1.25 Ê + L + Δ̄ for a group with unprimed streamed members, L otherwise; Ê seeded at
 *   40 ms (`MusicBackend.primeEmaMs`), not sampled while hidden.
 * - **Grid point:** the first point of the rule's `exit` kind with T - preEntry ≥ now + lead and the outgoing fade start
 *   ≥ now + L; `immediate` takes now + lead exactly; the first segment anchors the grid at its earliest stampable frame.
 * - **Deadline:** every member primed in its epoch and T_start ≥ F_now + L: stamp now; not primed and
 *   T_start < F_now + L + Δ̄: re-plan (the rule's own kind picks the next point; three in a row warn `replanStorm`).
 * - **Refusals (R14):** permanent (never fits): dropped with one warning; temporary: evict a primed successor, else
 *   retry at each allowed point. A refused stinger is dropped.
 */
import type { MusicFrame, MusicNodeRef, MusicPlayer } from "./musicSystem";
import type { SegmentRun } from "./segmentRun";

/** The margin on Ê in the lead (ADR 0167 §1). */
export const PRIME_LEAD_FACTOR = 1.25;
/** Re-plans in a row that warn `replanStorm` once. */
export const REPLAN_STORM = 3;

/** Why a start was (re-)planned. */
export type PlanReason = "start" | "transition" | "playlist" | "switch" | "seek" | "reload" | "recovery" | "deadline" | "retry";

/** A grid kind a start may land on (the rule's `exit` kind, §2.4), or `immediate`. */
export type PlanGrid = "immediate" | "beat" | "bar" | "grid" | "nextCue" | "exitCue";

/** What a container asks the planner for. */
export interface PlanRequest {
  /** The node to start (a segment, or a container the transition resolves to one). */
  readonly to: MusicNodeRef;
  readonly reason: PlanReason;
  readonly grid: PlanGrid;
  /** Earliest heard time (seconds) wanted; NaN: as soon as the lead allows. */
  readonly notBefore: number;
  /** File frame the incoming segment starts at (entry - pre-entry, or a seek offset). */
  readonly startFrame: number;
}

/** The next planned start (§3.2 `PlannedStart`). P2 may add fields here. */
export interface PlannedStart {
  readonly request: PlanRequest;
  /** The run being primed for it. */
  readonly run: SegmentRun;
  /** Heard time (seconds) the group starts (T - preEntry). */
  at: number;
  /** Heard time (seconds) by which every member must be primed, else re-plan. */
  deadline: number;
  /** The lead this plan used, seconds. */
  leadSeconds: number;
  /** Re-plans of this request in a row. */
  replans: number;
}

/**
 * P2: the lead in seconds (architecture §4.1): `needsPrime` (unprimed streamed members) gives 1.25 Ê + L + Δ̄, else L.
 * `primeEmaMs` Ê, `lookaheadSeconds` L, `frameIntervalSeconds` Δ̄.
 */
export function primeLeadSeconds(primeEmaMs: number, lookaheadSeconds: number, frameIntervalSeconds: number, needsPrime: boolean): number {
  return needsPrime ? (PRIME_LEAD_FACTOR * primeEmaMs) / 1000 + lookaheadSeconds + frameIntervalSeconds : lookaheadSeconds; // Q2 wrote the formula; P2 owns it
}

/** P2: plan `req` for `player`: picks T, makes and primes the run (P1), records `player.planned`. Null when refused now. */
export function requestStart(player: MusicPlayer, req: PlanRequest, f: MusicFrame): PlannedStart | null {
  void player;
  void req;
  void f;
  return null; // STUB(P2)
}

/** P2: drop the player's planned start (its group is cancelled). */
export function cancelPlanned(player: MusicPlayer, f: MusicFrame): void {
  void player;
  void f;
  // STUB(P2)
}

/**
 * P2, step 9: the player's first start (state `starting`/`waiting`), then the deadline of `player.planned`: stamp when
 * primed in time, re-plan when late, retry a temporary refusal at the next allowed point.
 */
export function planTick(player: MusicPlayer, f: MusicFrame): void {
  void player;
  void f;
  // STUB(P2)
}

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
 */
import type { MusicFrame, MusicNodeRef, MusicPlayer } from "./musicSystem";
import type { PlannedStart } from "./planner";
import type { RuleMatch } from "./transitionRules";

/** Where a transition is. */
export type TransitionState = "pending" | "stamped" | "running" | "bridging" | "done" | "cancelled";

/** §3.2 `Transition`. R3a and R3b may add fields here. */
export interface Transition {
  /** Target node (the child the switch, playlist or seek asked for). */
  readonly to: MusicNodeRef;
  readonly match: RuleMatch;
  state: TransitionState;
  /** Heard time (seconds) of the exit point T; NaN until planned. */
  exitAt: number;
  /** Heard time (seconds) until which it can still be replaced (T - L). */
  cancelBy: number;
  /** The incoming start (and the bridge's, while bridging). */
  incoming: PlannedStart | null;
  bridge: PlannedStart | null;
}

/**
 * R3a: ask for a change to `to` under its rule (switch, playlist, stinger-free change). Replaces a pending one before its
 * cancel point; after it, queues behind it. Returns the transition, or null when refused (the music plays on).
 */
export function requestTransition(player: MusicPlayer, to: MusicNodeRef, f: MusicFrame): Transition | null {
  void player;
  void to;
  void f;
  return null; // STUB(R3a)
}

/**
 * R3a (H5): an immediate transition into `to` at file frame `startFrame` with a `fadeMs` crossfade, stamped at now plus
 * the lead (R7's seek, P8's reload). Null when refused; the reason is on the player's counters.
 */
export function planImmediate(player: MusicPlayer, to: MusicNodeRef, startFrame: number, fadeMs: number, f: MusicFrame): Transition | null {
  void player;
  void to;
  void startFrame;
  void fadeMs;
  void f;
  return null; // STUB(R3a)
}

/** R3a: cancel the pending transition (before its cancel point): its group's rings close and its voices STOP. */
export function cancelTransition(player: MusicPlayer, f: MusicFrame): void {
  void player;
  void f;
  // STUB(R3a)
}

/** R3a, R3b, step 9: stamp the incoming group when primed, fade the outgoing, chain the bridge, end the outgoing run. */
export function tickTransition(player: MusicPlayer, f: MusicFrame): void {
  void player;
  void f;
  // STUB(R3a)
}

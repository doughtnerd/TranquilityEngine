/**
 * One playing music instance and the only code that changes its lifecycle (ADR 0229; ADR 0166 api-and-models §3.2,
 * architecture §2.1's state diagram).
 *
 * Every other module reads a player through `MusicPlayer`, whose fields are read-only, and moves it through the named
 * transitions below. The rules that used to be copied into each container live here once:
 *
 * - **Promotion** (`promote`): a run becomes the playing one, a successor that was that run stops being the successor,
 *   the grid is anchored on the run's start, and the loop-region state starts fresh (R4b: "a new run starts with fresh
 *   state", whichever module promoted it).
 * - **The successor** (`adoptSuccessor`, `cancelSuccessor`): at most one; a cancel clears it only while it is that run.
 * - **The plan** (`adoptPlan`, `clearPlan`): the planner's next start, whose run is the successor while it primes.
 * - **The transition** (`beginTransition`, `finishTransition`, `abandonTransition`, `clearTransition`, `markPending`,
 *   `syncOverlap`): `pending` while a change is planned, `transitioning` only while two segments are heard together (D18).
 * - **The first start and recovery** (`primeStart`, `waitForRoom`, `refuseStart`, `commitStart`, `noteStartHeard`,
 *   `beginRecovery`, `restartFirst`), and **the end** (`stopPlayer`, `endPlayer`).
 *
 * Sub-states that one module owns (loop regions, loop tails, stingers, beat cursors, a playlist adopted through a
 * switch) are attached by their owner with `attachState`; their contents stay the owner's. Nothing here allocates
 * except `newMusicPlayer`: the transitions run every audio frame.
 */
import type { MusicHandle } from "../../../../engine/audio/musicTypes";
import type { MusicNode } from "../../../../engine/audio/musicFormat";
import type { EventInstance } from "../events/eventRuntime";
import { anchorRun, type GridAnchor } from "./anchors";
import type { BeatState } from "./beatClock";
import { createMusicHandle } from "./handle";
import type { LoopTailState } from "./loopTail";
import { createSwitchState, type SwitchState } from "./musicSwitch";
import type { PlannedStart } from "./planner";
import { createPlaylistState, type PlaylistState } from "./playlist";
import type { RegionState } from "./regions";
import type { SegmentRun } from "./segmentRun";
import type { StingerState } from "./stingers";
import type { Transition } from "./transition";

/** The player's lifecycle (architecture §2.1's state diagram). `Pending` is a planned change (`transition`); `Transitioning` only while two segments are audible together (D18). */
export type MusicPlayerState =
  | "starting"
  | "waiting"
  | "refused"
  | "committed"
  | "playing"
  | "pending"
  | "transitioning"
  | "recovering"
  | "stopping"
  | "stopped";

/**
 * Per-instance counters (§1.6 `MusicDebugRow`; P10 reads them, each owner increments its own). Counts unless stated.
 * Reason and cause keys are the warning causes of §1.6 (`poolFull`, `neverFits`, `primeLate`, `groupLate`, ...).
 */
export interface MusicCounters {
  /** P2: re-plans by reason. */
  readonly replans: Record<string, number>;
  /** P2, R4a, R5: refusals by cause. */
  readonly refusals: Record<string, number>;
  /** P3: groups that started late, held by a starving member, or given up by the core. */
  lateGroups: number;
  groupsHeld: number;
  groupTimeouts: number;
  /** P3: audio frames, the slip of the last late or held group. */
  lastSlipFrames: number;
  /** P9: recoveries by cause (`rebuild`, `hidden`, `reload`, `crash`). */
  readonly recoveries: Record<string, number>;
  /** K1: beats coalesced into `missed` since the instance started. */
  missedBeats: number;
  /** R5: stinger outcomes. */
  readonly stingers: { played: number; late: number; skipped: number; dropped: number };
  /** P1, P2: milliseconds, the last group prime time and the lead it was planned with. */
  primeLastMs: number;
  leadMs: number;
}

/**
 * One playing music instance (§3.2 `MusicPlayer`), read-only: the debug row, the keyframe source and every music
 * module read it here, and change it only through this module's transitions.
 */
export interface MusicPlayer {
  /** The event instance that plays it (P6). Its `group` is the instance id the backend's encoded cache keys on (R16). */
  readonly instance: EventInstance;
  /** The event's music root (`segment`, `playlist` or `musicSwitch`). */
  readonly root: MusicNode;
  readonly state: MusicPlayerState;
  /** Heard time (seconds) `Audio.play`'s `at` asked the first entry for; NaN: as soon as possible (R12). */
  readonly requestedAt: number;
  /** The playing segment's run; null while priming the first one. */
  readonly run: SegmentRun | null;
  /** The committed or priming successor's run, or an outgoing run ringing out after a landing (at most one). */
  readonly next: SegmentRun | null;
  /** The planner's next start, or null. */
  readonly planned: PlannedStart | null;
  /** The playing segment's grid anchor (its contents move with the loop passes, `anchors.ts`). */
  readonly anchor: GridAnchor | null;
  /** The pending or running transition. */
  readonly transition: Transition | null;
  /** Playlist cursors and shuffle bags, when the root (or a child) is a playlist. */
  readonly playlist: PlaylistState | null;
  /** The switch value, when the root (or a child) is a musicSwitch. */
  readonly musicSwitch: SwitchState | null;
  /** `count` and `while` region state of the playing run; null after a promotion until `regions.ts` makes it. */
  readonly regions: RegionState | null;
  /** Loop tails ringing over a wrap. */
  readonly tails: LoopTailState | null;
  /** The stinger queue and `dontRepeat` stamps. */
  readonly stingers: StingerState | null;
  /** Beat prediction cursors. */
  readonly beats: BeatState | null;
  /** `handle.music`. */
  readonly handle: MusicHandle;
  /** Debug counters (§1.6); each owner increments its own. */
  readonly counters: MusicCounters;
}

/** The sub-states one module owns and attaches (`attachState`). */
export type MusicSubState = "regions" | "tails" | "stingers" | "beats" | "playlist";

/** The record behind the read-only view: only this module writes it. */
type Fields = { -readonly [K in keyof MusicPlayer]: MusicPlayer[K] };
const w = (p: MusicPlayer): Fields => p as Fields;

/** Float noise allowed when comparing heard seconds. */
const EPS = 1e-7;

/** Fresh counters for a new player. */
function newCounters(): MusicCounters {
  return {
    replans: {}, refusals: {}, lateGroups: 0, groupsHeld: 0, groupTimeouts: 0, lastSlipFrames: 0, recoveries: {},
    missedBeats: 0, stingers: { played: 0, late: 0, skipped: 0, dropped: 0 }, primeLastMs: 0, leadMs: 0,
  };
}

/** A player in `starting` for `instance` (the registry, `musicSystem.createMusicPlayer`, is the only caller). */
export function newMusicPlayer(instance: EventInstance, root: MusicNode, requestedAt: number): MusicPlayer {
  const p: Fields = {
    instance,
    root,
    state: "starting",
    requestedAt,
    run: null,
    next: null,
    planned: null,
    anchor: null,
    transition: null,
    playlist: createPlaylistState(root, instance.group),
    musicSwitch: createSwitchState(root),
    regions: null,
    tails: null,
    stingers: null,
    beats: null,
    handle: undefined as unknown as MusicHandle, // set below: the handle reads the player
    counters: newCounters(),
  };
  p.handle = createMusicHandle(p);
  return p;
}

// --- The playing run and its successor ------------------------------------------------------------------------------

/**
 * `run` plays from heard `at`: it is the player's run, no longer its successor, the grid is anchored on it, and its
 * loop regions start fresh. The planner's first start, a recovery's re-entry, a transition's landing, a playlist's
 * step and a reload's swap all promote through here.
 */
export function promote(player: MusicPlayer, run: SegmentRun, at: number): void {
  const p = w(player);
  p.run = run;
  if (p.next === run) p.next = null;
  p.anchor = anchorRun(run, at);
  p.regions = null;
}

/** `run` is the successor: a start the planner primes, or an outgoing run left ringing out after a landing. */
export function adoptSuccessor(player: MusicPlayer, run: SegmentRun): void {
  w(player).next = run;
}

/** The successor `run` is gone (cancelled, dropped, ended): it stops being the successor. Null clears whatever is. */
export function cancelSuccessor(player: MusicPlayer, run: SegmentRun | null): void {
  const p = w(player);
  if (run === null || p.next === run) p.next = null;
}

/** The planner's next start: recorded, and its run is the successor while it primes. */
export function adoptPlan(player: MusicPlayer, plan: PlannedStart): void {
  const p = w(player);
  p.planned = plan;
  p.next = plan.run;
}

/** The plan is stamped, dropped or replaced: it stops being the player's plan (the successor is `cancelSuccessor`'s). */
export function clearPlan(player: MusicPlayer, plan: PlannedStart): void {
  const p = w(player);
  if (p.planned === plan) p.planned = null;
}

// --- The first start --------------------------------------------------------------------------------------------------

/** The first start is planned and priming (or asks again): `starting`. */
export function primeStart(player: MusicPlayer): void {
  w(player).state = "starting";
}

/** The first start was refused for now (no room yet); the planner retries it: `waiting`. */
export function waitForRoom(player: MusicPlayer): void {
  w(player).state = "waiting";
}

/** The first start can't happen (nothing playable, no music support, refused for good): `refused`. */
export function refuseStart(player: MusicPlayer): void {
  w(player).state = "refused";
}

/** The first segment (or a recovery's re-entry) is stamped at `at`: promoted, and `committed` until it is heard. */
export function commitStart(player: MusicPlayer, run: SegmentRun, at: number): void {
  promote(player, run, at);
  w(player).state = "committed";
}

/** A committed start heard by `now` plays: `committed` becomes `playing`. */
export function noteStartHeard(player: MusicPlayer, now: number): void {
  const p = w(player);
  if (p.state === "committed" && p.run && now + EPS >= p.run.startAt) p.state = "playing";
}

// --- Recovery -------------------------------------------------------------------------------------------------------

/** A context rebuild, a crash or an abandoned group lost the playing run: `recovering` until its re-entry is stamped. */
export function beginRecovery(player: MusicPlayer): void {
  w(player).state = "recovering";
}

/** A recovery before anything was stamped: nothing plays, and the first start runs again from `starting`. */
export function restartFirst(player: MusicPlayer): void {
  const p = w(player);
  p.run = null;
  p.anchor = null;
  p.regions = null;
  p.state = "starting";
}

// --- Transitions ------------------------------------------------------------------------------------------------------

/** `t` is the player's pending or running transition. */
export function beginTransition(player: MusicPlayer, t: Transition): void {
  w(player).transition = t;
}

/** A change is planned: a playing (or committed) player is `pending`. */
export function markPending(player: MusicPlayer): void {
  const p = w(player);
  if (p.state === "playing" || p.state === "committed") p.state = "pending";
}

/** `t` is no longer the player's transition (it was never planned, or it closed); the state is left alone. */
export function clearTransition(player: MusicPlayer, t: Transition): void {
  const p = w(player);
  if (p.transition === t) p.transition = null;
}

/** `t` landed its last leg: it closes, and a pending (or committed) player plays (an overlap still heard stays `transitioning`). */
export function finishTransition(player: MusicPlayer, t: Transition): void {
  clearTransition(player, t);
  const p = w(player);
  if (p.state === "pending" || p.state === "committed") p.state = "playing";
}

/** `t` was dropped before it landed: it closes, and the playing segment plays on (`playing`). */
export function abandonTransition(player: MusicPlayer, t: Transition): void {
  clearTransition(player, t);
  const p = w(player);
  if (p.state === "pending" || p.state === "transitioning") p.state = "playing";
}

/**
 * After a transition tick: `transitioning` while two segments are heard together (`overlap`), else back to `pending`
 * while a change is still open (`open`) or `playing`. Only a playing, pending or transitioning player moves.
 */
export function syncOverlap(player: MusicPlayer, overlap: boolean, open: boolean): void {
  const p = w(player);
  const s = p.state;
  if (s !== "playing" && s !== "pending" && s !== "transitioning") return;
  if (overlap) p.state = "transitioning";
  else if (s === "transitioning") p.state = open ? "pending" : "playing";
}

// --- The end ----------------------------------------------------------------------------------------------------------

/** `handle.stop`, or a recovery past its limit: `stopping` (the player ends once nothing sounds). A refused or ended player stays as it is. */
export function stopPlayer(player: MusicPlayer): void {
  const p = w(player);
  if (p.state !== "stopped" && p.state !== "refused") p.state = "stopping";
}

/** The instance ended and left the registry: `stopped`. */
export function endPlayer(player: MusicPlayer): void {
  w(player).state = "stopped";
}

/**
 * Whether the instance is still on its way to sounding, whatever its voices do: before its first group (`starting`,
 * `waiting`, `committed`), while a change is pending or heard, while recovering, or while a playing player's plan or a
 * run still primes. False once refused or stopped; a playing or stopping player is otherwise for its voices to say.
 */
export function musicPending(player: MusicPlayer): boolean {
  switch (player.state) {
    case "stopped": case "refused": return false;
    case "starting": case "waiting": case "committed": case "pending": case "transitioning": case "recovering": return true;
    default: break;
  }
  if (player.state === "playing" && player.planned !== null) return true;
  if (player.state === "stopping") return false;
  return priming(player.run) || priming(player.next);
}

const priming = (run: SegmentRun | null): boolean => run !== null && (run.state === "new" || run.state === "admitted" || run.state === "priming");

// --- Owned sub-states -------------------------------------------------------------------------------------------------

/**
 * The owner of a sub-state attaches it (regions for a new run, the first loop tail, the first stinger, the first beat
 * cursor, a playlist entered through a switch). Only that owner writes its contents.
 */
export function attachState<K extends MusicSubState>(player: MusicPlayer, key: K, state: MusicPlayer[K]): void {
  w(player)[key] = state as Fields[K];
}

/**
 * The music player registry and the two frame steps (ADR 0166 api-and-models §1.4, §3.2, §6 "Frame order";
 * architecture §1, §2.1, §4.5; ADR 0167 §2: the early step is the built-in system `engine.AudioMusic`).
 *
 * Owners (M4 waves plan, single-writer table): **Q2** wrote the skeleton, the registry, `createMusicPlayer` and the step
 * guards; **P7** fills `beginMusicFrame` (the early step: `backend.beginFrame()`, the status mirror); **K2** fills
 * `dispatchMusic` (component messages, the subscription mask); **K5** fills `subscribeMusic` (`handle.onMusic`).
 *
 * - **Step 0** (`musicEarlyStep`, the system `engine.AudioMusic`, update phase before `engine.UpdateScripts`, only in the
 *   World that has the view): with no music player it returns at once (no `beginFrame`, no allocation: the flip's safety
 *   net, `musicSystem.test.ts`). Otherwise it calls the backend's idempotent `beginFrame` (P7) and dispatches beat, bar
 *   and cue events (K2, K5).
 * - **Step 9** (`musicPlanStep`, `engine.Audio` in lateUpdate, before `frameCommit`): each player ticks in the fixed order
 *   of `tickPlayer`, after scripts set parameters; groups, stingers and quantised ramps go into this frame's batch.
 *
 * A player is made by the event runtime (P6, `EventInstance.playNode` on a `segment`, `playlist` or `musicSwitch` root)
 * through `createMusicPlayer`, and ends through `disposeMusicPlayer`. `handle.music` finds it with `playerOf`.
 */
import type { AudioBackend, MusicBackend } from "../backend";
import type { MusicEvent, MusicHandle, MusicKind } from "../../../../engine/audio/musicTypes";
import type { EventInstance } from "../events/eventRuntime";
import { createMusicHandle } from "./handle";
import { applyReloads } from "./reload";
import { tickSwitch, type SwitchState } from "./musicSwitch";
import { tickPlaylist, type PlaylistState } from "./playlist";
import { tickRegions, type RegionState } from "./regions";
import { tickTransition, type Transition } from "./transition";
import { planTick, type PlannedStart } from "./planner";
import { tickLoopTails, type LoopTailState } from "./loopTail";
import { tickStingers, type StingerState } from "./stingers";
import { tickStems } from "./stems";
import { routeGroupEvent, type SegmentRun } from "./segmentRun";
import type { GridAnchor } from "./anchors";
import type { BeatState } from "./beatClock";

/**
 * A music node as the runtime sees it before F1a/F1b's format types land: every `segment`, `playlist` and `musicSwitch`
 * node of `engine/audio/musicFormat.ts` satisfies this. Owners narrow it with the format's own guards.
 */
export interface MusicNodeRef {
  /** The node's id (§2.3), unique in its event. */
  readonly id: string;
  /** `"segment"`, `"playlist"` or `"musicSwitch"` for a music root; the format's node kinds for children. */
  readonly type: string;
}

/** The player's lifecycle (architecture §2.1's state diagram). `Pending` and `Transitioning` read `transition`. */
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
 * One playing music instance (§3.2 `MusicPlayer`). Each field's sub-state type lives in, and is filled by, its owner's
 * file; an owner may add fields to its own sub-state type, never to this one (ask the coordinator).
 */
export interface MusicPlayer {
  /** The event instance that plays it (P6). Its `group` is the instance id the backend's encoded cache keys on (R16). */
  readonly instance: EventInstance;
  /** The event's music root (`segment`, `playlist` or `musicSwitch`). */
  readonly root: MusicNodeRef;
  state: MusicPlayerState;
  /** Heard time (seconds) `Audio.play`'s `at` asked the first entry for; NaN: as soon as possible (R12). */
  readonly requestedAt: number;
  /** P1: the playing segment's run; null while priming the first one. */
  run: SegmentRun | null;
  /** P1, P2: the committed or priming successor's run (at most one per container). */
  next: SegmentRun | null;
  /** P2: the next planned start, or null. */
  planned: PlannedStart | null;
  /** P3: the playing segment's grid anchor. */
  anchor: GridAnchor | null;
  /** R3a, R3b: the pending or running transition. */
  transition: Transition | null;
  /** P4: playlist cursors and shuffle bags, when the root (or a child) is a playlist. */
  playlist: PlaylistState | null;
  /** R2: the switch value, when the root (or a child) is a musicSwitch. */
  musicSwitch: SwitchState | null;
  /** R4b: `count` and `while` region state of the playing segment. */
  regions: RegionState | null;
  /** R4a: loop tails ringing over a wrap. */
  tails: LoopTailState | null;
  /** R5: the stinger queue and `dontRepeat` stamps. */
  stingers: StingerState | null;
  /** K1: beat prediction cursors. */
  beats: BeatState | null;
  /** K5: `handle.onMusic` listeners, by kind; null until the first subscription. */
  listeners: MusicListeners | null;
  /** K2: the subscription mask (bit 0 beat, 1 bar, 2 cue): component hooks on the source's node, plus listeners. 0: not predicted. */
  subscribed: number;
  /** P7: `handle.music`. */
  readonly handle: MusicHandle;
  /** Debug counters (§1.6). */
  readonly counters: MusicCounters;
}

/** K5: `handle.onMusic` listeners of one instance, in subscription order per kind. */
export interface MusicListeners {
  readonly beat: ((e: MusicEvent) => void)[];
  readonly bar: ((e: MusicEvent) => void)[];
  readonly cue: ((e: MusicEvent) => void)[];
}

/** What a step hands each player's tick. One object, rewritten each frame (nothing allocates per frame). */
export interface MusicFrame {
  readonly backend: AudioBackend;
  /** `backend.music`, or null on a backend without music (the player then plays nothing and warns once). */
  readonly music: MusicBackend | null;
  /** This display frame's `Audio.time`, seconds. */
  readonly now: number;
  /** Game seconds since the last frame (0 while `Time.scale` is 0). */
  readonly dt: number;
  /** P9: true when the tick runs from the STATUS handler because the page is hidden (architecture §3.8). */
  readonly hidden: boolean;
}

/** Bits of `MusicPlayer.subscribed` (K2). */
export const MusicSubscription = { BEAT: 1, BAR: 2, CUE: 4 } as const;

// --- The registry (Q2) ---------------------------------------------------------------------------------------------

const players: MusicPlayer[] = [];
const byInstance = new WeakMap<object, MusicPlayer>();

/** The playing music instances, in creation order. Read-only view; nothing copies. */
export function musicPlayers(): readonly MusicPlayer[] {
  return players;
}

/** The player of an event instance, or null (not a music event, or it ended). */
export function playerOf(instance: object): MusicPlayer | null {
  return byInstance.get(instance) ?? null;
}

/** True while any music instance plays: the steps do nothing otherwise. */
export function musicActive(): boolean {
  return players.length > 0;
}

/** Fresh counters for a new player. */
function newCounters(): MusicCounters {
  return {
    replans: {},
    refusals: {},
    lateGroups: 0,
    groupsHeld: 0,
    groupTimeouts: 0,
    lastSlipFrames: 0,
    recoveries: {},
    missedBeats: 0,
    stingers: { played: 0, late: 0, skipped: 0, dropped: 0 },
    primeLastMs: 0,
    leadMs: 0,
  };
}

/**
 * P6 calls this when `EventInstance.playNode` reaches a music root: the player starts in `starting`, and step 9's
 * planner (P2) primes and stamps its first segment. `at` is `Audio.play`'s option (heard seconds); omitted or non-finite:
 * as soon as possible. A second call for the same instance returns the existing player.
 */
export function createMusicPlayer(instance: EventInstance, root: MusicNodeRef, options: { at?: number } = {}): MusicPlayer {
  const existing = byInstance.get(instance);
  if (existing) return existing;
  const at = options.at;
  const player: MusicPlayer = {
    instance,
    root,
    state: "starting",
    requestedAt: typeof at === "number" && Number.isFinite(at) ? at : Number.NaN,
    run: null,
    next: null,
    planned: null,
    anchor: null,
    transition: null,
    playlist: null,
    musicSwitch: null,
    regions: null,
    tails: null,
    stingers: null,
    beats: null,
    listeners: null,
    subscribed: 0,
    handle: undefined as unknown as MusicHandle, // set below: the handle reads the player
    counters: newCounters(),
  };
  (player as { handle: MusicHandle }).handle = createMusicHandle(player);
  players.push(player);
  byInstance.set(instance, player);
  return player;
}

/**
 * The instance ended (every voice ended, or it was refused): the player leaves the registry, its listeners end with it
 * (§1.2), and the backend drops the instance's encoded bytes (R16; P1 fills `releaseInstance` in `musicOps.ts`).
 */
export function disposeMusicPlayer(player: MusicPlayer, backend: AudioBackend | null): void {
  const k = players.indexOf(player);
  if (k < 0) return;
  players.splice(k, 1);
  byInstance.delete(player.instance);
  player.state = "stopped";
  player.listeners = null;
  player.subscribed = 0;
  backend?.music?.releaseInstance(player.instance.group);
}

/** @internal Tests: forget every player (between tests). */
export function _resetMusicPlayers(): void {
  for (const p of players) byInstance.delete(p.instance);
  players.length = 0;
}

/** @internal How often each step got past its guard (the safety-net test reads these). */
export const _musicStepStats = { early: 0, plan: 0 };

// --- The frame steps -------------------------------------------------------------------------------------------------

const frame = { backend: null as unknown as AudioBackend, music: null as MusicBackend | null, now: 0, dt: 0, hidden: false };

function setFrame(backend: AudioBackend, dt: number, hidden: boolean): MusicFrame {
  frame.backend = backend;
  frame.music = backend.music ?? null;
  frame.now = backend.time;
  frame.dt = dt;
  frame.hidden = hidden;
  return frame;
}

let boundGroupEvents: MusicBackend | null = null;

/**
 * Step 0, `engine.AudioMusic` (R17; `audioSystem.ts` calls it only in the World that has the view). Nothing without a
 * music player: no `beginFrame`, no allocation.
 */
export function musicEarlyStep(backend: AudioBackend, dt: number): void {
  if (players.length === 0) return;
  _musicStepStats.early++;
  const music = backend.music ?? null;
  if (music !== null && boundGroupEvents !== music) {
    // The group and member events reach the players through P1's router (delivered after the status mirror is read).
    music.onGroupEvent = routeGroupEvent;
    boundGroupEvents = music;
  }
  beginMusicFrame(backend);
  dispatchMusic(setFrame(backend, dt, false));
}

/** Step 9, the music plan (`engine.Audio`, before `frameCommit`). Nothing without a music player. */
export function musicPlanStep(backend: AudioBackend, dt: number): void {
  if (players.length === 0) return;
  _musicStepStats.plan++;
  const f = setFrame(backend, dt, false);
  // In creation order; a player disposed during its own tick leaves the array, so its index is visited again.
  for (let k = 0; k < players.length; k++) {
    const p = players[k]!;
    tickPlayer(p, f);
    if (players[k] !== p) k--;
  }
}

/**
 * One player's tick, in a fixed order (Q2): reloads swap first, then the containers decide what is wanted (switch,
 * playlist, regions), the transition and the planner turn that into groups, and what rides on the playing music last
 * (loop tails, stingers, stem ramps). P9 calls this from the STATUS handler while the page is hidden (`frame.hidden`).
 */
export function tickPlayer(player: MusicPlayer, f: MusicFrame): void {
  applyReloads(player, f); // P8
  tickSwitch(player, f); // R2
  tickPlaylist(player, f); // P4
  tickRegions(player, f); // R4b
  tickTransition(player, f); // R3a, R3b
  planTick(player, f); // P2
  tickLoopTails(player, f); // R4a
  tickStingers(player, f); // R5
  tickStems(player, f); // P5, R6
}

/** P9: the hidden-tab tick's frame (from the STATUS handler, architecture §3.8). */
export function hiddenFrame(backend: AudioBackend): MusicFrame {
  return setFrame(backend, 0, true);
}

// --- Owners' stubs ---------------------------------------------------------------------------------------------------

/**
 * P7: the early step's backend part: `backend.beginFrame?.()` (idempotent per rAF time) so `update()` reads this frame's
 * `Audio.time`, then this frame's group events from the status mirror (§6, R17). Runs only while music plays.
 */
export function beginMusicFrame(backend: AudioBackend): void {
  void backend; // STUB(P7)
}

/**
 * K2 (K5 adds listeners): per subscribed player, fire each beat, bar and cue event heard before `Audio.time` + Δ̄, first
 * to the component messages on the `AudioSource`'s node, then to `handle.onMusic` listeners in subscription order, with
 * the coalescing of architecture §4.5 (`missed`, `skippedCues`). A throw is caught and logged. Players with
 * `subscribed === 0` are not predicted.
 */
export function dispatchMusic(f: MusicFrame): void {
  void f; // STUB(K2)
}

const NOOP = (): void => {};

/**
 * K5: `handle.onMusic(kind, fn)` on a music instance: adds `fn` to the player's listeners and its kind to `subscribed`;
 * the returned function removes it. A listener added during a dispatch first hears the next event (§1.2).
 */
export function subscribeMusic(player: MusicPlayer, kind: MusicKind, fn: (e: MusicEvent) => void): () => void {
  void player;
  void kind;
  void fn;
  return NOOP; // STUB(K5)
}

/** `handle.onMusic` on any event handle (`Audio.ts`): a non-music handle returns a no-op function (§1.2). */
export function onMusicOf(instance: object, kind: MusicKind, fn: (e: MusicEvent) => void): () => void {
  const p = byInstance.get(instance);
  return p ? subscribeMusic(p, kind, fn) : NOOP;
}

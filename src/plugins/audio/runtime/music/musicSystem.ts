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
import type { MusicEvent, MusicEventHandle, MusicHandle, MusicKind } from "../../../../engine/audio/musicTypes";
import { GameBehavior } from "../../../../engine/core/Component";
import type { EventInstance } from "../events/eventRuntime";
import { createMusicHandle, segmentGrid } from "./handle";
import { entrySeconds } from "../../../../engine/audio/musicGrid";
import { applyReloads } from "./reload";
import { childFor, createSwitchState, tickSwitch, type SwitchState } from "./musicSwitch";
import { createPlaylistState, enterPlaylist, tickPlaylist, type PlaylistState } from "./playlist";
import { tickRegions, type RegionState } from "./regions";
import { tickTransition, type Transition } from "./transition";
import { frameIntervalSeconds, planTick, requestStart, type PlannedStart } from "./planner";
import { tickLoopTails, type LoopTailState } from "./loopTail";
import { tickStingers, type StingerState } from "./stingers";
import { tickStems } from "./stems";
import { routeGroupEvent, type SegmentRun } from "./segmentRun";
import { updateBeatHolds } from "./background";
import type { GridAnchor } from "./anchors";
import { predictDue, seatBeats, type BeatState } from "./beatClock";

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
  /** K2: the component hooks' share of the mask, read from the source's node each dispatch (`subscribed` is K5's listeners). */
  hooks: number;
  /** K2: the mask the last dispatch predicted for; a bit that appears in `subscribed | hooks` seats its cursor first. */
  predicted: number;
  /** K2: the public handle `MusicEvent.handle` carries; made on first use by the factory `Audio.ts` registers. */
  eventHandle: MusicEventHandle | null;
  /** P7: `handle.music`. */
  readonly handle: MusicHandle;
  /** Debug counters (§1.6). */
  readonly counters: MusicCounters;
}

/** K5: `handle.onMusic` listeners of one instance, in subscription order per kind. Copy on write: a subscribe or unsubscribe replaces the array, so a dispatch in progress walks the one it began with. */
export interface MusicListeners {
  beat: readonly ((e: MusicEvent) => void)[];
  bar: readonly ((e: MusicEvent) => void)[];
  cue: readonly ((e: MusicEvent) => void)[];
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
    playlist: createPlaylistState(root, instance.group),
    musicSwitch: createSwitchState(root),
    regions: null,
    tails: null,
    stingers: null,
    beats: null,
    listeners: null,
    subscribed: 0,
    hooks: 0,
    predicted: 0,
    eventHandle: null,
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
  player.hooks = 0;
  player.predicted = 0;
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
  planStepSerial = frameSerial;
}

/**
 * One player's tick, in a fixed order (Q2): reloads swap first, then the containers decide what is wanted (switch,
 * playlist, regions), the transition and the planner turn that into groups, and what rides on the playing music last
 * (loop tails, stingers, stem ramps). P9 calls this from the STATUS handler while the page is hidden (`frame.hidden`).
 */
export function tickPlayer(player: MusicPlayer, f: MusicFrame): void {
  applyReloads(player, f); // P8
  startSwitchRoot(player, f); // P7: a switch root's first segment
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
  backend.beginFrame?.(); // advances the clock map and reads the status mirror (group events go to `onGroupEvent`)
  updateBeatHolds(backend); // Rh1: rhythm mode holds callbacks through a recovery, before the dispatch
  frameSerial++; // the handles' snapshots are this frame's from here
}

let frameSerial = 0;

/** P7: counts the early steps; a handle's snapshot is recomputed on the first read after it moves. */
export function musicFrameSerial(): number {
  return frameSerial;
}

/** F-25: the `frameSerial` of the last step 9 (-1: none yet). */
let planStepSerial = -1;

/**
 * F-25: true when this frame's music plan step (step 9) has already run, so a group planned now is stamped no earlier
 * than the next frame's: a call from outside the frame (an editor transport, a page script, a timer) or from after
 * step 9. False from the early step to step 9, where a plan made in `update()` is stamped in this frame's batch.
 */
export function planStepDone(): boolean {
  return planStepSerial === frameSerial;
}

const warnedRoots = new WeakSet<MusicPlayer>();

/**
 * P7 (R2's note): a `musicSwitch` root starts its first segment through `childFor` (the parameter's child, else the
 * default). `planTick` starts only segment roots. A child that is itself a container isn't started here (P4 owns the
 * playlist descent): the player is refused with one warning.
 */
function startSwitchRoot(player: MusicPlayer, f: MusicFrame): void {
  const state = player.musicSwitch;
  if (!state || player.root.type !== "musicSwitch" || player.state !== "starting" || player.run || player.planned) return;
  const id = childFor(state, player.instance.getParameter(state.parameter));
  const child = (player.root as unknown as { children: MusicNodeRef[] }).children.find((c) => c.id === id);
  // P4: a playlist child (however nested) descends to its first playable leaf.
  const leaf = child ? enterPlaylist(player, child) : null;
  if (!child || !leaf) {
    player.state = "refused";
    if (!warnedRoots.has(player)) {
      warnedRoots.add(player);
      console.warn(`[myco] Music "${player.instance.path}": the switch's first child "${id}" has nothing playable; nothing plays.`);
    }
    return;
  }
  const g = segmentGrid(leaf);
  state.playing = child.id;
  requestStart(player, {
    to: leaf, reason: "start", grid: "immediate", notBefore: player.requestedAt, startFrame: 0,
    preEntry: g ? Math.max(0, entrySeconds(g)) : 0,
  }, f);
}

const KINDS = [
  { kind: "beat", bit: MusicSubscription.BEAT, hook: "onMusicBeat" },
  { kind: "bar", bit: MusicSubscription.BAR, hook: "onMusicBar" },
  { kind: "cue", bit: MusicSubscription.CUE, hook: "onMusicCue" },
] as const;

type Hook = (e: MusicEvent) => void;

function newEvent(): MusicEvent {
  return { handle: null as unknown as MusicEventHandle, segment: "", bar: 1, beat: 1, tempo: 0, beatsPerBar: 0, time: 0, heardIn: 0, missed: 0 };
}

/** One reused event per kind (nothing allocates per frame); `handle` is set per player. */
const scratch: Record<MusicKind, MusicEvent> = { beat: newEvent(), bar: newEvent(), cue: newEvent() };

type HandleFactory = (instance: EventInstance) => MusicEventHandle;
let makeHandle: HandleFactory | null = null;

/** `Audio.ts` registers how an instance becomes its public handle (it owns the class); `MusicEvent.handle` uses it. */
export function _setMusicHandleFactory(f: HandleFactory | null): void {
  makeHandle = f;
}

/** The nodes the source's hooks live on: its own and, for a component node, its owner's (as `PhysicsCore.notify`). */
function sourceEntities(player: MusicPlayer): number[] | null {
  const src = player.instance.musicSource;
  if (!src || src._destroyed || !src.node.isValid) return null;
  const a = src.node.entity;
  const b = src.owner.entity;
  return a === b ? [a] : [a, b];
}

/** Which of the three hooks some active behavior on the source's nodes defines. */
function hookMask(player: MusicPlayer): number {
  const ents = sourceEntities(player);
  if (!ents) return 0;
  const world = player.instance.musicSource!._world;
  let mask = 0;
  for (const e of ents) {
    const comps = world._componentsOf(e);
    if (!comps) continue;
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i]!;
      if (!(c instanceof GameBehavior) || !c.isActiveAndEnabled) continue;
      for (const k of KINDS) if (typeof (c as unknown as Record<string, unknown>)[k.hook] === "function") mask |= k.bit;
    }
  }
  return mask;
}

/** Calls `hook` on each active behavior of the source's nodes that defines it; a throw is logged, the rest still hear it. */
function deliverToComponents(player: MusicPlayer, hook: string, e: MusicEvent): void {
  const ents = sourceEntities(player);
  if (!ents) return;
  const world = player.instance.musicSource!._world;
  for (const ent of ents) {
    const list = world._componentsOf(ent);
    if (!list) continue;
    for (const c of [...list]) { // a hook may add or remove components
      if (!(c instanceof GameBehavior) || !c.isActiveAndEnabled) continue;
      const fn = (c as unknown as Record<string, Hook | undefined>)[hook];
      if (typeof fn !== "function") continue;
      try {
        fn.call(c, e);
      } catch (err) {
        console.error(`[myco] ${c.constructor.name}.${hook} threw:`, err);
      }
    }
  }
}

/**
 * K2 (K5 adds listeners): per subscribed player, fire each beat, bar and cue event heard before `Audio.time` + Δ̄, first
 * to the component messages on the `AudioSource`'s node, then to `handle.onMusic` listeners in subscription order, with
 * the coalescing of architecture §4.5 (`missed`, `skippedCues`; `predictDue` does it). A throw is caught and logged.
 * Players with no hook and no listener are not predicted. A kind that becomes subscribed (a component gains the hook, a
 * listener is added) owes nothing heard before this frame: its cursor is seated at `Audio.time` first.
 */
export function dispatchMusic(f: MusicFrame): void {
  const list = musicPlayers();
  if (list.length === 0) return;
  const interval = frameIntervalSeconds(f);
  for (let k = 0; k < list.length; k++) {
    const p = list[k]!;
    if (p.state === "stopped") continue;
    p.hooks = hookMask(p);
    const mask = p.subscribed | p.hooks;
    const fresh = mask & ~p.predicted;
    p.predicted = mask;
    if (mask === 0) continue;
    if (fresh !== 0) {
      // From nothing: forget the whole backlog; one more kind among running ones: only that kind's.
      if ((mask & ~fresh) === 0) seatBeats(p, f.now);
      else for (const d of KINDS) if (fresh & d.bit) seatBeats(p, f.now, d.kind);
    }
    if (p.eventHandle === null && makeHandle) p.eventHandle = makeHandle(p.instance);
    for (const d of KINDS) {
      if (!(mask & d.bit)) continue;
      const e = scratch[d.kind];
      e.handle = p.eventHandle as MusicEventHandle;
      if (!predictDue(p, d.kind, f.now, interval, e)) continue;
      if (p.hooks & d.bit) deliverToComponents(p, d.hook, e);
      const ls = p.listeners?.[d.kind];
      if (ls) {
        // K5 (D15): walks the array as it stood at this event, so a listener added during the loop first hears the next
        // event; one unsubscribed during it (itself or a later one) is not called again, even this frame.
        for (let i = 0, n = ls.length; i < n; i++) {
          const fn = ls[i]!;
          if (p.listeners?.[d.kind] !== ls && !p.listeners?.[d.kind].includes(fn)) continue;
          try {
            fn(e);
          } catch (err) {
            console.error(`[myco] Music onMusic("${d.kind}") listener threw:`, err);
          }
        }
      }
    }
  }
}

const NOOP = (): void => {};

/**
 * K5: `handle.onMusic(kind, fn)` on a music instance: adds `fn` to the player's listeners and its kind to `subscribed`;
 * the returned function removes it. A listener added during a dispatch first hears the next event (§1.2).
 */
export function subscribeMusic(player: MusicPlayer, kind: MusicKind, fn: (e: MusicEvent) => void): () => void {
  if (typeof fn !== "function" || player.state === "stopped") return NOOP;
  const ls = (player.listeners ??= { beat: [], bar: [], cue: [] });
  ls[kind] = [...ls[kind], fn];
  refreshSubscribed(player);
  let live = true;
  return () => {
    if (!live) return; // a second call does nothing
    live = false;
    const cur = player.listeners;
    if (!cur) return; // the instance ended: its listeners already went with it
    const at = cur[kind].indexOf(fn);
    if (at >= 0) cur[kind] = cur[kind].filter((_, i) => i !== at);
    refreshSubscribed(player);
  };
}

/** `subscribed` is the kinds that have a listener; a kind no hook and no listener wants leaves the mask (dispatch stops predicting it). */
function refreshSubscribed(player: MusicPlayer): void {
  const ls = player.listeners;
  player.subscribed = ls ? (ls.beat.length ? MusicSubscription.BEAT : 0) | (ls.bar.length ? MusicSubscription.BAR : 0) | (ls.cue.length ? MusicSubscription.CUE : 0) : 0;
}

/** `handle.onMusic` on any event handle (`Audio.ts`): a non-music handle returns a no-op function (§1.2). */
export function onMusicOf(instance: object, kind: MusicKind, fn: (e: MusicEvent) => void): () => void {
  const p = byInstance.get(instance);
  return p ? subscribeMusic(p, kind, fn) : NOOP;
}

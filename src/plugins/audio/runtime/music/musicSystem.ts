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
import { isPendingCoreBackend, onAudioBackendAttached, type AudioBackend, type MusicBackend } from "../backend";
import { onAudioSessionReleased } from "../audioSession";
import type { MusicEvent, MusicEventHandle, MusicKind } from "../../../../engine/audio/musicTypes";
import { GameBehavior } from "../../../../engine/core/Component";
import type { EventInstance } from "../events/eventRuntime";
import { segmentGrid } from "./segmentGrids";
import { entrySeconds } from "../../../../engine/audio/musicGrid";
import { applyReloads } from "./reload";
import { childFor, tickSwitch } from "./musicSwitch";
import { enterPlaylist, tickPlaylist } from "./playlist";
import { tickRegions } from "./regions";
import { tickTransition } from "./transition";
import { frameIntervalSeconds, planTick, requestStart } from "./planner";
import { tickLoopTails } from "./loopTail";
import { tickStingers } from "./stingers";
import { tickStems } from "./stems";
import { bindMusicBackend, updateBeatHolds } from "./background";
import { predictDue, seatBeats } from "./beatClock";
import { endPlayer, newMusicPlayer, refuseStart, type MusicPlayer } from "./musicPlayer";
import { taps } from "../mix/profileTaps";
import { NULL_PROFILE_SINK } from "../mix/profileSink";
import type { MusicNode } from "../../../../engine/audio/musicFormat";
import { musicChildById } from "../../../../engine/audio/musicTree";

export type { MusicCounters, MusicPlayer, MusicPlayerState } from "./musicPlayer";

/** K5: `handle.onMusic` listeners of one instance, in subscription order per kind. Copy on write: a subscribe or unsubscribe replaces the array, so a dispatch in progress walks the one it began with. */
interface MusicListeners {
  beat: readonly ((e: MusicEvent) => void)[];
  bar: readonly ((e: MusicEvent) => void)[];
  cue: readonly ((e: MusicEvent) => void)[];
}

/** K2, K5: one player's beat-callback subscriptions, the dispatch's own (no other module reads them). */
interface Subscriptions {
  /** K5: `handle.onMusic` listeners, by kind; null until the first subscription, and again once the instance ends. */
  listeners: MusicListeners | null;
  /** The subscription mask (bit 0 beat, 1 bar, 2 cue) of the listeners. */
  subscribed: number;
  /** K2: the component hooks' share of the mask, read from the source's node each dispatch. */
  hooks: number;
  /** K2: the mask the last dispatch predicted for; a bit that appears in `subscribed | hooks` seats its cursor first. */
  predicted: number;
  /** K2: the public handle `MusicEvent.handle` carries; made on first use by the factory `Audio.ts` registers. */
  eventHandle: MusicEventHandle | null;
}

/** Each live player's subscriptions (made with the player, dropped when it ends). */
const subs = new WeakMap<MusicPlayer, Subscriptions>();

/**
 * ADR 0248: what music reads of the backend, and all it reads: the heard time, the clock (horizon, frame interval, frame
 * map), the clip cache, the backend's automation and the voice path (a loop tail's voice). The music operations come
 * separately (`MusicFrame.music`); lifecycle moments arrive as events (`music/background.ts`), never as probed fields.
 */
export type MusicHost = Pick<AudioBackend, "time" | "clock" | "clipCache" | "automation" | "play">;

/** The host a frame holds before its first step: no clock, nothing plays. */
const NO_HOST: MusicHost = { time: 0, play: () => null };

/** What a step hands each player's tick. One object, rewritten each frame (nothing allocates per frame). */
export interface MusicFrame {
  readonly backend: MusicHost;
  /** `backend.music`, or null on a backend without music (the player then plays nothing and warns once). */
  readonly music: MusicBackend | null;
  /** This display frame's `Audio.time`, seconds. */
  readonly now: number;
  /** Game seconds since the last frame (0 while `Time.scale` is 0). */
  readonly dt: number;
  /** P9: true when the tick runs from the STATUS handler because the page is hidden (architecture §3.8). */
  readonly hidden: boolean;
}

/** Bits of a subscription mask (K2). */
const MusicSubscription = { BEAT: 1, BAR: 2, CUE: 4 } as const;

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

/** The cause-keyed counts `MusicDebugTotals` carries for main's own music counters (`Audio.debug().musicTotals`, ADR 0220). */
export interface MusicCounterTotals {
  replans: Record<string, number>;
  refusals: Record<string, number>;
  recoveries: Record<string, number>;
  stingers: { played: number; late: number; skipped: number; dropped: number };
}

const noCounterTotals = (): MusicCounterTotals => ({ replans: {}, refusals: {}, recoveries: {}, stingers: { played: 0, late: 0, skipped: 0, dropped: 0 } });

/** The counters of the music instances that ended this session, folded together so a total outlives its instance (ADR 0220). */
let retired = noCounterTotals();

const addInto = (into: Record<string, number>, from: Readonly<Record<string, number>>): void => {
  for (const [k, v] of Object.entries(from)) if (Number.isFinite(v)) into[k] = (into[k] ?? 0) + v;
};

function foldCounters(into: MusicCounterTotals, c: Readonly<MusicCounterTotals>): void {
  addInto(into.replans, c.replans);
  addInto(into.refusals, c.refusals);
  addInto(into.recoveries, c.recoveries);
  for (const k of ["played", "late", "skipped", "dropped"] as const) into.stingers[k] += c.stingers[k];
}

/**
 * Main's music counters summed over the audio session (ADR 0220): every instance that ended plus every one playing. The core
 * keeps no total of these and an instance's row goes when it ends, so this is what a total of re-plans, refusals, recoveries
 * or stingers reads. Cleared when the audio session is released. Allocates; debug only.
 */
export function musicCounterTotals(): MusicCounterTotals {
  const out = noCounterTotals();
  foldCounters(out, retired);
  for (const p of players) foldCounters(out, p.counters);
  return out;
}

/** True while any music instance plays: the steps do nothing otherwise. */
export function musicActive(): boolean {
  return players.length > 0;
}

/**
 * P6 calls this when `EventInstance.playNode` reaches a music root: the player starts in `starting`, and step 9's
 * planner (P2) primes and stamps its first segment. `at` is `Audio.play`'s option (heard seconds); omitted or non-finite:
 * as soon as possible. A second call for the same instance returns the existing player.
 */
export function createMusicPlayer(instance: EventInstance, root: MusicNode, options: { at?: number } = {}): MusicPlayer {
  const existing = byInstance.get(instance);
  if (existing) return existing;
  const at = options.at;
  const player = newMusicPlayer(instance, root, typeof at === "number" && Number.isFinite(at) ? at : Number.NaN);
  subs.set(player, { listeners: null, subscribed: 0, hooks: 0, predicted: 0, eventHandle: null });
  players.push(player);
  byInstance.set(instance, player);
  // Rc3: a player that began before a recorder did has no "first segment" to report when the recorder starts (the keyframe has its state).
  if (taps.sink === NULL_PROFILE_SINK) firstReported.add(player);
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
  foldCounters(retired, player.counters);
  endPlayer(player);
  subs.delete(player); // its listeners end with it
  backend?.music?.releaseInstance(player.instance.group);
}

/** A released audio session (ADR 0218) forgets every player: their Engines are gone, and so is anything they played. */
function forgetMusicPlayers(): void {
  for (const p of players) byInstance.delete(p.instance);
  players.length = 0;
  retired = noCounterTotals();
}
onAudioSessionReleased(forgetMusicPlayers);


// --- The frame steps -------------------------------------------------------------------------------------------------

const frame = { backend: NO_HOST, music: null as MusicBackend | null, now: 0, dt: 0, hidden: false };

function setFrame(backend: MusicHost, music: MusicBackend | null, dt: number, hidden: boolean): MusicFrame {
  frame.backend = backend;
  frame.music = music;
  frame.now = backend.time;
  frame.dt = dt;
  frame.hidden = hidden;
  return frame;
}

// ADR 0248: every backend the selector installs reports its group and lifecycle events to the music side.
onAudioBackendAttached(bindMusicBackend);

/**
 * Step 0, `engine.AudioMusic` (R17; `audioSystem.ts` calls it only in the World that has the view). Nothing without a
 * music player: no `beginFrame`, no allocation.
 */
export function musicEarlyStep(backend: AudioBackend, dt: number): void {
  if (isPendingCoreBackend(backend)) return; // F-35: see `musicPlanStep`
  // ADR 0248: a backend set without the selector (a rig's own) is bound here, music or not, so what it reports before the
  // first player (a hide, a rebuild) still arrives; the selector's are bound already. Idempotent, allocates nothing.
  bindMusicBackend(backend);
  if (players.length === 0) return;
  beginMusicFrame(backend);
  dispatchMusic(setFrame(backend, backend.music ?? null, dt, false));
}

/**
 * Step 9, the music plan (`engine.Audio`, before `frameCommit`). Nothing without a music player.
 *
 * F-35: nothing either while the backend is the pending stand-in (the core still loading, sound locked until the first
 * gesture). It has no clock and no music yet, but it isn't a backend without music, so nothing is refused: the players
 * wait in `starting` (the debug row's `priming`) as plain events wait as locked voices, and the first step on the
 * backend the load settles on plans their first start on its clock, as soon as the music can (R12). Only a resolved
 * backend without `music` refuses (the planner's one warning). Beat callbacks begin with the music (step 0 waits too).
 */
export function musicPlanStep(backend: AudioBackend, dt: number): void {
  if (players.length === 0 || isPendingCoreBackend(backend)) return;
  const f = setFrame(backend, backend.music ?? null, dt, false);
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
  if (taps.sink !== NULL_PROFILE_SINK) noteFirstSegment(player);
}

/** Players whose first segment `noteFirstSegment` reported (the later changes are `transition.ts`'s `commit`). */
const firstReported = new WeakSet<MusicPlayer>();

/** Rc3 (§5.6 `musicTransition`): the player's first segment began playing: a transition from nothing (`from` null). */
function noteFirstSegment(player: MusicPlayer): void {
  const run = player.run;
  if (run === null || firstReported.has(player)) return;
  firstReported.add(player);
  taps.sink.musicTransition(player.instance.group, null, run.node.id);
}

/** P9: the hidden-tab tick's frame (from the STATUS handler, architecture §3.8). */
export function hiddenFrame(backend: MusicHost, music: MusicBackend | null): MusicFrame {
  return setFrame(backend, music, 0, true);
}

// --- Owners' stubs ---------------------------------------------------------------------------------------------------

/**
 * P7: the early step's backend part: `backend.clock?.beginFrame()` (idempotent per rAF time) so `update()` reads this frame's
 * `Audio.time`, then this frame's group events from the status mirror (§6, R17). Runs only while music plays.
 */
export function beginMusicFrame(backend: AudioBackend): void {
  backend.clock?.beginFrame(); // advances the clock map and reads the status mirror (group events go to `onGroupEvent`)
  updateBeatHolds(backend.music ?? null); // Rh1: rhythm mode holds callbacks through a recovery, before the dispatch
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
  const child = id === null ? undefined : musicChildById(player.root, id);
  // P4: a playlist child (however nested) descends to its first playable leaf.
  const leaf = child ? enterPlaylist(player, child) : null;
  if (!child || !leaf) {
    refuseStart(player);
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
export function _setMusicHandleFactory(f: HandleFactory): void {
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
    const s = subs.get(p);
    if (p.state === "stopped" || !s) continue;
    s.hooks = hookMask(p);
    const mask = s.subscribed | s.hooks;
    const fresh = mask & ~s.predicted;
    s.predicted = mask;
    if (mask === 0) continue;
    if (fresh !== 0) {
      // From nothing: forget the whole backlog; one more kind among running ones: only that kind's.
      if ((mask & ~fresh) === 0) seatBeats(p, f.now);
      else for (const d of KINDS) if (fresh & d.bit) seatBeats(p, f.now, d.kind);
    }
    if (s.eventHandle === null && makeHandle) s.eventHandle = makeHandle(p.instance);
    for (const d of KINDS) {
      if (!(mask & d.bit)) continue;
      const e = scratch[d.kind];
      e.handle = s.eventHandle as MusicEventHandle;
      if (!predictDue(p, d.kind, f.now, interval, e)) continue;
      if (s.hooks & d.bit) deliverToComponents(p, d.hook, e);
      const ls = s.listeners?.[d.kind];
      if (ls) {
        // K5 (D15): walks the array as it stood at this event, so a listener added during the loop first hears the next
        // event; one unsubscribed during it (itself or a later one) is not called again, even this frame.
        for (let i = 0, n = ls.length; i < n; i++) {
          const fn = ls[i]!;
          if (s.listeners?.[d.kind] !== ls && !s.listeners?.[d.kind].includes(fn)) continue;
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
function subscribeMusic(player: MusicPlayer, kind: MusicKind, fn: (e: MusicEvent) => void): () => void {
  const s = subs.get(player);
  if (typeof fn !== "function" || player.state === "stopped" || !s) return NOOP;
  const ls = (s.listeners ??= { beat: [], bar: [], cue: [] });
  ls[kind] = [...ls[kind], fn];
  refreshSubscribed(s);
  let live = true;
  return () => {
    if (!live) return; // a second call does nothing
    live = false;
    const cur = s.listeners;
    if (!cur || !subs.has(player)) return; // the instance ended: its listeners already went with it
    const at = cur[kind].indexOf(fn);
    if (at >= 0) cur[kind] = cur[kind].filter((_, i) => i !== at);
    refreshSubscribed(s);
  };
}

/** `subscribed` is the kinds that have a listener; a kind no hook and no listener wants leaves the mask (dispatch stops predicting it). */
function refreshSubscribed(s: Subscriptions): void {
  const ls = s.listeners;
  s.subscribed = ls ? (ls.beat.length ? MusicSubscription.BEAT : 0) | (ls.bar.length ? MusicSubscription.BAR : 0) | (ls.cue.length ? MusicSubscription.CUE : 0) : 0;
}

/** `handle.onMusic` on any event handle (`Audio.ts`): a non-music handle returns a no-op function (§1.2). */
export function onMusicOf(instance: object, kind: MusicKind, fn: (e: MusicEvent) => void): () => void {
  const p = byInstance.get(instance);
  return p ? subscribeMusic(p, kind, fn) : NOOP;
}

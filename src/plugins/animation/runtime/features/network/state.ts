// Each networked Animator's network state (ADR 0370 "Networking"; T33), and what the graph runtime tells it
// (`slotNetHooks`, filled by `register.ts`):
//
// - **Slot plays are tracked by tick.** A play asked for in a networked World is stamped with the tick it was asked
//   for on (`NetSession.simulatedTick`: the server's tick, or the tick the owning client is predicting or
//   re-simulating). Servers replicate their tracks; the owner's predicted ghost keeps its own, which
//   `animation.PredictedRootMotion` samples and `client.ts` reconciles with the server's. A re-simulated tick asking
//   again for a play it already made gets that play back (its promise), not a second play.
// - **A server's interpolated ghost** replicates the tick the core started a play on instead (`slotPlayStarted`), and
//   stops and links are stamped with the tick they reach the core on, so clients do each in step with the server.
// - While the network feature itself queues a replicated play, the hooks stand aside.
import { netSession } from "../../../../../engine/net/session";
import type { Animator } from "../../components/Animator";
import type { AnimationPlayResult } from "../../types";
import type { SlotPlayAdmission, SlotPlayRecord, SlotSection } from "../graph/runtime";
import { slotPlaySection } from "../graph/runtime";
import { animatorRuntime, clipEntry, type AnimatorRuntime } from "../instances";
import { replicatedOf, roleOf, sessionOf } from "./ghosts";
import type { NetLink, NetParameters, NetSlot, NetState } from "./wire";

/** @internal A slot play the network feature follows: this World's own, or a replicated one it started (`remote`). */
export interface SlotTrack {
  readonly slot: string;
  readonly clip: string;
  /**
   * Its start tick (the server's for a replicated play): the tick it was asked for on, or, for a server's
   * interpolated ghost, the tick the core started it on (`slotPlayStarted`), so clients start it in step.
   */
  tick: number;
  readonly speed: number;
  readonly loop: boolean;
  readonly fade: number;
  /** The section as asked for, resolved to clip seconds (`start`, `end`; end 0: the clip's end) once the clip loads. */
  readonly section: SlotSection;
  readonly normalizedTime: number;
  start: number;
  end: number;
  /** 0: not resolved yet; 1: resolved; -1: can't play (no clip, no such cue). */
  resolved: 0 | 1 | -1;
  /** The tick a stop was asked for on (-1: none), and its fade. */
  stopTick: number;
  stopFade: number;
  /** The core play made for it here (null: none, as for a replicated play adopted after it ended). */
  play: SlotPlayRecord | null;
  /** It came from the server (replicated, or adopted by the owner's prediction). */
  readonly remote: boolean;
}

/** @internal One Animator's network state. */
export interface NetAnimator {
  readonly rt: AnimatorRuntime;
  /** The latest play per slot (by slot name). */
  readonly slots: Map<string, SlotTrack>;
  // ---- server
  /** Run-time link choices, by linked-graph node. */
  readonly links: Map<string, NetLink>;
  /** Each layer machine's state and the tick it was entered on, by machine index. */
  readonly states: Map<number, { state: number; tick: number }>;
  paramKey: string;
  paramTick: number;
  // ---- client
  /** The replicated strings last decoded. */
  readonly seen: { states: string; params: string; slots: string; links: string };
  remoteStates: NetState[];
  remoteSlots: NetSlot[];
  remoteLinks: NetLink[];
  /** Received parameter sets not yet applied (interpolated ghosts apply each at its tick). */
  readonly pendingParams: NetParameters[];
  /** The value last applied per parameter (JSON), so only changes are written. */
  readonly appliedParams: Map<number, string>;
  /** The graph last applied per linked-graph node. */
  readonly appliedLinks: Map<string, string | null>;
  /** Per layer machine: the interpolation tick a difference from the server's state was first seen at. */
  readonly mismatch: Map<number, number>;
  /** Replicated plays (by `slotKey`) handled: started, or skipped as already over; and stopped. */
  readonly started: Set<string>;
  readonly stopped: Set<string>;
}

const animators = new WeakMap<AnimatorRuntime, NetAnimator>();

/** @internal `rt`'s network state (made on first use). */
export function netAnimator(rt: AnimatorRuntime): NetAnimator {
  let na = animators.get(rt);
  if (!na) {
    na = {
      rt,
      slots: new Map(),
      links: new Map(),
      states: new Map(),
      paramKey: "",
      paramTick: 0,
      seen: { states: "", params: "", slots: "", links: "" },
      remoteStates: [],
      remoteSlots: [],
      remoteLinks: [],
      pendingParams: [],
      appliedParams: new Map(),
      appliedLinks: new Map(),
      mismatch: new Map(),
      started: new Set(),
      stopped: new Set(),
    };
    animators.set(rt, na);
  }
  return na;
}

/** @internal `rt`'s network state if it has one. */
export function existingNetAnimator(rt: AnimatorRuntime): NetAnimator | null {
  return animators.get(rt) ?? null;
}

/** @internal A replicated slot play's identity. */
export const slotKey = (slot: string, clip: string, tick: number): string => `${slot}\u0000${clip}\u0000${tick}`;

/**
 * @internal Resolves `track`'s section to clip seconds once its clip has loaded (a track made from a replicated play
 * comes resolved). True when it is resolved and can play.
 */
export function resolveTrack(track: SlotTrack, animator: Animator): boolean {
  if (track.resolved === 0 && track.play) {
    const range = slotPlaySection(animator, track.play);
    if (range === null) track.resolved = -1;
    else if (range) {
      track.start = range.start;
      track.end = range.end;
      track.resolved = 1;
    }
  }
  return track.resolved === 1;
}

/** @internal The track's last clip second: its section's end, or the clip's end (Infinity while the clip loads). */
export function trackEnd(track: SlotTrack, rt: AnimatorRuntime): number {
  if (track.end > track.start) return track.end;
  return clipEntry(rt, track.clip).info?.duration ?? Number.POSITIVE_INFINITY;
}

/** @internal The replicated form of a resolved track. */
export function toNetSlot(t: SlotTrack): NetSlot {
  return { slot: t.slot, clip: t.clip, tick: t.tick, start: t.start, end: t.end, speed: t.speed, loop: t.loop, fade: t.fade, stopTick: t.stopTick, stopFade: t.stopFade };
}

// ------------------------------------------------------------------------------------------------ hooks

let applying = 0;

/** Runs `fn` with the hooks standing aside: the network feature queueing replicated state itself. */
function applyingReplicated<T>(fn: () => T): T {
  applying++;
  try {
    return fn();
  } finally {
    applying--;
  }
}

let lastQueued: SlotPlayRecord | null = null;

/** @internal Queues a replicated slot play (hooks standing aside) and returns its record, or null when it was refused. */
export function queueReplicatedPlay(queue: () => unknown): SlotPlayRecord | null {
  lastQueued = null;
  applyingReplicated(queue);
  const play = lastQueued as SlotPlayRecord | null;
  lastQueued = null;
  return play;
}

const FINISHED: AnimationPlayResult = Object.freeze({ reason: "finished" });

/** @internal `slotNetHooks.admit`. */
export function admitSlotPlay(animator: Animator, slot: string, clip: string, explicit: { readonly tick: number; readonly offset: number } | undefined, speed: number): SlotPlayAdmission {
  if (explicit) return explicit;
  const rt = animatorRuntime(animator);
  const session = rt ? sessionOf(rt.world) : null;
  if (!rt || !session) return { tick: -1, offset: 0 };
  const tick = session.simulatedTick;
  if (roleOf(rt, session) !== "predicted") return { tick, offset: 0 };
  // The owner's prediction: a re-simulated tick asks again for what it already played.
  const known = animators.get(rt)?.slots.get(slot);
  if (known && known.clip === clip && known.tick === tick) return known.play?.promise ?? Promise.resolve(FINISHED);
  // Played for a tick before the present one (re-simulation after a correction): it starts that much in.
  const late = Math.max(0, session.time.serverTick - tick) * rt.world.time.fixedDeltaTime * speed;
  return { tick, offset: late };
}

/** @internal `slotNetHooks.queued`: servers and the owner's prediction track the plays asked for. */
export function slotPlayQueued(animator: Animator, play: SlotPlayRecord): void {
  lastQueued = play;
  if (applying) return;
  const rt = animatorRuntime(animator);
  const session = rt ? sessionOf(rt.world) : null;
  if (!rt || !session) return;
  const role = roleOf(rt, session);
  if (role !== "server" && role !== "predicted") return;
  netAnimator(rt).slots.set(play.slot, {
    slot: play.slot,
    clip: play.clip.path,
    tick: play.tick,
    speed: play.speed,
    loop: play.loop,
    fade: play.fade,
    section: play.section,
    normalizedTime: play.normalizedTime,
    start: 0,
    end: 0,
    resolved: 0,
    stopTick: -1,
    stopFade: 0,
    play,
    remote: false,
  });
}

/**
 * @internal `slotNetHooks.started`: a server's interpolated ghost replicates the tick the core started a play on (a
 * play asked for between frames, or in update with fixed-mode evaluation, starts a tick later than it was asked for).
 * Predicted ghosts keep the tick it was asked for on, which the owner predicted with.
 */
export function slotPlayStarted(animator: Animator, play: SlotPlayRecord): void {
  if (applying) return;
  const rt = animatorRuntime(animator);
  const session = rt ? sessionOf(rt.world) : null;
  const track = rt ? animators.get(rt)?.slots.get(play.slot) : undefined;
  if (!rt || !session?.isServer || track?.play !== play || replicatedOf(rt)?.mode === "predicted") return;
  track.tick = session.simulatedTick;
}

/**
 * @internal `slotNetHooks.stopped`: a stop sent to the core ends the plays it reaches (those the core has started; a
 * play queued after the stop comes after it) at this tick.
 */
export function slotStopped(animator: Animator, slot: string | null, fade: number): void {
  const rt = animatorRuntime(animator);
  const session = rt ? sessionOf(rt.world) : null;
  const na = rt ? animators.get(rt) : undefined;
  if (!rt || !session || !na) return;
  const role = roleOf(rt, session);
  if (role !== "server" && role !== "predicted") return;
  const tick = session.simulatedTick;
  for (const t of na.slots.values()) {
    if ((slot === null || t.slot === slot) && t.stopTick < 0 && t.tick <= tick && (!t.play || t.play.id !== 0)) {
      t.stopTick = tick;
      t.stopFade = fade;
    }
  }
}

/** @internal `slotNetHooks.linked`: servers replicate run-time link choices. */
export function linkChosen(animator: Animator, node: string, path: string | null): void {
  const rt = animatorRuntime(animator);
  const session = rt ? netSession(rt.world) : null;
  if (!rt || !session?.isServer || roleOf(rt, session) !== "server") return;
  netAnimator(rt).links.set(node, { node, graph: path, tick: session.simulatedTick });
}

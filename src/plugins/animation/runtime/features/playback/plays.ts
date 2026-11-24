// Code-first plays on the implicit graph (ADR 0372; T17): what `play`, `crossfade` and `stop` queue, how the gather stage
// turns the queue into core commands, and how the apply stage resolves play promises from the core's state-change
// records. Every play promise resolves exactly once and never rejects:
//
// - `finished`: the core reported the play reached its end (`CHANGE_FINISHED`; looping plays never finish);
// - `interrupted`: another play on its layer took over (`CHANGE_INTERRUPTED`);
// - `stopped`: `stop` faded its layer out (the core reports that as an interruption; the host knows it asked), the
//   Animator was deactivated or destroyed, its clip couldn't load, or the core refused the command (with a warning).
//
// Commands keep call order per Animator: a play whose clip is still loading holds back the commands queued after it,
// so a later play never lands before an earlier one.
import type { AnimationFrame } from "../../stages/frame";
import type { AnimationPlayEndReason, AnimationPlayResult, AnimatorStateInfo } from "../../types";
import { CHANGE_FINISHED, CHANGE_INTERRUPTED, CHANGE_REFUSED, PLAY, PLAY_LOOP, PLAY_ONCE, SET_LAYER, STATE_CHANGE, STOP } from "../../wasm/wire/core";
import type { RecordFields } from "../../core/records";
import { clipEntry, playsOf, skeletonProfileOf, type AnimatorRuntime, type ClipEntry } from "../instances";
import { acquireMask } from "../graph/masks";

/** @internal One play of a clip on a layer. */
export interface PlayRecord {
  /** The id the core echoes in the play's state changes (0 until sent). */
  id: number;
  readonly rt: AnimatorRuntime;
  readonly layer: number;
  readonly clip: ClipEntry;
  /** The clip as the caller named it (`state().name`). */
  readonly name: string;
  readonly speed: number;
  readonly fade: number;
  /** Start, normalised (0–1). */
  readonly startNormalized: number;
  /** Clip seconds the start moves on by (a musical play released late, T72; negative playing backward). */
  readonly startShift: number;
  /** Loop override; undefined: the clip's own setting. */
  readonly loop: boolean | undefined;
  readonly promise: Promise<AnimationPlayResult>;
  readonly resolve: (result: AnimationPlayResult) => void;
  done: boolean;
  /** `stop` asked for its layer: an interruption now means `stopped`. */
  stopping: boolean;
  /** Seconds it has played (the Animator's clock), for `state()`. */
  elapsed: number;
}

/** @internal What waits in an Animator's queue for the gather stage. */
export type PlayCommand =
  | { readonly kind: "play"; readonly play: PlayRecord }
  | { readonly kind: "stop"; readonly layers: readonly number[]; readonly fade: number }
  | { readonly kind: "mask"; readonly layer: number; readonly path: string };

/** @internal Options of a queued play, already resolved to numbers. */
export interface PlaySpec {
  readonly layer: number;
  readonly fade: number;
  readonly speed: number;
  readonly startNormalized: number;
  /** Clip seconds added to the start (default 0): musical timing's late or hit-aligned start (T72). */
  readonly startShift?: number;
  readonly loop: boolean | undefined;
}

const STOPPED: AnimationPlayResult = Object.freeze({ reason: "stopped" });

/** Play ids, page-wide (u32, never 0). */
let nextPlayId = 1;

/** @internal A play promise already resolved with `stopped`. */
export function stoppedPlay(): Promise<AnimationPlayResult> {
  return Promise.resolve(STOPPED);
}

/** @internal Queues a play of `clip` on `rt`; the clip starts loading now. */
export function queuePlay(rt: AnimatorRuntime, clip: string, spec: PlaySpec): PlayRecord {
  let resolve!: (r: AnimationPlayResult) => void;
  const promise = new Promise<AnimationPlayResult>((r) => (resolve = r));
  const play: PlayRecord = {
    id: 0,
    rt,
    layer: spec.layer,
    clip: clipEntry(rt, clip),
    name: clip,
    speed: spec.speed,
    fade: Math.max(0, spec.fade),
    startNormalized: spec.startNormalized,
    startShift: Number.isFinite(spec.startShift) ? spec.startShift! : 0,
    loop: spec.loop,
    promise,
    resolve,
    done: false,
    stopping: false,
    elapsed: 0,
  };
  rt.queue.push({ kind: "play", play });
  rt.latest = play;
  return play;
}

/** @internal `Animator.defaultClip` on activation: a plain play on layer 0. */
export function queueDefaultClip(rt: AnimatorRuntime, clip: string): void {
  queuePlay(rt, clip, { layer: 0, fade: 0, speed: 1, startNormalized: 0, loop: undefined });
}

/** @internal Queues mask `path` (`*.mask.json`) for implicit-graph layer `layer` (1–3), ahead of what is queued after it (T32). */
export function queueLayerMask(rt: AnimatorRuntime, layer: number, path: string): void {
  rt.queue.push({ kind: "mask", layer, path });
}

/**
 * The mask entry of `path` for `rt`'s Skeleton, loading it on first use (held in `rt.clips` under a mask key, so it is
 * released with the clips); null when the Animator has no Skeleton (nothing to mask).
 */
function maskEntry(rt: AnimatorRuntime, path: string): ClipEntry | null {
  const s = rt.skeleton;
  if (!s?.info || !rt.ns) return null;
  const key = `\u0000mask\u0000${path}\u0000${s.path}`;
  let entry = rt.clips.get(key);
  if (entry) return entry;
  const e: ClipEntry = { path, skeleton: s.path, handle: undefined, info: null };
  rt.clips.set(key, e);
  const ns = rt.ns;
  void acquireMask(ns, path, { path: s.path, info: s.info, profile: skeletonProfileOf(s) }).then((handle) => {
    if (rt.detached || rt.clips.get(key) !== e) {
      if (handle) ns.release(handle);
      return;
    }
    e.handle = handle;
  });
  entry = e;
  return entry;
}

/** @internal Queues a stop of `layers`, fading out over `fade` seconds. */
export function queueStop(rt: AnimatorRuntime, layers: readonly number[], fade: number): void {
  rt.queue.push({ kind: "stop", layers, fade: Math.max(0, fade) });
}

function end(play: PlayRecord, reason: AnimationPlayEndReason): void {
  if (play.done) return;
  play.done = true;
  if (play.id) playsOf(play.rt.world).delete(play.id);
  play.resolve(reason === "stopped" ? STOPPED : { reason });
}

/** @internal Ends every play of `rt`, queued or showing, with `reason` (deactivation, destruction, a lost Skeleton). */
export function endAllPlays(rt: AnimatorRuntime, reason: AnimationPlayEndReason): void {
  for (const cmd of rt.queue.splice(0)) if (cmd.kind === "play") end(cmd.play, reason);
  for (let l = 0; l < rt.layers.length; l++) {
    const p = rt.layers[l];
    if (p) end(p, reason);
    rt.layers[l] = null;
  }
  // Plays sent but replaced on the host before the core reported the interruption.
  for (const p of playsOf(rt.world).values()) if (p.rt === rt) end(p, reason);
}

/**
 * @internal Gather: turns `rt`'s queue into `PLAY` and `STOP` commands on the World's command writer, in order, up to the
 * first play whose clip is still loading.
 */
export function flushQueue(frame: AnimationFrame, rt: AnimatorRuntime): void {
  const instance = rt.instance;
  const plays = playsOf(rt.world);
  while (rt.queue.length) {
    const cmd = rt.queue[0]!;
    if (cmd.kind === "play") {
      const play = cmd.play;
      if (play.done) {
        rt.queue.shift();
        continue;
      }
      if (play.clip.handle === undefined) return; // still loading: later commands wait behind it
      rt.queue.shift();
      if (!play.clip.handle) {
        end(play, "stopped");
        continue;
      }
      const duration = play.clip.info?.duration ?? 0;
      const flags = play.loop === undefined ? 0 : play.loop ? PLAY_LOOP : PLAY_ONCE;
      play.id = nextPlayId;
      nextPlayId = nextPlayId >= 0xffffffff ? 1 : nextPlayId + 1;
      plays.set(play.id, play);
      frame.core.commands.put(PLAY, {
        instance,
        clip: play.clip.handle,
        playId: play.id,
        layer: play.layer,
        fade: play.fade,
        speed: play.speed,
        start: Math.min(duration, Math.max(0, Math.min(1, Math.max(0, play.startNormalized)) * duration + play.startShift)),
        flags,
      });
      rt.layers[play.layer] = play;
    } else if (cmd.kind === "mask") {
      const mask = maskEntry(rt, cmd.path);
      if (mask && mask.handle === undefined) return; // still loading: later commands wait behind it
      rt.queue.shift();
      if (mask?.handle) frame.core.commands.put(SET_LAYER, { instance, layer: cmd.layer, mask: mask.handle, mode: 0 });
    } else {
      rt.queue.shift();
      for (const layer of cmd.layers) {
        frame.core.commands.put(STOP, { instance, layer, fade: cmd.fade, flags: 0 });
        const showing = rt.layers[layer];
        if (showing) {
          showing.stopping = true;
          rt.layers[layer] = null;
        }
      }
    }
  }
}

const change = {} as RecordFields<typeof STATE_CHANGE>;
let warnedRefused = false;

/** @internal Apply: resolves the plays the core's state-change records name (this World's, since its `write_inputs`). */
export function resolveStateChanges(frame: AnimationFrame): void {
  const core = frame.core.core;
  const plays = playsOf(frame.world);
  const n = core.stateChangeCount();
  for (let i = 0; i < n; i++) {
    core.stateChange(i, change);
    const play = plays.get(change.playId);
    if (!play || play.rt.instance !== change.instance) continue;
    if (change.kind === CHANGE_FINISHED) end(play, "finished");
    else if (change.kind === CHANGE_INTERRUPTED) end(play, play.stopping ? "stopped" : "interrupted");
    else if (change.kind === CHANGE_REFUSED) {
      if (!warnedRefused) {
        warnedRefused = true;
        console.warn(`[myco] ${play.rt.animator.node.name}: the animation core refused a play of "${play.name}" (status ${change.status}).`);
      }
      end(play, "stopped");
    } else continue;
    if (play.rt.layers[play.layer] === play && change.kind !== CHANGE_FINISHED) play.rt.layers[play.layer] = null;
  }
}

/** @internal Apply: advances the clocks `state()` reads by the Animator's step (`dt`, its mode's). */
export function advancePlays(rt: AnimatorRuntime, dt: number): void {
  for (const p of rt.layers) if (p && p.id) p.elapsed += dt;
}

const EMPTY_STATE: AnimatorStateInfo = Object.freeze({ name: "", time: 0, normalizedTime: 0, weight: 0, transitioningTo: null });

/** @internal What `Animator.state(layer)` reports for the implicit graph: the play showing on the layer. */
export function layerState(rt: AnimatorRuntime | null, layer: number): AnimatorStateInfo {
  const p = rt?.layers[layer];
  if (!p) return EMPTY_STATE;
  const info = p.clip.info;
  const duration = info?.duration ?? 0;
  const looping = p.loop ?? info?.looping ?? false;
  let normalizedTime = 0;
  if (duration > 0) {
    normalizedTime = p.startNormalized + (p.startShift + p.elapsed * p.speed) / duration;
    if (!looping) normalizedTime = Math.min(1, Math.max(0, normalizedTime));
  }
  return {
    name: p.name,
    time: p.elapsed,
    normalizedTime,
    weight: p.fade > 0 ? Math.min(1, p.elapsed / p.fade) : 1,
    transitioningTo: null,
  };
}

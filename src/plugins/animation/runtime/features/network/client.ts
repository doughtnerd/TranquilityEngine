// Clients apply their ghosts' replicated Animator state (ADR 0370 "Networking"; T33), from `animation.Gather`
// (`stages/gather/network.ts`, first, so local commands land on top). Poses are never sent: the client's own graph
// re-evaluates from the replicated inputs, and is corrected only where it differs (Unreal's and Unity Netcode's
// approach), never snapped every tick.
//
// **Interpolated ghosts** live at the interpolation tick (`time.network.interpolationTick` + fraction), as their
// transforms do: each change applies when that tick reaches the server tick it was made on.
// - Parameters declared `replicate` are set when their value changes.
// - Each layer machine's state: when the client's machine is in another state for `GRACE_SECONDS` after the server
//   entered its state (so a transition the replicated parameters drive locally isn't fought), it jumps there (once per
//   difference; again only if it drifts away again).
// - Slot plays start at their start tick; one that started earlier (a late join, a load) starts that far into its
//   section, and one already over or stopped isn't played. Stops apply at their tick.
// - Link choices apply at their tick.
//
// **The owner's predicted ghost** keeps its own graph running as cosmetic state (locomotion follows predicted gameplay,
// never rolled back): replicated parameters not declared `predicted` and link choices apply at once, and only slot
// plays are reconciled, with their start ticks (the hybrid model):
// - a play it predicted that the server doesn't show once the server's snapshots have passed its tick (by
//   `RECONCILE_MARGIN_TICKS`) is dropped, and stopped;
// - a server play it lacks (or that differs in clip at the same tick) is adopted, started as far in as the present
//   predicted tick is past its start; `animation.PredictedRootMotion` samples it from its start tick on, so
//   re-simulated ticks move the character as the server did.
import type { AnimationFrame } from "../../stages/frame";
import type { Animator } from "../../components/Animator";
import { Quaternion, Vector2, Vector3 } from "../../../../../engine/core/math";
import type { NetSession } from "../../../../../engine/net/session";
import { clientReplication } from "../../../../../engine/net/replication/client";
import type { GraphMeta } from "../graph/asset";
import { graphMeta, graphState, queueJump, queueLink, queueSlotPlay, queueSlotStop, setParameter } from "../graph/runtime";
import { animatorsOf, clipEntry, type AnimatorRuntime } from "../instances";
import { roleOf, sessionOf } from "./ghosts";
import { applyingReplicated, netAnimator, queueReplicatedPlay, slotKey, trackEnd, type NetAnimator, type SlotTrack } from "./state";
import { decodeLinks, decodeParameters, decodeSlots, decodeStates, type NetParameterValue, type NetSlot } from "./wire";

/** How long a client's state machine may differ from the server's before it jumps (interpolated ghosts). */
export const GRACE_SECONDS = 0.1;
/** Snapshot ticks past a predicted play's tick after which the server not showing it means it didn't happen. */
export const RECONCILE_MARGIN_TICKS = 3;

/** Decodes the strings that changed since the last look. */
function read(na: NetAnimator, a: Animator): void {
  const seen = na.seen;
  if (a.netStates !== seen.states) na.remoteStates = decodeStates((seen.states = a.netStates));
  if (a.netSlots !== seen.slots) na.remoteSlots = decodeSlots((seen.slots = a.netSlots));
  if (a.netLinks !== seen.links) na.remoteLinks = decodeLinks((seen.links = a.netLinks));
  if (a.netParameters !== seen.params) {
    const p = decodeParameters((seen.params = a.netParameters));
    if (p) na.pendingParams.push(p);
  }
}

function parameterValue(meta: GraphMeta, index: number, v: NetParameterValue): number | boolean | Vector2 | Vector3 | Quaternion | null {
  const type = meta.paramTypes[index];
  if (typeof v !== "object") return (type === "bool") === (typeof v === "boolean") ? v : null;
  if (type === "vec2" && v.length === 2) return new Vector2(v[0]!, v[1]!);
  if (type === "vec3" && v.length === 3) return new Vector3(v[0]!, v[1]!, v[2]!);
  if (type === "quat" && v.length === 4) return new Quaternion(v[0]!, v[1]!, v[2]!, v[3]!);
  return null;
}

/** Applies the newest parameter set due by `now` (null: the newest received), leaving out `predicted` ones when `owner`. */
function applyParameters(na: NetAnimator, a: Animator, meta: GraphMeta, now: number | null, owner: boolean): void {
  let due = -1;
  for (let i = 0; i < na.pendingParams.length; i++) if (now === null || na.pendingParams[i]!.tick <= now) due = i;
  if (due < 0) return;
  const p = na.pendingParams[due]!;
  na.pendingParams.splice(0, due + 1);
  for (const [index, v] of p.values) {
    const flags = meta.paramReplication[index];
    if (!flags?.replicate || (owner && flags.predicted)) continue;
    const key = JSON.stringify(v);
    if (na.appliedParams.get(index) === key) continue;
    const value = parameterValue(meta, index, v);
    if (value === null) continue;
    na.appliedParams.set(index, key);
    setParameter(a, index, value);
  }
}

function applyLinks(na: NetAnimator, a: Animator, now: number | null): void {
  for (const l of na.remoteLinks) {
    if (now !== null && l.tick > now) continue;
    if (na.appliedLinks.has(l.node) && na.appliedLinks.get(l.node) === l.graph) continue;
    na.appliedLinks.set(l.node, l.graph);
    queueLink(a, l.node, l.graph);
  }
}

/** Interpolated ghosts: each layer machine follows the server's state, jumping only after a lasting difference. */
function applyStates(na: NetAnimator, a: Animator, meta: GraphMeta, now: number, grace: number): void {
  for (const s of na.remoteStates) {
    const m = meta.machines[s.machine];
    const target = m?.states[s.state];
    if (!m || m.layer === null || target === undefined || now < s.tick) continue;
    const info = graphState(a, m.layer);
    if ((info.transitioningTo ?? info.name) === target || info.name === "") {
      na.mismatch.delete(s.machine);
      continue;
    }
    const since = na.mismatch.get(s.machine);
    if (since === undefined) na.mismatch.set(s.machine, now);
    else if (now - since >= grace) {
      queueJump(a, target, m.layer);
      na.mismatch.set(s.machine, now);
    }
  }
}

/** Starts the replicated play `e` here, `elapsed` seconds after its start tick; null when it is already over. */
function startRemote(rt: AnimatorRuntime, e: NetSlot, elapsed: number): SlotTrack | null {
  const offset = Math.max(0, elapsed) * e.speed;
  const track: SlotTrack = { slot: e.slot, clip: e.clip, tick: e.tick, speed: e.speed, loop: e.loop, fade: e.fade, section: { start: e.start, end: e.end > e.start ? e.end : undefined }, normalizedTime: 0, start: e.start, end: e.end, resolved: 1, stopTick: e.stopTick, stopFade: e.stopFade, play: null, remote: true };
  const over = !e.loop && e.start + offset >= trackEnd(track, rt);
  if (over) return null;
  track.play = queueReplicatedPlay(() => queueSlotPlay(rt.animator, e.clip, { slot: e.slot, fade: e.fade, speed: e.speed, loop: e.loop, section: track.section, normalizedTime: 0 }, { tick: e.tick, offset }));
  return track;
}

/** Interpolated ghosts: replicated plays start (and stop) at their ticks. */
function applySlots(na: NetAnimator, rt: AnimatorRuntime, now: number, dt: number): void {
  for (const e of na.remoteSlots) {
    const key = slotKey(e.slot, e.clip, e.tick);
    if (!na.started.has(key)) {
      if (e.tick > now) continue;
      na.started.add(key);
      if (e.stopTick >= 0 && e.stopTick <= now) continue; // stopped before it showed here
      clipEntry(rt, e.clip); // starts loading a clip seen for the first time
      const track = startRemote(rt, e, (now - e.tick) * dt);
      if (track) na.slots.set(e.slot, track);
      continue;
    }
    if (e.stopTick >= 0 && e.stopTick <= now && !na.stopped.has(key)) {
      na.stopped.add(key);
      const track = na.slots.get(e.slot);
      if (track && track.tick === e.tick && track.clip === e.clip && track.play && !track.play.done) applyingReplicated(() => queueSlotStop(rt.animator, e.slot, e.stopFade));
    }
  }
}

/** The owner's predicted ghost: reconciles its predicted slot plays (and their start ticks) with the server's. */
function reconcileSlots(na: NetAnimator, rt: AnimatorRuntime, session: NetSession, dt: number): void {
  const newest = clientReplication(rt.world)?.newestTick ?? -1;
  const present = session.time.serverTick;
  for (const t of [...na.slots.values()]) {
    if (t.remote || newest < t.tick + RECONCILE_MARGIN_TICKS) continue;
    if (na.remoteSlots.some((e) => e.slot === t.slot && e.clip === t.clip && e.tick === t.tick)) continue;
    // The server has simulated past it and didn't play it: a misprediction.
    na.slots.delete(t.slot);
    if (t.play && !t.play.done) applyingReplicated(() => queueSlotStop(rt.animator, t.slot, t.fade));
  }
  for (const e of na.remoteSlots) {
    const local = na.slots.get(e.slot);
    if (local && local.clip === e.clip && local.tick === e.tick) {
      if (e.stopTick >= 0 && local.stopTick !== e.stopTick) {
        local.stopTick = e.stopTick;
        local.stopFade = e.stopFade;
        if (local.play && !local.play.done) applyingReplicated(() => queueSlotStop(rt.animator, e.slot, e.stopFade));
      }
      continue;
    }
    if (local && local.tick > e.tick) continue; // a newer prediction: it waits for its own confirmation
    clipEntry(rt, e.clip);
    const stopped = e.stopTick >= 0 && e.stopTick <= present;
    const track = stopped ? null : startRemote(rt, e, (present - e.tick) * dt);
    na.slots.set(e.slot, track ?? { slot: e.slot, clip: e.clip, tick: e.tick, speed: e.speed, loop: e.loop, fade: e.fade, section: { start: e.start, end: e.end }, normalizedTime: 0, start: e.start, end: e.end, resolved: 1, stopTick: e.stopTick, stopFade: e.stopFade, play: null, remote: true });
  }
}

/** @internal Clients: apply the replicated state of `frame`'s ghost Animators. */
export function applyReplicated(frame: AnimationFrame): void {
  const session = sessionOf(frame.world);
  if (!session?.isClient) return;
  const time = session.time;
  const now = time.interpolationTick + time.interpolationFraction;
  const dt = frame.world.time.fixedDeltaTime;
  const grace = GRACE_SECONDS * session.tickRate;
  for (const rt of animatorsOf(frame.world)) {
    const a = rt.animator;
    if ((a.updateMode === "fixed") !== frame.fixed || !rt.instance) continue;
    const role = roleOf(rt, session);
    if (role !== "interpolated" && role !== "predicted") continue;
    const meta = graphMeta(a);
    if (!meta) continue;
    const na = netAnimator(rt);
    read(na, a);
    if (role === "interpolated") {
      applyParameters(na, a, meta, now, false);
      applyLinks(na, a, now);
      applyStates(na, a, meta, now, grace);
      applySlots(na, rt, now, dt);
    } else {
      applyParameters(na, a, meta, null, true);
      applyLinks(na, a, null);
      reconcileSlots(na, rt, session, dt);
    }
  }
}

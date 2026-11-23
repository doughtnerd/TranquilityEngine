// `animation.PredictedRootMotion`'s work (ADR 0370's hybrid model; T33). Root-motion one-shots played in a slot move a
// predicted character by their clip's extracted root curve, sampled per tick from the play's start tick, through the
// CharacterController's `move` (the physics plugin's kinematic sweeps against the current world) or, with
// `rootMotion: "transform"`, the Transform. No physics stepping and no graph replay: the delta for tick T depends only
// on the play (clip, start tick, section, speed) and T, so a server and its owning client get the same numbers, and a
// re-simulated tick gets them again.
//
// - Tick T moves the root from clip time `start + (T − 1 − startTick)·dt·speed` to `start + (T − startTick)·dt·speed`
//   (clamped to the section's end): the start tick itself doesn't move, so it doesn't matter whether gameplay asked
//   for the play before or after this system ran in that tick.
// - It runs on servers for their `"predicted"` ghosts each fixed step, and on the owning client once per predicted tick
//   (the step's pass, catch-up and re-simulated ticks); the core's root delta isn't applied to those as well (D92).
// - Looping sections give no predicted root motion (one-shots only); a stop ends it at the stop's tick.
import { Quaternion, Vector3 } from "../../../../../engine/core/math";
import type { Component } from "../../../../../engine/core/Component";
import { getComponentClass } from "../../../../../engine/core/registry";
import type { AnimationFrame } from "../../stages/frame";
import { animatorsOf, clipEntry, type AnimatorRuntime } from "../instances";
import { movedByPredictedRootMotion, sessionOf } from "./ghosts";
import { rootDelta, type RootDelta } from "./rootCurve";
import { existingNetAnimator, resolveTrack, trackEnd } from "./state";

interface CharacterControllerLike extends Component {
  move(motion: { x: number; y: number; z: number }): unknown;
}

const delta: RootDelta = { x: 0, y: 0, z: 0, yaw: 0 };

function move(rt: AnimatorRuntime, d: RootDelta): void {
  const node = rt.animator.node;
  const transform = node.transform;
  if (!transform) return;
  const heading = transform.worldRotation;
  const world = Quaternion.rotate(heading, new Vector3(d.x, d.y, d.z));
  const type = rt.animator.rootMotion === "characterController" ? getComponentClass("engine.CharacterController") : undefined;
  const cc = type ? (node.getComponent(type as unknown as abstract new () => Component) as CharacterControllerLike | null) : null;
  if (cc) cc.move(world);
  else transform.worldPosition = transform.worldPosition.add(world);
  if (d.yaw !== 0) transform.worldRotation = heading.multiply(new Quaternion(0, Math.sin(d.yaw / 2), 0, Math.cos(d.yaw / 2))).normalize();
}

/** @internal Moves `frame`'s predicted characters by their slot plays' root curves for one tick. */
export function runPredictedRootMotion(frame: AnimationFrame): void {
  const session = sessionOf(frame.world);
  if (!session) return;
  // On a client, once per predicted tick: in the step's pass when prediction runs one, and in catch-up and re-simulation.
  if (session.isClient && session.replayTick === null && !session.predictedRun()?.run) return;
  const tick = session.simulatedTick;
  const dt = frame.world.time.fixedDeltaTime;
  for (const rt of animatorsOf(frame.world)) {
    const na = existingNetAnimator(rt);
    if (!na || !na.slots.size || !movedByPredictedRootMotion(rt, session)) continue;
    for (const t of na.slots.values()) {
      if (tick <= t.tick || t.loop || (t.stopTick >= 0 && tick > t.stopTick) || !resolveTrack(t, rt.animator)) continue;
      const curve = clipEntry(rt, t.clip).info;
      if (!curve?.rootCurve) continue;
      const end = trackEnd(t, rt);
      const t0 = Math.min(end, t.start + (tick - 1 - t.tick) * dt * t.speed);
      const t1 = Math.min(end, t.start + (tick - t.tick) * dt * t.speed);
      if (!(t1 > t0)) continue;
      move(rt, rootDelta(curve as { rootCurve: Float32Array; sampleRate: number }, t0, t1, delta));
    }
  }
}

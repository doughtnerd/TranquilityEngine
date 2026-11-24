/**
 * Trail sampling (ADR 0396): once a frame, after scripts' late update (and after physics interpolation has placed
 * interpolated bodies for the frame), every active `TrailRenderer` ages its points by the World's scaled time (paused
 * time freezes a trail, slow motion slows it), drops those older than `lifetime`, adds the node's world position when it
 * has moved at least `minVertexDistance` from the newest point, and keeps a live head at the node's position while
 * emitting. An engine system, so it runs in every World, headless ones included: the history is game state.
 */
import type { World } from "../../../engine/core/World";
import type { BuiltinSystem } from "../../../engine/core/systems";
import { GameObject } from "../../../engine/scene/GameObject";
import { MAX_TRAIL_POINTS, TrailRenderer } from "./TrailRenderer";

const warned = new WeakSet<TrailRenderer>();

/** Advance one trail by `dt` seconds with its node at world position `x, y, z`. Returns true when `autodestruct` says the node should go. */
export function stepTrail(trail: TrailRenderer, dt: number, x: number, y: number, z: number): boolean {
  const ages = trail._ages, points = trail._points;
  const life = Math.max(0, trail.lifetime);
  for (let i = 0; i < ages.length; i++) ages[i] = ages[i]! + dt;
  let drop = 0;
  while (drop < ages.length && ages[drop]! > life) drop++;
  if (drop > 0) {
    ages.splice(0, drop);
    points.splice(0, drop * 3);
  }
  if (ages.length === 0 && trail._hadPoints) {
    trail._hadPoints = false;
    if (trail.autodestruct) {
      trail._head = null;
      return true;
    }
  }
  if (!trail.emitting) {
    trail._head = null;
    return false;
  }
  const n = ages.length;
  const min = Math.max(0, trail.minVertexDistance);
  const far = n === 0 || Math.hypot(x - points[(n - 1) * 3]!, y - points[(n - 1) * 3 + 1]!, z - points[(n - 1) * 3 + 2]!) >= min;
  if (far && life > 0) {
    points.push(x, y, z);
    ages.push(0);
    trail._hadPoints = true;
    if (trail._trim() && !warned.has(trail)) {
      warned.add(trail);
      console.warn(`[myco] TrailRenderer on "${trail.node.name}" needs more than ${MAX_TRAIL_POINTS} points (its lifetime is ${trail.lifetime} s); the oldest are dropped. Raise minVertexDistance or lower lifetime.`);
    }
    trail._head = null; // the newest point is the head
  } else {
    trail._head = life > 0 ? [x, y, z] : null;
  }
  return false;
}

/** The `lines.Trails` engine system: every World, `lateUpdate`, after late scripts. */
export const TRAIL_SYSTEM: BuiltinSystem = {
  name: "lines.Trails",
  phase: "lateUpdate",
  after: ["engine.LateUpdateScripts"],
  run(world: World, dt: number): void {
    const doomed: GameObject[] = [];
    for (const trail of world._componentsOfType(TrailRenderer)) {
      if (!trail.isActiveAndEnabled || !trail.node.transform) continue;
      const e = trail.node.entity, m = world.worldMatrix(e), o = e * 16;
      if (stepTrail(trail, dt, m[o + 12]!, m[o + 13]!, m[o + 14]!)) doomed.push(trail.node);
    }
    for (const node of doomed) GameObject.destroy(node);
  },
};

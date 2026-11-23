// IK goals from code (ADR 0372; T40t): `Animator.ik(name)` returns a handle whose `target()` aims a goal of the rig stack
// at a node or a position. Targets are read in `animation.Gather` (`stages/gather/ik.ts`, `ik/gather.ts`).
//
// - A goal is one of the compiled graph's IK target slots, by name (the rig nodes' `target`/`pole` parameters; T30's
//   compile lists them as `ikTargets`). A name the graph doesn't have warns once when the graph is known.
// - `target(node)` follows the node's world transform every frame (from the previous propagation, ADR 0370);
//   `target(vector)` holds a world position; `target(null)` gives the goal back to the Animator's `ikTargets` binding,
//   or turns it off.
// - `weight` (default 1) is the position weight. The end bone keeps its animated rotation unless `rotation` is given
//   (or `rotationWeight`, which then turns it to a node target's own rotation); `rotationWeight` defaults to 1 when
//   `rotation` is given.
// - `hint` (a pole for an elbow or a knee) goes to the slot named `<name>Pole` when the graph has one (the pole slot a
//   two-bone IK node names); without one it is ignored, with one warning.
import { Quaternion, Vector3 } from "../../../../engine/core/math";
import { GameObject } from "../../../../engine/scene/GameObject";
import type { Animator } from "../components/Animator";
import type { AnimatorIKOptions, AnimatorIKTarget } from "../types";
import { rigState, type GoalTarget } from "./ik/state";

const unit = (v: number | undefined, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);

function point(t: GameObject | Vector3 | null | undefined): GoalTarget | null {
  if (!t) return null;
  if (t instanceof GameObject) return t;
  if (t instanceof Vector3 && Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z)) return { x: t.x, y: t.y, z: t.z };
  return null;
}

class IKHandle implements AnimatorIKTarget {
  constructor(
    private readonly animator: Animator,
    readonly name: string,
  ) {}

  target(target: GameObject | Vector3 | null, options: AnimatorIKOptions = {}): this {
    const goals = rigState(this.animator).goals;
    const t = point(target);
    if (!t) {
      goals.delete(this.name);
      return this;
    }
    const rotation = options.rotation instanceof Quaternion ? options.rotation.clone() : null;
    goals.set(this.name, {
      target: t,
      weight: unit(options.weight, 1),
      rotation,
      rotationWeight: unit(options.rotationWeight, rotation ? 1 : 0),
      hint: point(options.hint),
    });
    return this;
  }
}

/** @internal `Animator.ik`. */
export function ikTarget(animator: Animator, name: string): AnimatorIKTarget {
  return new IKHandle(animator, name);
}

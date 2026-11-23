// IK goals from code (ADR 0372; T40t): `Animator.ik(name)` returns a handle whose `target()` aims a goal of the rig stack
// at a node or a position. Targets are read in `animation.Gather` (`stages/gather/ik.ts`).
import type { Animator } from "../components/Animator";
import { notBuilt } from "../notBuilt";
import type { AnimatorIKTarget } from "../types";

/** @internal `Animator.ik`. */
export function ikTarget(_animator: Animator, _name: string): AnimatorIKTarget {
  return notBuilt("Animator.ik", "T40t");
}

// Bone reads and overrides from code (ADR 0372; T32): `Animator.bone(name)` returns a handle over this frame's local
// pose. Overrides written in `lateUpdate()` are applied before attachments follow and bones upload (the post-propagation
// hook T17 adds, through `features/bones/register.ts`).
import type { Animator } from "../components/Animator";
import { notBuilt } from "../notBuilt";
import type { AnimatorBone } from "../types";

/** @internal `Animator.bone`. */
export function bone(_animator: Animator, _name: string): AnimatorBone {
  return notBuilt("Animator.bone", "T32");
}

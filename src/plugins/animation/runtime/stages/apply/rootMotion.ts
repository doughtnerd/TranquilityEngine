// `animation.Apply` sub-step: rootMotion (T17). Root motion into the `RootMotion` buffer, then applied by `rootMotion` mode: the Transform, or (physics on) the CharacterController or kinematic RigidBody (ADR 0370, 0372).
// Called in its fixed place by `../apply.ts`; a no-op until T17.
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyRootMotion(_frame: AnimationFrame): void {}

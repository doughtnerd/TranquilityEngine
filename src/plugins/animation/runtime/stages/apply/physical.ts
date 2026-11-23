// `animation.Apply` sub-step: physical (T44). In fixed steps, with a ragdoll plugin connected (`PHYSICAL_ANIMATION`): the drive targets for this step (`physics_drive`), read by the ragdoll's systems before the physics push (ADR 0370, 0375).
// Called in its fixed place by `../apply.ts`; a no-op until T44.
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyPhysical(_frame: AnimationFrame): void {}

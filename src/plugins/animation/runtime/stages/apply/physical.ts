// `animation.Apply` sub-step: physical (T44). In fixed steps, with a ragdoll plugin connected (`PHYSICAL_ANIMATION`): the
// drive targets for this step (`physics_drive`), read by the ragdoll's systems before the physics push (ADR 0370, 0375).
// Called in its fixed place by `../apply.ts`. Every attached row of the World is written, whatever its Animator's
// update mode: a frame-mode Animator's drive source is its latest frame evaluation.
import { hasPhysicalClients, writeDrives } from "../../features/physical";
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyPhysical(frame: AnimationFrame): void {
  if (!frame.fixed || !hasPhysicalClients()) return;
  writeDrives(frame.core);
}

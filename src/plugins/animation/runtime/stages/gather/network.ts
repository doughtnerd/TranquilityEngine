// `animation.Gather` sub-step: network (T33). On clients, ghosts' replicated Animator fields (`netStates`, `netSlots`,
// `netLinks`, `netParameters`) into their graphs, first, so local commands apply on top: interpolated ghosts at the
// interpolation tick, the owner's predicted ghost by reconciling its slot plays (ADR 0370; `features/network/client.ts`).
import { applyReplicated } from "../../features/network/client";
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherNetwork(frame: AnimationFrame): void {
  applyReplicated(frame);
}

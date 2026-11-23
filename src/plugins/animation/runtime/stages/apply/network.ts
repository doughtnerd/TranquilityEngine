// `animation.Apply` sub-step: network (T33). On servers, the replicated Animator fields encoded from this pass's states,
// parameters, slot plays and link choices, before 0033's replication sends the tick's snapshot (ADR 0370;
// `features/network/server.ts`).
import { writeReplicated } from "../../features/network/server";
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyNetwork(frame: AnimationFrame): void {
  writeReplicated(frame);
}

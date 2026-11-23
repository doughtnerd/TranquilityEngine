// `animation.Apply` sub-step: ik (T40t). The grounder's ray requests for the next frame, kept in world space with the
// character frame this evaluate used (ADR 0370; `features/ik/gather.ts`). Called in its fixed place by `../apply.ts`.
import { collectRigRays } from "../../features/ik/gather";
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyIK(frame: AnimationFrame): void {
  collectRigRays(frame);
}

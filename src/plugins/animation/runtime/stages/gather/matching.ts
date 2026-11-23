// `animation.Gather` sub-step: matching (T42t). Motion matching's trajectory input: the CharacterController's velocity and the desired-velocity parameter (ADR 0372).
// Called in its fixed place by `../gather.ts`; a no-op until T42t.
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherMatching(_frame: AnimationFrame): void {}

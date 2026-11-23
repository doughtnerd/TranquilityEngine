// `animation.Gather` sub-step: ik (T40t). IK targets (code targets and `ikTargets` bindings) at their world transforms, and last frame's grounder hits, cast through the physics plugin's ray API when it is on (ADR 0370, 0372).
// Called in its fixed place by `../gather.ts`; a no-op until T40t.
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherIK(_frame: AnimationFrame): void {}

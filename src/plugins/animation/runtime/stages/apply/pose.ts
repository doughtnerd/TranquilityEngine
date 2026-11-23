// `animation.Apply` sub-step: pose (T17). The evaluated pose: bone matrices kept for skinning (uploaded at render sync, T16) and BoneAttachments (after propagation), LOD interpolation (ADR 0370).
// Called in its fixed place by `../apply.ts`; a no-op until T17.
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyPose(_frame: AnimationFrame): void {}

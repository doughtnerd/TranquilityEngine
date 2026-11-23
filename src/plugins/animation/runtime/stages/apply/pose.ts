// `animation.Apply` sub-step: pose (T17). The evaluated pose stays in the core's matrix view (model × inverse bind, D10;
// LOD interpolation is the core's): this marks each instance of the pass as evaluated and bumps its version, so
// `skinningMatrices` answers and render sync (T16) re-uploads, unless the culling mode froze the pose this frame.
// BoneAttachments read the same matrices after propagation (`features/attachments/follow.ts`).
import { animatorsOf } from "../../features/instances";
import type { AnimationFrame } from "../frame";
import { inPass } from "../gather/playback";

/** @internal */
export function applyPose(frame: AnimationFrame): void {
  for (const rt of animatorsOf(frame.world)) {
    if (!inPass(frame, rt) || rt.frozen) continue;
    rt.evaluated = true;
    rt.version++;
  }
}

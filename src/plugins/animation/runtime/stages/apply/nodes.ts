// `animation.Apply` sub-step: nodes (T45t). Third-party node faults from this evaluate, one warning per node instance
// (`features/nodes/faults.ts`). Called in its fixed place by `../apply.ts`.
import { reportNodeFaults } from "../../features/nodes/faults";
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyNodes(frame: AnimationFrame): void {
  reportNodeFaults(frame);
}

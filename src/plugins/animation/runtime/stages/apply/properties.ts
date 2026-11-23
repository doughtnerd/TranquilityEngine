// `animation.Apply` sub-step: properties (T20t). Property-track outputs scattered into their ECS columns in bulk through the
// binding table (ADR 0371; `features/properties/scatter.ts`).
import { scatterProperties } from "../../features/properties/scatter";
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyProperties(frame: AnimationFrame): void {
  scatterProperties(frame);
}

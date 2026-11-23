// `animation.Apply` sub-step: events (T20t). Notifies, last: each Animator node's behaviours get `method(e)` through the
// World's behaviour messages, and the records go to `AnimationEvents` (ADR 0372); audio and control keys are dispatched
// (`features/events/deliver.ts`).
import { deliverEvents } from "../../features/events/deliver";
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyEvents(frame: AnimationFrame): void {
  deliverEvents(frame);
}

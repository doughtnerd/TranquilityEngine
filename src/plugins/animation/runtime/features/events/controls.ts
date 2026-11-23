// `control` track keys (ADR 0371: a particle effect's play and stop, a camera cut, a nested Animator's slot play) as
// the host reads them from the core's `CONTROL` records, and the one place they are dispatched. The handlers are T22t's
// (tweens and timelines on the ECS: particles, camera cuts, nested slots); until a handler is set for an action, its
// keys are skipped with one warning per action.
import type { ControlAction } from "../../../../../engine/animation/tracks";
import type { GameObject } from "../../../../../engine/scene/GameObject";
import type { Animator } from "../../components/Animator";

/** @internal One control key crossed this frame. */
export interface AnimationControl {
  readonly animator: Animator;
  /** The Animator's node (the key's `target` is a path or name relative to it, as the handler reads it). */
  readonly node: GameObject;
  readonly action: ControlAction;
  /** The key's target string, or null. */
  readonly target: string | null;
  /** The key's payload JSON, parsed (undefined when none or unreadable). */
  readonly payload: unknown;
  /** The clip's asset reference. */
  readonly clip: string;
  /** Clip seconds: the key's time and `end - time`. */
  readonly time: number;
  readonly duration: number;
  /** The clip's weight (D29: control keys fire at any weight above 0 and carry it). */
  readonly weight: number;
}

/** @internal A control action's handler. */
export type AnimationControlHandler = (control: AnimationControl) => void;

const handlers = new Map<ControlAction, AnimationControlHandler>();
const warned = new Set<ControlAction>();

/** @internal Sets (or with null, clears) the handler of a control action (T22t). */
export function setControlHandler(action: ControlAction, handler: AnimationControlHandler | null): void {
  if (handler) handlers.set(action, handler);
  else handlers.delete(action);
}

/** @internal Dispatches one control key to its action's handler (a throw is logged). */
export function dispatchControl(control: AnimationControl): void {
  const handler = handlers.get(control.action);
  if (!handler) {
    if (!warned.has(control.action)) {
      warned.add(control.action);
      console.warn(`[myco] ${control.node.name}: the clip "${control.clip}" has "${control.action}" control keys, which don't run yet; skipped.`);
    }
    return;
  }
  try {
    handler(control);
  } catch (err) {
    console.error(`[myco] animation: the "${control.action}" control threw:`, err);
  }
}

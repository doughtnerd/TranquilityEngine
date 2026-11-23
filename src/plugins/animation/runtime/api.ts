/**
 * The animation plugin's public free functions (ADR 0372): tweens, sequences, parallel groups and the parameter view for
 * systems. Each delegates to its feature module.
 */
import type { GameObject } from "../../../engine/scene/GameObject";
import * as graph from "./features/graph";
import * as tweens from "./features/tweens";
import type { AnimatorParams, Tween, TweenField, TweenOptions, TweenTarget, TweenValue } from "./types";

/**
 * Animate one field of a Transform or component to `to` (ADR 0371, 0372):
 * `tween(this.node.transform, "position", [0, 2, 0], { duration: 0.4, ease: "outBack" })`. The tween is a one-track clip
 * evaluated in the animation core; it starts at the next animation update. Await it (or call `.then`) for its end: it
 * resolves with `finished`, `stopped`, or `destroyed` when its target goes away.
 */
export function tween<T extends TweenTarget, K extends TweenField<T>>(target: T, field: K, to: TweenValue, options: TweenOptions): Tween {
  return tweens.startTween(target, field, to, options);
}

/** Play tweens (or groups) one after another, as one small timeline: `await sequence(t1, parallel(t2, t3))`. Pass tweens before they start. */
export function sequence(...items: Tween[]): Tween {
  return tweens.sequence(items);
}

/** Play tweens (or groups) together, as one small timeline; it ends when the last one does. Pass tweens before they start. */
export function parallel(...items: Tween[]): Tween {
  return tweens.parallel(items);
}

/**
 * The parameter row of the Animator on `node`, for systems updating many Animators (crowds, ADR 0372); null when the node
 * has no Animator. Writes land in the next `animation.Gather`, as `Animator.set` does.
 */
export function animatorParams(node: GameObject): AnimatorParams | null {
  return graph.paramsOf(node);
}

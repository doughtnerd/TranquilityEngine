// Code-first playback (ADR 0372; T17): `Animator.play` on a layer of the implicit graph or in a graph slot, `crossfade`,
// `stop`, `layerWeight`, `state` and `onFinished`. Plays become commands the stages hand to the core; their promises
// resolve from the core's play records in `animation.Apply` (`stages/apply/playback.ts`). Slot plays with sections are
// T32's (`graph.ts` owns the graph side); T17 builds the rest.
import type { Animator } from "../components/Animator";
import { notBuilt } from "../notBuilt";
import type { AnimationPlayResult, AnimatorCrossfadeOptions, AnimatorLayer, AnimatorPlayOptions, AnimatorStateInfo, AnimatorStopOptions } from "../types";

/** @internal `Animator.play`. */
export function play(_animator: Animator, _clip: string, _options: AnimatorPlayOptions): Promise<AnimationPlayResult> {
  return notBuilt("Animator.play", "T17");
}

/** @internal `Animator.crossfade`. */
export function crossfade(_animator: Animator, _clip: string, _duration: number, _options: AnimatorCrossfadeOptions): Promise<AnimationPlayResult> {
  return notBuilt("Animator.crossfade", "T17");
}

/** @internal `Animator.stop`. */
export function stop(_animator: Animator, _options: AnimatorStopOptions): void {
  notBuilt("Animator.stop", "T17");
}

/** @internal `Animator.layerWeight`. */
export function setLayerWeight(_animator: Animator, _layer: AnimatorLayer, _weight: number): void {
  notBuilt("Animator.layerWeight", "T17");
}

/** @internal `Animator.state`. */
export function stateOf(_animator: Animator, _layer: AnimatorLayer): AnimatorStateInfo {
  return notBuilt("Animator.state", "T17");
}

/** @internal `Animator.onFinished`. */
export function finished(_animator: Animator): Promise<AnimationPlayResult> {
  return notBuilt("Animator.onFinished", "T17");
}

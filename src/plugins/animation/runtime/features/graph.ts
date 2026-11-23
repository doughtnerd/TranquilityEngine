// The Animator graph API (ADR 0372; T32): parameters (`set`, `animatorParams`), requests, `travel`, `jump`, linked
// graphs and computed parameters. Everything is a command into the blackboard or the graph's command queue; the
// graph itself runs in the core. Computed parameters run in `animation.Gather` (`stages/gather/computed.ts`).
import type { GameObject } from "../../../../engine/scene/GameObject";
import type { Animator } from "../components/Animator";
import { notBuilt } from "../notBuilt";
import type { AnimatorJumpOptions, AnimatorParameterValue, AnimatorParams, AnimatorRequestOptions, AnimatorTravelOptions } from "../types";

/** @internal `Animator.set`. */
export function setParameter(_animator: Animator, _name: string, _value: AnimatorParameterValue): void {
  notBuilt("Animator.set", "T32");
}

/** @internal `Animator.request`. */
export function request(_animator: Animator, _name: string, _options: AnimatorRequestOptions): void {
  notBuilt("Animator.request", "T32");
}

/** @internal `Animator.travel`. */
export function travel(_animator: Animator, _state: string, _options: AnimatorTravelOptions): void {
  notBuilt("Animator.travel", "T32");
}

/** @internal `Animator.jump`. */
export function jump(_animator: Animator, _state: string, _options: AnimatorJumpOptions): void {
  notBuilt("Animator.jump", "T32");
}

/** @internal `Animator.link`. */
export function link(_animator: Animator, _node: string, _graph: string | null): void {
  notBuilt("Animator.link", "T32");
}

/** @internal `Animator.compute`. */
export function compute(_animator: Animator, _name: string, _fn: (() => AnimatorParameterValue) | null): void {
  notBuilt("Animator.compute", "T32");
}

/** @internal `animatorParams(node)`. */
export function paramsOf(_node: GameObject): AnimatorParams | null {
  return notBuilt("animatorParams", "T32");
}

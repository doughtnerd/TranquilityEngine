// The Animator graph API (ADR 0372; T32): parameters (`set`, `animatorParams`), requests, `travel`, `jump`, linked
// graphs and computed parameters. Everything is a command into the blackboard or the graph's command queue, applied in
// `animation.Gather` (`graph/runtime.ts`, which also runs computed parameters there); the graph itself runs in the
// core. Slot plays, `stop`, `layerWeight` and `state` on graph Animators come through `playback.ts` into the same
// runtime. A request or travel with `at` (musical timing, T72) is held by `music.ts` until its music boundary, then
// queued and sent in that frame (its open window, `within`, counts from then).
import type { GameObject } from "../../../../engine/scene/GameObject";
import { Animator } from "../components/Animator";
import type { AnimatorJumpOptions, AnimatorParameterValue, AnimatorParams, AnimatorRequestOptions, AnimatorTravelOptions, AnimatorTravelResult } from "../types";
import { flushGraphQueue, parameterIndex, queueJump, queueLink, queueRequest, queueTravel, setCompute, setParameter as setParam } from "./graph/runtime";
import { animatorRuntime } from "./instances";
import { holdRequest, holdTravel, wantsMusic } from "./music";

/** Requests live this long without `within` (ADR 0372, D52). */
const DEFAULT_WITHIN = 0.25;

/** Whether a request or travel waits for music: only on an Animator that could take it now (else it is refused at once, as without `at`). */
function waits(animator: Animator, what: string, options: AnimatorRequestOptions | AnimatorTravelOptions): boolean {
  return !!animator.graph && !!animatorRuntime(animator) && wantsMusic(animator, what, options);
}

/** @internal `Animator.set`. */
export function setParameter(animator: Animator, name: string, value: AnimatorParameterValue): void {
  setParam(animator, name, value);
}

/** @internal `Animator.request`. */
export function request(animator: Animator, name: string, options: AnimatorRequestOptions): void {
  const within = typeof options.within === "number" && Number.isFinite(options.within) && options.within > 0 ? options.within : DEFAULT_WITHIN;
  if (waits(animator, "request", options)) holdRequest(animator, options, () => queueRequest(animator, name, within), flushGraphQueue);
  else queueRequest(animator, name, within);
}

/** @internal `Animator.travel`. */
export function travel(animator: Animator, state: string, options: AnimatorTravelOptions): Promise<AnimatorTravelResult> {
  if (waits(animator, "travel", options)) return holdTravel(animator, options, () => queueTravel(animator, state, options.layer), flushGraphQueue);
  return queueTravel(animator, state, options.layer);
}

/** @internal `Animator.jump`. */
export function jump(animator: Animator, state: string, options: AnimatorJumpOptions): void {
  queueJump(animator, state, options.layer);
}

/** @internal `Animator.link`. */
export function link(animator: Animator, node: string, graph: string | null): void {
  queueLink(animator, node, graph);
}

/** @internal `Animator.compute`. */
export function compute(animator: Animator, name: string, fn: (() => AnimatorParameterValue) | null): void {
  setCompute(animator, name, fn);
}

const views = new WeakMap<Animator, AnimatorParams>();

/** @internal `animatorParams(node)`: a view per Animator (null when the node has none). */
export function paramsOf(node: GameObject): AnimatorParams | null {
  const animator = node.getComponent(Animator);
  if (!animator) return null;
  let v = views.get(animator);
  if (!v) {
    v = {
      indexOf: (name: string) => parameterIndex(animator, name),
      set: (parameter: string | number, value: AnimatorParameterValue) => setParam(animator, parameter, value),
    };
    views.set(animator, v);
  }
  return v;
}

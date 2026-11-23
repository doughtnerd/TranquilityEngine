// What every stage and sub-step gets (ADR 0370's frame order): the World, the step's time and whether it is a fixed step.
// `frameFor` decides whether a World animates at all; T13t makes it return a frame once the World's animation core has
// loaded (lazily, the first time the World has an Animator, a tween or a timeline). Until then no World animates, so the
// stages cost one call per frame.
import type { World } from "../../../../engine/core/World";

/** @internal One stage run's context. */
export interface AnimationFrame {
  readonly world: World;
  /** Seconds: the frame's scaled `deltaTime`, or `fixedDeltaTime` in a fixed step. Unscaled Animators read the World's clock. */
  readonly dt: number;
  /** True in `animation.FixedEvaluate` and `animation.PredictedRootMotion`: only `updateMode: "fixed"` Animators take part. */
  readonly fixed: boolean;
}

/** @internal One feature's part of a stage (`gather/<feature>.ts`, `apply/<feature>.ts`). */
export type StageStep = (frame: AnimationFrame) => void;

/** @internal The frame for `world`, or null when it has nothing to animate (T13t: null until its core has loaded). */
export function frameFor(_world: World, _dt: number, _fixed: boolean): AnimationFrame | null {
  return null;
}

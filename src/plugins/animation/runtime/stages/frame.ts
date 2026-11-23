// What every stage and sub-step gets (ADR 0370's frame order): the World, its namespace in the animation core, the step's
// time and whether it is a fixed step. `frameFor` decides whether a World animates at all: it answers a frame once the
// World's core has loaded (lazily, the first time the World has an Animator, a tween or a timeline: `core/service.ts`),
// and null before, without `simd128`, and after teardown. So the stages cost one call per frame until then.
import type { World } from "../../../../engine/core/World";
import type { AnimationWorldCore } from "../core/AnimationWorldCore";
import { animationCoreOf } from "../core/service";

/** @internal One stage run's context (one object per World, reused: valid only during the stage run it was made for). */
export interface AnimationFrame {
  readonly world: World;
  /** The World's namespace in the page's core: its World id, instances, asset references, command writer and `evaluate`. */
  readonly core: AnimationWorldCore;
  /** Seconds: the frame's scaled `deltaTime`, or `fixedDeltaTime` in a fixed step. */
  readonly dt: number;
  /** Seconds: the frame's `unscaledDeltaTime` (for `updateMode: "unscaled"` Animators), or `fixedDeltaTime` in a fixed step. */
  readonly unscaledDt: number;
  /** True in `animation.FixedEvaluate` and `animation.PredictedRootMotion`: only `updateMode: "fixed"` Animators take part. */
  readonly fixed: boolean;
  /** The core's `evaluate` pass for this frame: `PASS_FIXED` when `fixed`, else `PASS_NORMAL`. */
  readonly pass: number;
}

/** @internal One feature's part of a stage (`gather/<feature>.ts`, `apply/<feature>.ts`). */
export type StageStep = (frame: AnimationFrame) => void;

/** @internal The frame for `world`, or null when it has nothing to animate (its core hasn't loaded, or can't). */
export function frameFor(world: World, dt: number, fixed: boolean): AnimationFrame | null {
  return animationCoreOf(world)?.frameFor(dt, fixed) ?? null;
}

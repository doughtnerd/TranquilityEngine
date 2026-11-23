// Tweens, sequences and parallel groups (ADR 0371, 0372; T22t). A tween is a one-track clip in the core's tween table;
// the target's entity gets the `animation.Tweens` data component while it has tweens. Sequences and parallel groups
// compile to a small timeline. Starts and completions run in the stages (`stages/gather/tweens.ts`,
// `stages/apply/tweens.ts`).
import { notBuilt } from "../notBuilt";
import type { Tween, TweenOptions, TweenTarget, TweenValue } from "../types";

/** @internal `tween()`. */
export function startTween(_target: TweenTarget, _field: string, _to: TweenValue, _options: TweenOptions): Tween {
  return notBuilt("tween", "T22t");
}

/** @internal `sequence()`. */
export function sequence(_items: readonly Tween[]): Tween {
  return notBuilt("sequence", "T22t");
}

/** @internal `parallel()`. */
export function parallel(_items: readonly Tween[]): Tween {
  return notBuilt("parallel", "T22t");
}

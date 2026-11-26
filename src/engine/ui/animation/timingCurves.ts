/**
 * CSS timing functions as engine curves (ADR 0418 wave 4, 0420): what UI transitions and keyframe segments ease
 * through on the tween backend. A `cubic-bezier()` (and `ease`, `ease-in`, `ease-out`, `ease-in-out`) is exactly one
 * Bézier segment of an engine curve (0346): key (0, 0) with its `out` handle at (x1, y1), key (1, 1) with its `in`
 * handle at (x2, y2), and the curve evaluator's bisection finds the parameter as a CSS engine does. `steps()` is step
 * keys, and `linear()` (ADR 0428) linear keys at its points. `linear` needs no curve (the tween's linear easing).
 *
 * A reversed curve is what a segment traversed backwards (`animation-direction: reverse`, an alternate iteration)
 * eases through from its later keyframe to its earlier one: `1 − f(1 − x)`. Pure.
 */
import type { Curve, CurveKey } from "../../core/curve";
import type { UITimingFunction } from "../document/animationValues";

/** The value of `steps(n, position)` on each of its `n` intervals (the last one reaches 1 at x = 1). */
function stepLevels(steps: number, position: "jump-start" | "jump-end" | "jump-none" | "jump-both"): number[] {
  const levels: number[] = [];
  for (let k = 0; k < steps; k++) {
    switch (position) {
      case "jump-start":
        levels.push((k + 1) / steps);
        break;
      case "jump-end":
        levels.push(k / steps);
        break;
      case "jump-none":
        levels.push(k / (steps - 1));
        break;
      case "jump-both":
        levels.push((k + 1) / (steps + 1));
        break;
    }
  }
  return levels;
}

/**
 * The engine curve of a timing function, over 0–1 (`reversed`: `1 − f(1 − x)`), or null for `linear` (in either
 * direction), which the tween's own linear easing runs.
 */
export function timingCurve(tf: UITimingFunction, reversed = false): Curve | null {
  if (tf.kind === "linear") return null;
  if (tf.kind === "bezier") {
    const b = reversed ? { x1: 1 - tf.x2, y1: 1 - tf.y2, x2: 1 - tf.x1, y2: 1 - tf.y1 } : tf;
    if (b.x1 === b.y1 && b.x2 === b.y2) return null; // a straight line: linear
    return [
      [0, 0, "bezier", { in: [0, 0], out: [b.x1, b.y1] }],
      [1, 1, "bezier", { in: [b.x2 - 1, b.y2 - 1], out: [0, 0] }],
    ];
  }
  if (tf.kind === "points") {
    // ADR 0428: `linear()` is its points as linear keys (a repeated input is a jump: the evaluator takes the last key
    // at an input). Reversed: each point mirrored, `(1 − x, 1 − y)`, in reverse order.
    const points = reversed ? tf.points.map(([x, y]) => [1 - x, 1 - y] as const).reverse() : tf.points;
    if (points.length === 2 && points[0][0] === 0 && points[0][1] === 0 && points[1][0] === 1 && points[1][1] === 1) return null;
    const keys: CurveKey[] = points.map(([x, y]) => [x, y]);
    // Before its first input and after its last, CSS extends the first and last segments' lines (CSS Easing 2); the
    // curve gets keys at 0 and 1 on them.
    const line = (p: readonly [number, number], q: readonly [number, number], x: number) => (q[0] === p[0] ? q[1] : p[1] + ((x - p[0]) * (q[1] - p[1])) / (q[0] - p[0]));
    const n = points.length;
    if (points[0][0] > 0) keys.unshift([0, line(points[0], points[1], 0)]);
    if (points[n - 1][0] < 1) keys.push([1, line(points[n - 2], points[n - 1], 1)]);
    return keys;
  }
  const n = tf.steps;
  const levels = stepLevels(n, tf.position);
  const keys: CurveKey[] = [];
  if (!reversed) {
    for (let k = 0; k < n; k++) keys.push([k / n, levels[k], "step"]);
  } else {
    // 1 − f(1 − x): exactly 0 at the start (the later keyframe's value), then each interval's level mirrored.
    keys.push([0, 0, "step"]);
    for (let j = 0; j < n; j++) keys.push([j / n, 1 - levels[n - 1 - j], "step"]);
  }
  keys.push([1, 1]);
  return keys;
}

/** A key naming a timing function and direction, for caching one loaded curve per distinct function. */
export function timingKey(tf: UITimingFunction, reversed: boolean): string {
  const dir = reversed ? "r" : "f";
  switch (tf.kind) {
    case "linear":
      return "linear";
    case "bezier":
      return `b${dir}:${tf.x1},${tf.y1},${tf.x2},${tf.y2}`;
    case "steps":
      return `s${dir}:${tf.steps},${tf.position}`;
    case "points":
      return `p${dir}:${tf.points.map((p) => p.join(" ")).join(",")}`;
  }
}

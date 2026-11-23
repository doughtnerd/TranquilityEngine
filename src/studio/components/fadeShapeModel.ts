// ADR 0350: the fade shape picker's model: the shapes in menu order with their names, the glyph a shape draws (an SVG
// path of its fade in or out, from the engine's one shape function), and the weight-curve presets that match the shapes
// (2D blend entries and 1D overrides, so a user rarely needs the full curve editor). Pure.
import type { Curve, CurveKey } from "../../engine/core/curve";
import { fadeInLevel, fadeOutLevel } from "../../engine/audio/playlist/fadeShapes";
import { FADE_SHAPES, type FadeShape } from "../../engine/audio/playlist/types";

const NAMES: Record<FadeShape, string> = {
  linear: "Linear",
  equalPower: "Equal power",
  sCurve: "S-curve",
  invSCurve: "Inverse S-curve",
  log1: "Fast (log, gentle)",
  log2: "Fast (log)",
  log3: "Fast (log, steep)",
  exp1: "Slow (exp, gentle)",
  exp2: "Slow (exp)",
  exp3: "Slow (exp, steep)",
};

/** The shapes as select options, in the engine's order. */
export const FADE_SHAPE_OPTIONS: readonly { readonly value: FadeShape; readonly label: string }[] = FADE_SHAPES.map((value) => ({ value, label: NAMES[value] }));

/** A shape's display name. */
export const fadeShapeName = (s: FadeShape): string => NAMES[s];

/** The glyph of a fade in (or out) of `shape` in a `w` × `h` box (y down), as SVG path data, `n` segments. */
export function fadeShapePath(shape: FadeShape, out: boolean, w = 24, h = 12, n = 16): string {
  const pts: string[] = [];
  for (let k = 0; k <= n; k++) {
    const u = k / n;
    const level = out ? fadeOutLevel(shape, u) : fadeInLevel(shape, u);
    pts.push(`${k === 0 ? "M" : "L"}${(u * w).toFixed(2)} ${((1 - level) * h).toFixed(2)}`);
  }
  return pts.join(" ");
}

/**
 * A weight curve (raw weight in, gain out) that follows `shape` as a fade in, sampled at 9 keys (exact at the ends), for
 * the weight-curve presets. `linear` is the identity (the default behaviour with a linear blend).
 */
export function weightCurvePreset(shape: FadeShape): Curve {
  if (shape === "linear") return [[0, 0], [1, 1]];
  const keys: CurveKey[] = [];
  for (let k = 0; k <= 8; k++) {
    const u = k / 8;
    keys.push([u, Number(fadeInLevel(shape, u).toFixed(4))]);
  }
  return keys;
}

/** Narrows the overlap: 0 until the raw weight reaches `from`, then linear to 1 (the 2D counterpart of a fade width). */
export const narrowWeightCurve = (from: number): Curve => [[0, 0], [Math.min(0.95, Math.max(0, from)), 0], [1, 1]];

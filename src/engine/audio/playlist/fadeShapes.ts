/**
 * Fade shapes (ADR 0350): the level of a fade in or out at phase `u` (0..1 through the fade), for every `FadeShape`, and
 * how a fade of one shape is played as stamped voice fades.
 *
 * - **Levels.** A fade in goes 0 → 1 as `shapeLevel(shape, u)`; a fade out goes 1 → 0 as `1 − shapeLevel(shape, u)`,
 *   except `equalPower`, which is sin(uπ/2) in and cos(uπ/2) out (so an equal-power crossfade keeps its power). The
 *   others are the fraction of the change done at `u`: `linear` u; `sCurve` u²(3 − 2u); `invSCurve` 2u − u²(3 − 2u);
 *   `logN` 1 − (1 − u)^p and `expN` u^p with p = 1.41, 2, 3 (Wwise's bases: log changes fast at first, exp slowly).
 * - **Playing them.** The audio core runs four laws (`linear`, `sCurve`, `equalPowerIn`, `equalPowerOut`; the FADE
 *   record's `shape` word). `linear`, `sCurve` and `equalPower` are one record each; every other shape is
 *   `SHAPE_SEGMENTS` stamped linear records in a row (each takes over from where the last one is, ADR 0166's class G
 *   rule), so the knots fall on the exact law and the error between them is the chord's.
 *
 * Pure; no plugin, no DOM.
 */
import { FADE_SHAPES, type FadeShape } from "./types";

/** The core fade laws a shape can run on directly (the wire's `fade_law`). */
export type CoreFadeLaw = "linear" | "sCurve" | "equalPowerIn" | "equalPowerOut";

/** Linear pieces a shape with no core law is played as. Even, so the fade's middle is a knot. */
export const SHAPE_SEGMENTS = 12;

const POWERS: Record<string, number> = { "1": 1.41, "2": 2, "3": 3 };

const clamp01 = (u: number): number => (u > 0 ? (u < 1 ? u : 1) : 0);
const smooth = (u: number): number => u * u * (3 - 2 * u);

/** True for one of the shape names. */
export const isFadeShape = (v: unknown): v is FadeShape => typeof v === "string" && (FADE_SHAPES as readonly string[]).includes(v);

/** The fraction of the change a fade of `shape` has made at phase `u` (0..1); `equalPower` reads as a fade in (sin). */
export function shapeLevel(shape: FadeShape, u: number): number {
  const t = clamp01(u);
  switch (shape) {
    case "linear": return t;
    case "equalPower": return Math.sin((t * Math.PI) / 2);
    case "sCurve": return smooth(t);
    case "invSCurve": return 2 * t - smooth(t);
    default: {
      const p = POWERS[shape.slice(3)] ?? 2;
      return shape.startsWith("log") ? 1 - Math.pow(1 - t, p) : Math.pow(t, p);
    }
  }
}

/** The level of a fade in (0 → 1) of `shape` at phase `u`. */
export const fadeInLevel = (shape: FadeShape, u: number): number => shapeLevel(shape, u);

/** The level of a fade out (1 → 0) of `shape` at phase `u`. */
export function fadeOutLevel(shape: FadeShape, u: number): number {
  return shape === "equalPower" ? Math.cos((clamp01(u) * Math.PI) / 2) : 1 - shapeLevel(shape, u);
}

/** The core law a fade of `shape` runs on in one record (`out`: a fade out), or null when it needs segments. */
export function coreLawOf(shape: FadeShape, out: boolean): CoreFadeLaw | null {
  if (shape === "linear" || shape === "sCurve") return shape;
  if (shape === "equalPower") return out ? "equalPowerOut" : "equalPowerIn";
  return null;
}

/** One stamped piece of a fade: from `at` seconds after the fade starts, ramp to `to` over `seconds` with `law`. */
export interface FadePiece { at: number; seconds: number; to: number; law: CoreFadeLaw }

/**
 * The pieces a fade of `shape` over `seconds` is played as, from level `from` to level `to` (a fade in or out: `to` <
 * `from` is out). One piece when the core has the law; else `SHAPE_SEGMENTS` linear pieces on the shape's knots.
 */
export function fadePieces(shape: FadeShape, seconds: number, from: number, to: number): FadePiece[] {
  const out = to < from;
  const law = coreLawOf(shape, out);
  if (law || !(seconds > 0)) return [{ at: 0, seconds: Math.max(0, seconds), to, law: law ?? "linear" }];
  const pieces: FadePiece[] = [];
  const dt = seconds / SHAPE_SEGMENTS;
  for (let k = 1; k <= SHAPE_SEGMENTS; k++) {
    const u = k / SHAPE_SEGMENTS;
    const level = out ? fadeOutLevel(shape, u) : fadeInLevel(shape, u);
    pieces.push({ at: (k - 1) * dt, seconds: dt, to: k === SHAPE_SEGMENTS ? to : from + (to - from) * (out ? 1 - level : level), law: "linear" });
  }
  return pieces;
}

// Slicing an engine curve (ADR 0158 §3, 0332) by its x: a key moved along x, and the part of a curve over a range
// moved to start at 0 with keys at both cuts holding the curve's value there (so a split clip's halves sound the same
// as the whole). Generic: any curve keyed on time. Pure.
import { evalCurve, type Curve, type CurveKey } from "../../../../engine/core/curve";

const tidy = (t: number): number => Math.round(t * 1e6) / 1e6;

/** The part of `curve` over `[from, to]`, moved to start at 0, with keys at both cuts holding the curve's value there. */
export function cutCurve(curve: Curve, from: number, to: number): CurveKey[] {
  const inside = curve.filter((k) => k[0] > from + 1e-9 && k[0] < to - 1e-9).map((k) => shiftKey(k, -from));
  const startKey: CurveKey = [0, evalCurve(curve, from)];
  const endKey: CurveKey = [tidy(to - from), evalCurve(curve, to)];
  const hasAt = (x: number) => curve.some((k) => Math.abs(k[0] - x) < 1e-9);
  const first = hasAt(from) ? shiftKey(curve.find((k) => Math.abs(k[0] - from) < 1e-9)!, -from) : startKey;
  const last = hasAt(to) ? shiftKey(curve.find((k) => Math.abs(k[0] - to) < 1e-9)!, -from) : endKey;
  return [first, ...inside, last];
}

/** A key moved by `dx` along x, keeping its shape and handles. */
export function shiftKey(k: CurveKey, dx: number): CurveKey {
  const x = tidy(k[0] + dx);
  return k.length === 2 ? [x, k[1]] : k[2] === "bezier" ? [x, k[1], "bezier", (k as readonly [number, number, "bezier", never])[3]] : [x, k[1], k[2]];
}

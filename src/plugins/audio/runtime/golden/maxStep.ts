// The discontinuity detector (F-40; 0171/0172 M5 task DS0 extracted it from `audioGolden.test.ts` so the M5 goldens and
// later DSd share it): the largest absolute difference between neighbouring samples. A click or a zipper shows as a step
// larger than the signal's own largest step plus the ramp's; each user states its bound.

/** The largest `|x[i] − x[i − 1]|` for `from < i < to` (the whole array by default). */
export function maxStep(x: Float32Array, from = 0, to = x.length): number {
  let m = 0;
  for (let i = from + 1; i < to; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
  return m;
}

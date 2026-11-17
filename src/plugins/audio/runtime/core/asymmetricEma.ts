// An exponential moving average that rises and falls at different rates (ADR 0223: moved out of `musicOps.ts`, whose
// prime-latency estimate Ê is one: architecture §4.2). A pure step function; the caller keeps the average.

/**
 * One step: `average` moved toward `sample` by `gainUp` when the sample is above it, by `gainDown` otherwise, never
 * below 0. A sample that isn't a finite number leaves the average as it was.
 */
export function asymmetricEmaStep(average: number, sample: number, gainUp: number, gainDown: number): number {
  if (!Number.isFinite(sample)) return average;
  const gain = sample > average ? gainUp : gainDown;
  return Math.max(0, average + gain * (sample - average));
}

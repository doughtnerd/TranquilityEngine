// L-Cp2a fills these (api-and-models §10, the `CpuMeter` row; architecture §4.3). Every case drives the meter with a
// fake `Date.now` through a small shell model, never a wall clock.
import { describe, it } from "vitest";

describe("CpuMeter (fake Date.now)", () => {
  it.skip("null before the first 96-quantum window; then the figure", () => {});
  it.skip("a 96-quantum window at a 1 ms step: 1000 x busy / (quanta x quantum ms)", () => {});
  it.skip("a 2 ms step uses a 384-quantum window and reports windowMs 1 s at 48 kHz", () => {});
  it.skip("a 6 to 48 cadence switch changes the samples a window spans, not the figure", () => {});
  it.skip("a skipped post leaves the figure unbiased", () => {});
  it.skip("a backwards clock step is clamped by the shell model and counted in clockSteps", () => {});
  it.skip("a step above 2 ms hides the figure with 'clock too coarse (n ms)'", () => {});
  it.skip("no step after 1 s of quanta hides the figure", () => {});
  it.skip("the live refit follows the work-unit constants and reports sections and refitResidual", () => {});
  it.skip("an epoch restart (counters back to 0) never yields a negative delta and restarts the window", () => {});
});

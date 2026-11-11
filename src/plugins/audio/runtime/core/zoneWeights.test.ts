// ADR 0162 C5 / L-C5a: zone volumes, weights, normalisation, the send curve, the wet factor and the send (§1.5, §3.2,
// §4.4, S21; architecture §3.3).
import { describe, it } from "vitest";

describe("zone volumes", () => {
  it.skip("an identity box: 0 inside and on the surface, the distance to the nearest face or edge outside", () => {});
  it.skip("a rotated, scaled, offset box: centre and half extents in world units", () => {});
  it.skip("a sphere: radius times the largest scale axis", () => {});
  it.skip("negative sizes and zero-length columns", () => {});
});

describe("zone weights", () => {
  it.skip("1 inside, linear to 0 over blendDistance, 0 beyond", () => {});
  it.skip("blendDistance 0 is a hard edge", () => {});
  it.skip("overlaps normalise only above a total of 1; the total is min(1, norm)", () => {});
});

describe("sends", () => {
  it.skip("the send curve's x and gain against distance", () => {});
  it.skip("the wet factor", () => {});
  it.skip("the send, clamped to 4 in the product with the curve; bad inputs give 0", () => {});
});
